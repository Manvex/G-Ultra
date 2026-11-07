using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace GUltra
{
    // Processor settings through the Windows power plan, so every change can be undone.
    // Nothing here writes voltages or multipliers to the processor. The first change saves what
    // the user had, and Balanced (or uninstalling) puts exactly that back.
    static class CpuTuning
    {
        static readonly Guid ThrottleMax = new Guid("bc5038f7-23e0-4960-96da-33abaf5935ec");
        static readonly Guid ThrottleMin = new Guid("893dee8e-2bef-41e0-89c6-b55d0929964c");
        static readonly Guid Boost = new Guid("be337238-0d82-4146-a960-4f3749d470c7");
        static readonly Guid Cooling = new Guid("94d3a615-a899-4ac5-ae2b-e4d8f634367f");

        const uint BoostOff = 0, BoostAggressive = 2;
        const uint CoolingPassive = 0, CoolingActive = 1;

        static readonly object Gate = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static readonly string StatePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "G Ultra", "cpu-tuning.json");

        // ---- saved state ----
        static Dictionary<string, object> Load()
        {
            try { return File.Exists(StatePath) ? Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(StatePath)) : null; }
            catch { return null; }
        }

        static void Save(Dictionary<string, object> state)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StatePath));
            File.WriteAllText(StatePath, Json.Serialize(state));
        }

        static void Remember(Dictionary<string, object> state, string name, Guid scheme, Guid setting)
        {
            uint ac, dc;
            if (!BatteryService.ReadProcessor(scheme, setting, out ac, out dc)) return;
            state[name + "Ac"] = (long)ac;
            state[name + "Dc"] = (long)dc;
        }

        static Dictionary<string, object> Capture(Guid scheme)
        {
            var state = new Dictionary<string, object> { { "mode", "balanced" }, { "scheme", scheme.ToString() }, { "overlay", BatteryService.GetPowerMode() } };
            Remember(state, "max", scheme, ThrottleMax);
            Remember(state, "min", scheme, ThrottleMin);
            Remember(state, "boost", scheme, Boost);
            Remember(state, "cooling", scheme, Cooling);
            return state;
        }

        static void WriteSaved(Dictionary<string, object> state, string name, Guid scheme, Guid setting)
        {
            object ac, dc;
            if (state.TryGetValue(name + "Ac", out ac) && state.TryGetValue(name + "Dc", out dc))
                BatteryService.WriteProcessor(scheme, setting, Convert.ToUInt32(ac), Convert.ToUInt32(dc));
        }

        static void WriteOriginals(Dictionary<string, object> state)
        {
            Guid scheme = new Guid((string)state["scheme"]);
            WriteSaved(state, "max", scheme, ThrottleMax);
            WriteSaved(state, "min", scheme, ThrottleMin);
            WriteSaved(state, "boost", scheme, Boost);
            WriteSaved(state, "cooling", scheme, Cooling);
            string overlay = state.ContainsKey("overlay") ? state["overlay"] as string : null;
            if (overlay != null) BatteryService.SetPowerMode(overlay);
            BatteryService.ActivatePlan();
        }

        // Starts from what the user had, on whichever power plan is active now.
        static Dictionary<string, object> Prepare(Guid scheme)
        {
            Dictionary<string, object> state = Load();
            if (state != null && !string.Equals(state["scheme"] as string, scheme.ToString(), StringComparison.OrdinalIgnoreCase))
            {
                WriteOriginals(state);
                state = null;
            }
            return state ?? Capture(scheme);
        }

        // ---- modes ----
        public static object SetMode(string mode)
        {
            if (mode != "cool" && mode != "balanced" && mode != "performance") throw new Exception("Unknown mode.");
            // A temperature rule may be holding its own limit, which must not get saved as the user's.
            // Outside the lock: the monitor takes its own lock first and then this one.
            Monitor.ReleaseCpuLimit();
            lock (Gate)
            {
                if (mode == "balanced")
                {
                    Restore();
                    return Info();
                }

                Guid scheme = BatteryService.ActivePlan();
                Dictionary<string, object> state = Prepare(scheme);
                try
                {
                    WriteOriginals(state);
                    if (mode == "cool")
                    {
                        WriteCool(scheme);
                    }
                    else
                    {
                        BatteryService.WriteProcessor(scheme, Boost, BoostAggressive, BoostAggressive);
                        BatteryService.WriteProcessor(scheme, ThrottleMax, 100, 100);
                        // Full speed held on mains only, because on battery it would just drain it.
                        uint minAc, minDc;
                        if (BatteryService.ReadProcessor(scheme, ThrottleMin, out minAc, out minDc))
                            BatteryService.WriteProcessor(scheme, ThrottleMin, 100, minDc);
                        BatteryService.WriteProcessor(scheme, Cooling, CoolingActive, CoolingActive);
                        BatteryService.SetPowerMode("performance");
                    }
                    BatteryService.ActivatePlan();
                }
                catch
                {
                    try { WriteOriginals(state); } catch { }
                    throw;
                }
                // The user's choice now counts, so the temperature rule has nothing to go back to.
                state.Remove("ruleSnapshot");
                state.Remove("ruleMode");
                state["mode"] = mode;
                Save(state);
                return Info();
            }
        }

        static void WriteCool(Guid scheme)
        {
            BatteryService.WriteProcessor(scheme, Boost, BoostOff, BoostOff);
            BatteryService.WriteProcessor(scheme, ThrottleMax, 90, 80);
            BatteryService.WriteProcessor(scheme, Cooling, CoolingActive, CoolingActive);
            BatteryService.SetPowerMode("efficiency");
        }

        // ---- the Monitor's temperature rule: Cool mode until the processor cools down ----
        public static bool RuleCoolActive()
        {
            lock (Gate)
            {
                Dictionary<string, object> state = Load();
                return state != null && state.ContainsKey("ruleSnapshot");
            }
        }

        public static void RuleCool(bool on)
        {
            lock (Gate)
            {
                if (on)
                {
                    Guid scheme = BatteryService.ActivePlan();
                    Dictionary<string, object> state = Prepare(scheme);
                    if (state.ContainsKey("ruleSnapshot")) return;
                    // What's set right now, which may be the user's own settings rather than the originals.
                    state["ruleSnapshot"] = Capture(scheme);
                    state["ruleMode"] = state.ContainsKey("mode") ? state["mode"] : "balanced";
                    WriteSaved(state, "min", scheme, ThrottleMin);
                    WriteCool(scheme);
                    BatteryService.ActivatePlan();
                    state["mode"] = "cool";
                    Save(state);
                }
                else
                {
                    Dictionary<string, object> state = Load();
                    if (state == null || !state.ContainsKey("ruleSnapshot")) return;
                    var snapshot = state["ruleSnapshot"] as Dictionary<string, object>;
                    string before = state.ContainsKey("ruleMode") ? state["ruleMode"] as string : "balanced";
                    state.Remove("ruleSnapshot");
                    state.Remove("ruleMode");
                    if (snapshot != null) WriteOriginals(snapshot);
                    if (before == "balanced")
                    {
                        File.Delete(StatePath);
                        return;
                    }
                    state["mode"] = before ?? "custom";
                    Save(state);
                }
            }
        }

        public static object Set(string key, double value)
        {
            Monitor.ReleaseCpuLimit();
            lock (Gate)
            {
                Guid scheme = BatteryService.ActivePlan();
                Dictionary<string, object> state = Prepare(scheme);
                uint ac, dc;
                switch (key)
                {
                    case "boost":
                        object saved;
                        uint on = state.TryGetValue("boostAc", out saved) && Convert.ToUInt32(saved) != BoostOff ? Convert.ToUInt32(saved) : BoostAggressive;
                        BatteryService.WriteProcessor(scheme, Boost, value != 0 ? on : BoostOff, value != 0 ? on : BoostOff);
                        break;
                    case "maxAc":
                    case "maxDc":
                        if (!BatteryService.ReadProcessor(scheme, ThrottleMax, out ac, out dc)) throw new Exception("Couldn't read the processor limit.");
                        // Never below 50%: lower makes the computer painfully slow.
                        uint limit = (uint)Math.Max(50, Math.Min(100, value));
                        BatteryService.WriteProcessor(scheme, ThrottleMax, key == "maxAc" ? limit : ac, key == "maxDc" ? limit : dc);
                        break;
                    case "cooling":
                        uint policy = value != 0 ? CoolingActive : CoolingPassive;
                        BatteryService.WriteProcessor(scheme, Cooling, policy, policy);
                        break;
                    default:
                        throw new Exception("Unknown setting.");
                }
                // Maximum performance holds a high minimum speed, which a manual limit shouldn't fight.
                WriteSaved(state, "min", scheme, ThrottleMin);
                BatteryService.ActivatePlan();
                state.Remove("ruleSnapshot");
                state.Remove("ruleMode");
                state["mode"] = "custom";
                Save(state);
                return Info();
            }
        }

        // Puts back what the user had. Also runs when G Ultra is uninstalled.
        public static void Restore()
        {
            lock (Gate)
            {
                Dictionary<string, object> state = Load();
                if (state == null) return;
                WriteOriginals(state);
                File.Delete(StatePath);
            }
        }

        public static object Info()
        {
            Guid scheme = BatteryService.ActivePlan();
            uint boostAc, boostDc, maxAc, maxDc, coolAc, coolDc;
            bool hasBoost = BatteryService.ReadProcessor(scheme, Boost, out boostAc, out boostDc);
            bool hasMax = BatteryService.ReadProcessor(scheme, ThrottleMax, out maxAc, out maxDc);
            bool hasCool = BatteryService.ReadProcessor(scheme, Cooling, out coolAc, out coolDc);

            string mode = "balanced";
            Dictionary<string, object> state = Load();
            if (state != null)
            {
                mode = state.ContainsKey("mode") ? (state["mode"] as string ?? "custom") : "custom";
                bool samePlan = string.Equals(state["scheme"] as string, scheme.ToString(), StringComparison.OrdinalIgnoreCase);
                // Something else may have changed the plan since, so the name has to match what's really set.
                if (!samePlan || (mode == "cool" && boostAc != BoostOff) || (mode == "performance" && boostAc == BoostOff)) mode = "custom";
            }

            return J.D(
                "mode", mode,
                "boost", hasBoost ? (object)(boostAc != BoostOff) : null,
                "maxAc", hasMax ? (object)(long)maxAc : null,
                "maxDc", hasMax ? (object)(long)maxDc : null,
                "coolingActive", hasCool ? (object)(coolAc == CoolingActive) : null,
                "overclock", Overclock());
        }

        // ---- overclocking support: this only detects it, and the maker's own tool does the rest ----
        static string _cpuName;
        const string XtuUrl = "https://www.intel.com/content/www/us/en/download/17881/intel-extreme-tuning-utility-intel-xtu.html";
        const string RyzenMasterUrl = "https://www.amd.com/en/products/software/ryzen-master.html";

        static string CpuName()
        {
            if (_cpuName == null)
            {
                string name = "";
                SystemInfo.Wmi("Win32_Processor", o => { name = SystemInfo.Str(o["Name"]).Replace("(R)", "").Replace("(TM)", "").Trim(); });
                _cpuName = name;
            }
            return _cpuName;
        }

        static string ToolPath(bool amd)
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string[] candidates = amd
                ? new[] { Path.Combine(pf, @"AMD\RyzenMaster\bin\AMD Ryzen Master.exe") }
                : new[]
                {
                    Path.Combine(pf86, @"Intel\Intel(R) Extreme Tuning Utility\Client\PerfTune.exe"),
                    Path.Combine(pf, @"Intel\Intel(R) Extreme Tuning Utility\Client\PerfTune.exe"),
                };
            return candidates.FirstOrDefault(File.Exists);
        }

        static object Overclock()
        {
            string cpu = CpuName();
            bool amd = cpu.IndexOf("AMD", StringComparison.OrdinalIgnoreCase) >= 0;
            bool intel = cpu.IndexOf("Intel", StringComparison.OrdinalIgnoreCase) >= 0;
            string status = "unknown";
            if (intel)
            {
                if (Regex.IsMatch(cpu, @"(i[3579]-\d{4,5}|Ultra [3579] \d{3})(K|KF|KS|X|XE)\b", RegexOptions.IgnoreCase)) status = "unlocked";
                else if (Regex.IsMatch(cpu, @"(i[3579]-\d{4,5}|Ultra [3579] \d{3})(HK|HX)\b", RegexOptions.IgnoreCase)) status = "maybe";
                else status = "locked";
            }
            else if (amd && cpu.IndexOf("Ryzen", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                if (Regex.IsMatch(cpu, @"\d{3,4}HX\b|HX \d{3}\b", RegexOptions.IgnoreCase)) status = "maybe";
                else if (Regex.IsMatch(cpu, @"Ryzen AI|\d{3,4}(U|H|HS)\b", RegexOptions.IgnoreCase)) status = "locked";
                else status = "unlocked";
            }
            if (!intel && !amd) return J.D("status", status, "cpu", cpu, "tool", null, "url", null, "installed", false);
            return J.D(
                "status", status,
                "cpu", cpu,
                "tool", amd ? "AMD Ryzen Master" : "Intel XTU",
                "url", amd ? RyzenMasterUrl : XtuUrl,
                "installed", ToolPath(amd) != null);
        }

        public static object OpenTool()
        {
            string path = ToolPath(CpuName().IndexOf("AMD", StringComparison.OrdinalIgnoreCase) >= 0);
            if (path == null) throw new Exception("The tool wasn't found.");
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            return J.D("ok", true);
        }

        // ---- efficiency mode for one app, the same thing Task Manager's Efficiency mode does ----
        [StructLayout(LayoutKind.Sequential)]
        struct PowerThrottlingState
        {
            public uint Version;
            public uint ControlMask;
            public uint StateMask;
        }

        const int ProcessPowerThrottling = 4;
        const uint ThrottleExecutionSpeed = 1;

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PowerThrottlingState info, int size);

        static bool Protected(Process p)
        {
            string name = p.ProcessName;
            return ProcessList.Critical.Contains(name) || p.Id == Process.GetCurrentProcess().Id || name.Equals("G Ultra", StringComparison.OrdinalIgnoreCase);
        }

        public static object AppEfficiencySet(List<int> pids, bool on)
        {
            int changed = 0, failed = 0;
            foreach (int pid in pids)
            {
                try
                {
                    using (Process p = Process.GetProcessById(pid))
                    {
                        if (Protected(p)) { failed++; continue; }
                        var info = new PowerThrottlingState { Version = 1, ControlMask = on ? ThrottleExecutionSpeed : 0, StateMask = on ? ThrottleExecutionSpeed : 0 };
                        SetProcessInformation(p.Handle, ProcessPowerThrottling, ref info, Marshal.SizeOf(typeof(PowerThrottlingState)));
                        p.PriorityClass = on ? ProcessPriorityClass.Idle : ProcessPriorityClass.Normal;
                        changed++;
                    }
                }
                catch { failed++; }
            }
            return J.D("changed", changed, "failed", failed);
        }

        public static object AppEfficiencyState(List<int> pids)
        {
            var on = new List<object>();
            foreach (int pid in pids)
            {
                try
                {
                    using (Process p = Process.GetProcessById(pid))
                        if (p.PriorityClass == ProcessPriorityClass.Idle) on.Add(pid);
                }
                catch { }
            }
            return on;
        }
    }
}
