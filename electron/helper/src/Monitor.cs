using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

namespace GUltra
{
    // The rules engine. It runs inside the helper, both while the app is open and in the
    // background, when the helper is the only process left running.
    static class Monitor
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
        static readonly object Lock = new object();
        static readonly ManualResetEvent Stopping = new ManualResetEvent(false);
        static readonly AutoResetEvent Wake = new AutoResetEvent(false);

        public static Action<string, string> Notifier = (t, b) => { };
        public static Action<string> StatusChanged = s => { };
        public static bool Paused;

        static bool _background;
        static bool _running;
        static Dictionary<string, object> _cfg;
        static readonly List<object> Events = new List<object>();
        static readonly List<object> History = new List<object>();
        static Dictionary<string, object> _state = new Dictionary<string, object>();
        static DateTime _lastHistorySave = DateTime.UtcNow;
        static DateTime _lastEventSave = DateTime.MinValue;

        // Averages for the current minute of history.
        static long _minute;
        static double _cpuSum, _memSum, _tempMax;
        static int _samples;

        static string Dir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "G Ultra"); } }
        public static string ConfigPath { get { return Path.Combine(Dir, "monitor.json"); } }
        static string EventsPath { get { return Path.Combine(Dir, "monitor-events.json"); } }
        static string HistoryPath { get { return Path.Combine(Dir, "monitor-history.json"); } }
        static string StatePath { get { return Path.Combine(Dir, "monitor-state.json"); } }

        static Dictionary<string, object> Defaults()
        {
            return J.D(
                "enabled", true,
                "mode", "economy",
                "notifications", true,
                "ram", J.D("enabled", false, "threshold", 85, "standby", true, "cooldownMin", 10, "closeApps", false),
                "ramTimer", J.D("enabled", false, "everyMin", 30, "closeApps", false),
                "closeApps", new List<object>(),
                "temp", J.D("enabled", true, "threshold", 90, "limitCpu", false, "limitPercent", 80),
                "fan", J.D("mode", "auto", "percent", 50, "lowTemp", 50, "lowPercent", 35, "highTemp", 80, "highPercent", 100),
                "clean", J.D("enabled", false, "freeGb", 10),
                "battery", J.D("alert", false, "alertPercent", 80, "efficiency", false, "lowPercent", 20));
        }

        static Dictionary<string, object> ReadJson(string path)
        {
            try
            {
                if (!File.Exists(path)) return null;
                return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
            }
            catch { return null; }
        }

        static void WriteJson(string path, object value)
        {
            try
            {
                Directory.CreateDirectory(Dir);
                string temp = path + ".tmp";
                File.WriteAllText(temp, Json.Serialize(value));
                if (File.Exists(path)) File.Replace(temp, path, null);
                else File.Move(temp, path);
            }
            catch { }
        }

        static List<object> ReadList(string path)
        {
            try
            {
                if (!File.Exists(path)) return new List<object>();
                var list = Json.DeserializeObject(File.ReadAllText(path)) as IEnumerable;
                return list == null ? new List<object>() : list.Cast<object>().ToList();
            }
            catch { return new List<object>(); }
        }

        static void LoadConfig()
        {
            var merged = Defaults();
            var saved = ReadJson(ConfigPath);
            if (saved != null)
            {
                foreach (var kv in saved)
                {
                    var section = kv.Value as Dictionary<string, object>;
                    var target = merged.ContainsKey(kv.Key) ? merged[kv.Key] as Dictionary<string, object> : null;
                    if (section != null && target != null)
                    {
                        foreach (var inner in section) target[inner.Key] = inner.Value;
                    }
                    else merged[kv.Key] = kv.Value;
                }
            }
            _cfg = merged;
        }

        static Dictionary<string, object> Section(string name)
        {
            object v;
            return _cfg.TryGetValue(name, out v) && v is Dictionary<string, object> ? (Dictionary<string, object>)v : new Dictionary<string, object>();
        }

        static bool B(Dictionary<string, object> s, string k)
        {
            object v;
            return s.TryGetValue(k, out v) && v is bool && (bool)v;
        }

        static double N(Dictionary<string, object> s, string k, double fallback)
        {
            object v;
            if (!s.TryGetValue(k, out v) || v == null) return fallback;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        static string T(Dictionary<string, object> s, string k, string fallback)
        {
            object v;
            return s.TryGetValue(k, out v) && v is string ? (string)v : fallback;
        }

        public static void Start(bool background)
        {
            _background = background;
            lock (Lock)
            {
                bool firstRun = !File.Exists(ConfigPath);
                LoadConfig();
                Events.AddRange(ReadList(EventsPath));
                History.AddRange(ReadList(HistoryPath));
                _state = ReadJson(StatePath) ?? new Dictionary<string, object>();
                if (firstRun)
                {
                    WriteJson(ConfigPath, _cfg);
                    // You asked for monitoring from startup, so it's on from the first run. The app has the switch.
                    if (SystemInfo.IsElevated()) try { Autostart.Set(true); } catch { }
                }
            }
            RestoreCpuLimit(false);
            _running = true;
            var t = new Thread(Loop);
            t.IsBackground = true;
            t.Priority = ThreadPriority.BelowNormal;
            t.Start();
        }

        public static void Stop()
        {
            Stopping.Set();
            lock (Lock)
            {
                RestoreCpuLimit(false);
                RestorePowerMode();
                SaveAll();
            }
        }

        static void SaveAll()
        {
            WriteJson(EventsPath, Events);
            WriteJson(HistoryPath, History);
            WriteJson(StatePath, _state);
        }

        static int IntervalSec()
        {
            string mode = T(_cfg, "mode", "economy");
            int sec = mode == "realtime" ? 5 : mode == "balanced" ? 15 : 60;
            // A fan curve has to follow the temperature closely enough to be safe.
            if (T(Section("fan"), "mode", "auto") == "curve") sec = Math.Min(sec, 10);
            if (_background && sec > 5 && OnBattery()) sec *= 2;
            return sec;
        }

        static bool OnBattery()
        {
            var live = BatteryInfo.LiveStatus() as Dictionary<string, object>;
            return live != null && !(bool)live["onAc"];
        }

        static void Loop()
        {
            var handles = new WaitHandle[] { Stopping, Wake };
            int delay = 3000;
            while (true)
            {
                int which = WaitHandle.WaitAny(handles, delay);
                if (which == 0) return;
                try
                {
                    lock (Lock) Tick();
                }
                catch (Exception ex)
                {
                    Debug.WriteLine(ex);
                }
                delay = IntervalSec() * 1000;
            }
        }

        static double? Hottest(List<object> sensors, string group)
        {
            double? max = null;
            foreach (Dictionary<string, object> s in sensors)
            {
                if ((string)s["group"] != group || !s.ContainsKey("celsius") || s["celsius"] == null) continue;
                if (s.ContainsKey("approximate") && (bool)s["approximate"]) continue;
                double c = Convert.ToDouble(s["celsius"]);
                if (!max.HasValue || c > max.Value) max = c;
            }
            return max;
        }

        static void Tick()
        {
            bool enabled = B(_cfg, "enabled");
            var temp = Section("temp");
            string fanMode = T(Section("fan"), "mode", "auto");

            // The sensor library takes the most memory. In economy mode it only loads if a rule needs it.
            Sensors.LhmWanted = !_background || T(_cfg, "mode", "economy") != "economy" || (enabled && B(temp, "enabled")) || (enabled && fanMode != "auto");

            var sample = LiveSampler.Recent(Math.Max(1, IntervalSec() - 1));
            var mem = (Dictionary<string, object>)sample["mem"];
            var cpu = (Dictionary<string, object>)sample["cpu"];
            var sensors = (List<object>)sample["sensors"];
            int load = Convert.ToInt32(mem["load"]);
            double usage = cpu["usage"] != null ? Convert.ToDouble(cpu["usage"]) : 0;
            double? cpuTemp = Hottest(sensors, "cpu");
            double? gpuTemp = Hottest(sensors, "gpu");

            AddHistory(usage, load, cpuTemp);
            StatusChanged("G Ultra · RAM " + load + "%" + (cpuTemp.HasValue ? " · CPU " + Math.Round(cpuTemp.Value) + "°C" : ""));

            if (enabled && !Paused)
            {
                bool quiet = UserIsBusy();
                RuleRam(load, quiet);
                RuleRamTimer(quiet);
                RuleTemp(cpuTemp);
                RuleFan(cpuTemp, gpuTemp, fanMode);
                RuleClean();
                RuleBattery();
            }
            else
            {
                RestoreCpuLimit(false);
                if (_fanWasRuled)
                {
                    Fans.RestoreAll();
                    _fanWasRuled = false;
                }
            }

            if ((DateTime.UtcNow - _lastHistorySave).TotalMinutes >= 5)
            {
                _lastHistorySave = DateTime.UtcNow;
                WriteJson(HistoryPath, History);
            }

            // In the background, give memory back between samples.
            if (_background)
            {
                GC.Collect();
                Native.EmptyWorkingSet(Process.GetCurrentProcess().Handle);
            }
        }

        static void AddHistory(double usage, int load, double? cpuTemp)
        {
            long now = (long)DateTime.UtcNow.Subtract(new DateTime(1970, 1, 1)).TotalMilliseconds;
            long minute = now / 60000;
            if (minute != _minute && _samples > 0)
            {
                History.Add(J.D("t", _minute * 60000, "cpu", J.R(_cpuSum / _samples, 1), "mem", J.R(_memSum / _samples, 1), "temp", _tempMax > 0 ? (object)J.R(_tempMax, 1) : null));
                long cutoff = now - 24L * 3600 * 1000;
                History.RemoveAll(p => Convert.ToInt64(((Dictionary<string, object>)p)["t"]) < cutoff);
                _cpuSum = _memSum = _tempMax = 0;
                _samples = 0;
            }
            _minute = minute;
            _cpuSum += usage;
            _memSum += load;
            if (cpuTemp.HasValue && cpuTemp.Value > _tempMax) _tempMax = cpuTemp.Value;
            _samples++;
        }

        public static object GetHistory()
        {
            lock (Lock) return History.ToList();
        }

        // ---- events ----
        static void Log(string kind, string text, bool notify)
        {
            long ts = (long)DateTime.UtcNow.Subtract(new DateTime(1970, 1, 1)).TotalMilliseconds;
            var e = J.D("ts", ts, "kind", kind, "text", text);
            Events.Add(e);
            if (Events.Count > 200) Events.RemoveRange(0, Events.Count - 200);
            if ((DateTime.UtcNow - _lastEventSave).TotalSeconds > 30)
            {
                _lastEventSave = DateTime.UtcNow;
                WriteJson(EventsPath, Events);
            }
            if (!_background) Program.Emit("monitorEvent", e);
            if (notify && B(_cfg, "notifications")) Notifier("G Ultra", text);
        }

        // Full-screen games and presentations shouldn't be interrupted.
        [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

        static bool UserIsBusy()
        {
            try
            {
                int state;
                if (SHQueryUserNotificationState(out state) != 0) return false;
                return state == 2 || state == 3 || state == 4;
            }
            catch { return false; }
        }

        // ---- memory rules ----
        static string Stamp(string key)
        {
            object v;
            return _state.TryGetValue(key, out v) ? v as string : null;
        }

        static double MinutesSince(string key)
        {
            DateTime d;
            string s = Stamp(key);
            if (s == null || !DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out d)) return double.MaxValue;
            return (DateTime.UtcNow - d).TotalMinutes;
        }

        static void Mark(string key)
        {
            _state[key] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            WriteJson(StatePath, _state);
        }

        static string Size(long bytes)
        {
            return bytes >= (1L << 30) ? (bytes / (double)(1L << 30)).ToString("0.0", CultureInfo.InvariantCulture) + " GB" : (bytes / (1L << 20)) + " MB";
        }

        static void RuleRam(int load, bool quiet)
        {
            var r = Section("ram");
            if (!B(r, "enabled") || quiet || load < N(r, "threshold", 85)) return;
            if (MinutesSince("ramAt") < N(r, "cooldownMin", 10)) return;
            Mark("ramAt");
            var res = (Dictionary<string, object>)MemoryCleaner.Free(B(r, "standby") && SystemInfo.IsElevated());
            int closed = B(r, "closeApps") ? CloseChosenApps() : 0;
            Log("ram", "Memory reached " + load + "%. Freed " + Size(Convert.ToInt64(res["freed"])) + (closed > 0 ? " and closed " + closed + (closed == 1 ? " app." : " apps.") : "."), true);
        }

        static void RuleRamTimer(bool quiet)
        {
            var r = Section("ramTimer");
            if (!B(r, "enabled") || quiet) return;
            if (MinutesSince("timerAt") < N(r, "everyMin", 30)) return;
            Mark("timerAt");
            var res = (Dictionary<string, object>)MemoryCleaner.Free(false);
            int closed = B(r, "closeApps") ? CloseChosenApps() : 0;
            Log("timer", "Scheduled cleanup: freed " + Size(Convert.ToInt64(res["freed"])) + (closed > 0 ? " and closed " + closed + (closed == 1 ? " app." : " apps.") : "."), false);
        }

        // Only apps you marked. The one you're using is skipped, and an app that still
        // has a window after being asked to close keeps running, so unsaved work is safe.
        static int CloseChosenApps()
        {
            object raw;
            if (!_cfg.TryGetValue("closeApps", out raw) || !(raw is IEnumerable)) return 0;
            var names = new HashSet<string>(((IEnumerable)raw).OfType<string>(), StringComparer.OrdinalIgnoreCase);
            if (names.Count == 0) return 0;

            int foreground = 0;
            Native.GetWindowThreadProcessId(GetForegroundWindow(), out foreground);
            var groups = ProcessList.Snapshot().Where(e => names.Contains(e.Name) && !ProcessList.Critical.Contains(e.Name)).GroupBy(e => e.Name, StringComparer.OrdinalIgnoreCase);
            int closed = 0;
            foreach (var g in groups)
            {
                var pids = g.Select(e => e.Pid).ToList();
                if (pids.Contains(foreground)) continue;
                ProcessList.End(pids, false);
                var alive = new HashSet<int>(ProcessList.Snapshot().Select(e => e.Pid));
                var left = pids.Where(alive.Contains).ToList();
                if (left.Count > 0)
                {
                    if (ProcessList.HasVisibleWindow(left)) continue;
                    ProcessList.End(left, true);
                }
                closed++;
            }
            return closed;
        }

        // ---- temperature ----
        static int _hotCount, _coolCount;
        static bool _cpuLimited;

        static void RuleTemp(double? cpuTemp)
        {
            var r = Section("temp");
            if (!B(r, "enabled") || !cpuTemp.HasValue)
            {
                if (!B(r, "enabled")) RestoreCpuLimit(true);
                return;
            }
            double threshold = N(r, "threshold", 90);
            if (cpuTemp.Value >= threshold)
            {
                _hotCount++;
                _coolCount = 0;
                if (_hotCount < 2) return;
                bool limit = B(r, "limitCpu");
                if (limit && !_cpuLimited)
                {
                    int[] old = BatteryService.GetCpuLimits();
                    if (old != null)
                    {
                        _state["cpuAc"] = old[0];
                        _state["cpuDc"] = old[1];
                        WriteJson(StatePath, _state);
                        BatteryService.SetCpuLimits((int)N(r, "limitPercent", 80));
                        _cpuLimited = true;
                        Log("temp", "Processor at " + Math.Round(cpuTemp.Value) + "°C. Limited it to " + N(r, "limitPercent", 80) + "% to cool down.", true);
                        Mark("tempAt");
                        return;
                    }
                }
                if (MinutesSince("tempAt") >= 15)
                {
                    Mark("tempAt");
                    Log("temp", "Processor at " + Math.Round(cpuTemp.Value) + "°C, above your limit of " + threshold + "°C.", true);
                }
            }
            else
            {
                _hotCount = 0;
                if (_cpuLimited && cpuTemp.Value < threshold - 8 && ++_coolCount >= 3) RestoreCpuLimit(true);
            }
        }

        static void RestoreCpuLimit(bool log)
        {
            object ac, dc;
            if (!_state.TryGetValue("cpuAc", out ac) || !_state.TryGetValue("cpuDc", out dc)) return;
            try
            {
                BatteryService.SetCpuLimits(Convert.ToInt32(ac), Convert.ToInt32(dc));
                _state.Remove("cpuAc");
                _state.Remove("cpuDc");
                WriteJson(StatePath, _state);
                _cpuLimited = false;
                _coolCount = 0;
                if (log) Log("temp", "Temperature is back to normal. Processor limit removed.", false);
            }
            catch { }
        }

        // ---- fans ----
        static bool _fanWasRuled;
        static double _lastFanPercent = -1;

        static void RuleFan(double? cpuTemp, double? gpuTemp, string mode)
        {
            var r = Section("fan");
            if (mode == "auto")
            {
                if (_fanWasRuled)
                {
                    Fans.RestoreAll();
                    _fanWasRuled = false;
                    _lastFanPercent = -1;
                }
                return;
            }
            double percent;
            if (mode == "fixed")
            {
                percent = N(r, "percent", 50);
            }
            else
            {
                double? t = cpuTemp;
                if (gpuTemp.HasValue && (!t.HasValue || gpuTemp.Value > t.Value)) t = gpuTemp;
                if (!t.HasValue) return;
                double lowT = N(r, "lowTemp", 50), highT = N(r, "highTemp", 80), lowP = N(r, "lowPercent", 35), highP = N(r, "highPercent", 100);
                if (highT <= lowT) highT = lowT + 1;
                double f = Math.Max(0, Math.Min(1, (t.Value - lowT) / (highT - lowT)));
                percent = lowP + (highP - lowP) * f;
            }
            if (Math.Abs(percent - _lastFanPercent) < 3 && _fanWasRuled) return;
            if (Fans.ApplyAll(percent) > 0)
            {
                _fanWasRuled = true;
                _lastFanPercent = percent;
            }
        }

        // ---- disk ----
        static bool _cleaning;

        static void RuleClean()
        {
            var r = Section("clean");
            if (!B(r, "enabled") || _cleaning) return;
            if (MinutesSince("cleanAt") < 24 * 60) return;
            try
            {
                var system = new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory));
                if (system.AvailableFreeSpace >= N(r, "freeGb", 10) * (1L << 30)) return;
            }
            catch { return; }
            Mark("cleanAt");
            _cleaning = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    var res = (Dictionary<string, object>)Cleaner.Run(new List<string> { "temp-user", "temp-windows", "crash", "winupdate", "delivery" });
                    lock (Lock) Log("clean", "Low on disk space: cleaned " + Size(Convert.ToInt64(res["freed"])) + " of temporary files.", true);
                }
                catch { }
                _cleaning = false;
            });
        }

        // ---- battery ----
        static bool _alerted;
        static string _savedMode;

        static void RuleBattery()
        {
            var r = Section("battery");
            var live = BatteryInfo.LiveStatus() as Dictionary<string, object>;
            if (live == null || live["percent"] == null) return;
            double percent = Convert.ToDouble(live["percent"]);
            bool onAc = (bool)live["onAc"];

            if (B(r, "alert"))
            {
                double at = N(r, "alertPercent", 80);
                if (onAc && percent >= at && !_alerted)
                {
                    _alerted = true;
                    Log("battery", "Battery at " + percent + "%. Unplug now to help it last longer.", true);
                }
                if (!onAc || percent < at - 3) _alerted = false;
            }

            if (B(r, "efficiency"))
            {
                double low = N(r, "lowPercent", 20);
                if (!onAc && percent <= low && _savedMode == null)
                {
                    _savedMode = BatteryService.GetPowerMode();
                    if (_savedMode != null)
                    {
                        BatteryService.SetPowerMode("efficiency");
                        Log("battery", "Battery at " + percent + "%. Switched to the efficient power mode.", true);
                    }
                }
                else if (_savedMode != null && (onAc || percent > low + 5))
                {
                    RestorePowerMode();
                }
            }
            else if (_savedMode != null)
            {
                RestorePowerMode();
            }
        }

        static void RestorePowerMode()
        {
            if (_savedMode == null) return;
            try { BatteryService.SetPowerMode(_savedMode); } catch { }
            _savedMode = null;
        }

        // ---- calls from the app ----
        public static object GetInfo()
        {
            lock (Lock)
            {
                if (_cfg == null) LoadConfig();
                var recent = Events.Skip(Math.Max(0, Events.Count - 40)).Reverse().ToList();
                return J.D(
                    "config", _cfg,
                    "running", _running,
                    "autostart", Autostart.IsEnabled(),
                    "elevated", SystemInfo.IsElevated(),
                    "cpuLimited", _cpuLimited,
                    "events", recent);
            }
        }

        public static object SetConfig(Dictionary<string, object> config)
        {
            if (config == null) throw new Exception("Missing settings.");
            lock (Lock)
            {
                _cfg = config;
                WriteJson(ConfigPath, _cfg);
            }
            Wake.Set();
            return J.D("ok", true);
        }
    }

    // Starting with Windows. With admin rights it's a scheduled task, the only way to start
    // elevated at sign-in without a UAC prompt. Without them it falls back to the Run key.
    static class Autostart
    {
        const string TaskName = "G Ultra Monitor";
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        static bool? _cached;

        static string ExePath { get { return System.Reflection.Assembly.GetExecutingAssembly().Location; } }

        static int Schtasks(string args)
        {
            var psi = new ProcessStartInfo("schtasks.exe", args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using (var p = Process.Start(psi))
            {
                p.OutputDataReceived += (s, e) => { };
                p.ErrorDataReceived += (s, e) => { };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                if (!p.WaitForExit(15000))
                {
                    try { p.Kill(); } catch { }
                    return -1;
                }
                return p.ExitCode;
            }
        }

        public static bool IsEnabled()
        {
            if (_cached.HasValue) return _cached.Value;
            bool on = false;
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey))
                    on = k != null && k.GetValue(TaskName) != null;
                if (!on) on = Schtasks("/Query /TN \"" + TaskName + "\"") == 0;
            }
            catch { }
            _cached = on;
            return on;
        }

        public static object Set(bool on)
        {
            bool elevated = SystemInfo.IsElevated();
            using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on && !elevated) k.SetValue(TaskName, "\"" + ExePath + "\" --background");
                else k.DeleteValue(TaskName, false);
            }
            if (elevated)
            {
                if (on)
                {
                    string xmlPath = Path.Combine(Path.GetTempPath(), "gultra-task-" + Guid.NewGuid().ToString("N") + ".xml");
                    try
                    {
                        File.WriteAllText(xmlPath, TaskXml(), System.Text.Encoding.Unicode);
                        if (Schtasks("/Create /TN \"" + TaskName + "\" /XML \"" + xmlPath + "\" /F") != 0)
                            throw new Exception("Windows couldn't create the startup task.");
                    }
                    finally
                    {
                        try { File.Delete(xmlPath); } catch { }
                    }
                }
                else Schtasks("/Delete /TN \"" + TaskName + "\" /F");
            }
            _cached = on;
            return J.D("ok", true, "autostart", on);
        }

        static string TaskXml()
        {
            string sid;
            using (var id = System.Security.Principal.WindowsIdentity.GetCurrent()) sid = id.User.Value;
            string exe = System.Security.SecurityElement.Escape(ExePath);
            return "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n" +
                "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n" +
                "  <RegistrationInfo><Description>G Ultra background monitoring</Description></RegistrationInfo>\n" +
                "  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + sid + "</UserId><Delay>PT15S</Delay></LogonTrigger></Triggers>\n" +
                "  <Principals><Principal id=\"Author\"><UserId>" + sid + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>\n" +
                "  <Settings>\n" +
                "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n" +
                "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n" +
                "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n" +
                "    <AllowHardTerminate>true</AllowHardTerminate>\n" +
                "    <StartWhenAvailable>false</StartWhenAvailable>\n" +
                "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n" +
                "    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>\n" +
                "    <AllowStartOnDemand>true</AllowStartOnDemand>\n" +
                "    <Enabled>true</Enabled>\n" +
                "    <Hidden>false</Hidden>\n" +
                "    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n" +
                "    <WakeToRun>false</WakeToRun>\n" +
                "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n" +
                "    <Priority>7</Priority>\n" +
                "  </Settings>\n" +
                "  <Actions Context=\"Author\"><Exec><Command>" + exe + "</Command><Arguments>--background</Arguments></Exec></Actions>\n" +
                "</Task>\n";
        }
    }
}
