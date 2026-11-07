using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace GUltra
{
    static class SystemInfo
    {
        static Dictionary<string, object> _cached;

        public static object Get()
        {
            if (_cached == null) _cached = Build();
            // Uptime changes, the rest does not.
            var d = new Dictionary<string, object>(_cached);
            d["uptimeSec"] = (long)(Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency);
            d["sensorDriver"] = Sensors.DriverState();
            return d;
        }

        static readonly Lazy<bool> Elevated = new Lazy<bool>(() =>
        {
            using (var id = WindowsIdentity.GetCurrent())
                return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
        });

        public static bool IsElevated() { return Elevated.Value; }

        static Dictionary<string, object> Build()
        {
            string manufacturer = "", model = "", cpu = "", os = "", build = "";
            int cores = 0, threads = 0, chassis = 0;
            var gpus = new List<object>();

            Wmi("Win32_ComputerSystem", o =>
            {
                manufacturer = Str(o["Manufacturer"]);
                model = Str(o["Model"]);
                chassis = Convert.ToInt32(o["PCSystemType"] ?? 0);
            });
            Wmi("Win32_Processor", o =>
            {
                cpu = Str(o["Name"]);
                cores += Convert.ToInt32(o["NumberOfCores"] ?? 0);
                threads += Convert.ToInt32(o["NumberOfLogicalProcessors"] ?? 0);
            });
            Wmi("Win32_VideoController", o =>
            {
                string n = Str(o["Name"]);
                if (n.Length > 0 && n.IndexOf("Basic Display", StringComparison.OrdinalIgnoreCase) < 0) gpus.Add(n);
            });
            Wmi("Win32_OperatingSystem", o =>
            {
                os = Str(o["Caption"]).Replace("Microsoft ", "");
                build = Str(o["BuildNumber"]);
            });

            return J.D(
                "platform", "windows",
                "deviceName", CleanModel(manufacturer, model),
                "manufacturer", manufacturer,
                "model", model,
                "osName", os,
                "osBuild", build,
                "cpuName", CleanCpu(cpu),
                "cores", cores,
                "threads", threads,
                "gpus", gpus,
                "isLaptop", chassis == 2,
                "hasBattery", BatteryInfo.Health() != null,
                "elevated", IsElevated());
        }

        static string CleanModel(string man, string model)
        {
            if (model.Length == 0 || model.IndexOf("System Product", StringComparison.OrdinalIgnoreCase) >= 0) return Environment.MachineName;
            if (man.Length > 0 && !model.StartsWith(man, StringComparison.OrdinalIgnoreCase) && man.Length < 12) return man + " " + model;
            return model;
        }

        static string CleanCpu(string s)
        {
            return s.Replace("(R)", "").Replace("(TM)", "").Replace("  ", " ").Trim();
        }

        public static void Wmi(string cls, Action<ManagementBaseObject> each)
        {
            WmiNs(@"root\cimv2", "SELECT * FROM " + cls, each);
        }

        public static void WmiNs(string ns, string query, Action<ManagementBaseObject> each)
        {
            try
            {
                using (var s = new ManagementObjectSearcher(ns, query))
                using (var r = s.Get())
                    foreach (ManagementBaseObject o in r)
                        using (o) each(o);
            }
            catch { }
        }

        public static string Str(object o)
        {
            return o == null ? "" : o.ToString().Trim();
        }
    }

    // One live sample: processor, memory, disk, processes, temperatures, GPUs and fans.
    static class LiveSampler
    {
        static readonly object Lock = new object();
        static Pdh _pdh;
        static Dictionary<string, object> _last;
        static DateTime _lastAt = DateTime.MinValue;

        public static object Sample()
        {
            lock (Lock)
            {
                if (_pdh == null) _pdh = new Pdh();
                _pdh.Collect();

                var mem = Native.MemStatus();
                ulong total = mem.ullTotalPhys, avail = mem.ullAvailPhys;
                double standby = _pdh.Get("standbyCore") + _pdh.Get("standbyNormal") + _pdh.Get("standbyReserve");
                double modified = _pdh.Get("modified");
                double free = _pdh.Get("free");

                double baseMHz = _pdh.Get("freqBase");
                double perf = _pdh.Get("perf");
                double usage = _pdh.Get("cpu");

                var perCore = _pdh.GetArray("cpuCores")
                    .Where(kv => !kv.Key.Contains("_Total"))
                    .OrderBy(kv => CoreSort(kv.Key))
                    .Select(kv => (object)Math.Round(Math.Min(100, kv.Value), 1)).ToList();

                var zones = _pdh.GetArray("zoneTemp");
                var limits = _pdh.GetArray("zoneLimit");
                bool throttling = limits.Any(kv => kv.Value > 0 && kv.Value < 100);

                var processes = ProcessList.Sample((long)total);
                var hw = Sensors.Read(zones);

                _last = J.D(
                    "ts", DateTime.UtcNow.Subtract(new DateTime(1970, 1, 1)).TotalMilliseconds,
                    "cpu", J.D(
                        "usage", J.R(Math.Min(100, Math.Max(0, usage)), 1),
                        "perCore", perCore,
                        "freqMHz", baseMHz > 0 ? (object)Math.Round(baseMHz * perf / 100.0) : null,
                        "baseMHz", baseMHz > 0 ? (object)Math.Round(baseMHz) : null),
                    "mem", J.D(
                        "total", (long)total,
                        "available", (long)avail,
                        "used", (long)(total - avail),
                        "load", (int)mem.dwMemoryLoad,
                        "standby", (long)standby,
                        "modified", (long)modified,
                        "free", (long)free,
                        "commit", (long)_pdh.Get("committed"),
                        "commitLimit", (long)_pdh.Get("commitLimit"),
                        "swapTotal", (long)(mem.ullTotalPageFile > total ? mem.ullTotalPageFile - total : 0)),
                    "disk", J.D(
                        "activePct", J.R(Math.Max(0, 100 - _pdh.Get("diskIdle")), 1),
                        "readBps", (long)_pdh.Get("diskRead"),
                        "writeBps", (long)_pdh.Get("diskWrite")),
                    "processes", processes,
                    "sensors", hw.Sensors,
                    "gpus", hw.Gpus,
                    "fans", Fans.Snapshot(),
                    "throttling", limits.Count > 0 ? (object)throttling : null,
                    "power", BatteryInfo.LiveStatus(),
                    "elevated", SystemInfo.IsElevated());
                _lastAt = DateTime.UtcNow;
                return _last;
            }
        }

        // The rules engine shares samples with the app, so per-process figures stay accurate.
        public static Dictionary<string, object> Recent(int maxAgeSec)
        {
            lock (Lock)
            {
                if (_last != null && (DateTime.UtcNow - _lastAt).TotalSeconds < maxAgeSec) return _last;
                Sample();
                return _last;
            }
        }

        static int CoreSort(string name)
        {
            // Instance names look like "0,3"
            string[] parts = name.Split(',');
            int a = 0, b = 0;
            if (parts.Length == 2) { int.TryParse(parts[0], out a); int.TryParse(parts[1], out b); }
            return a * 1000 + b;
        }
    }

    // Performance counters through PDH, by English name, so any Windows language works.
    class Pdh
    {
        readonly IntPtr _query;
        readonly Dictionary<string, IntPtr> _counters = new Dictionary<string, IntPtr>();

        public Pdh()
        {
            Native.PdhOpenQuery(null, IntPtr.Zero, out _query);
            Add("cpu", @"\Processor Information(_Total)\% Processor Utility");
            Add("perf", @"\Processor Information(_Total)\% Processor Performance");
            Add("freqBase", @"\Processor Information(_Total)\Processor Frequency");
            Add("cpuCores", @"\Processor Information(*)\% Processor Utility");
            Add("modified", @"\Memory\Modified Page List Bytes");
            Add("standbyCore", @"\Memory\Standby Cache Core Bytes");
            Add("standbyNormal", @"\Memory\Standby Cache Normal Priority Bytes");
            Add("standbyReserve", @"\Memory\Standby Cache Reserve Bytes");
            Add("free", @"\Memory\Free & Zero Page List Bytes");
            Add("committed", @"\Memory\Committed Bytes");
            Add("commitLimit", @"\Memory\Commit Limit");
            Add("diskIdle", @"\PhysicalDisk(_Total)\% Idle Time");
            Add("diskRead", @"\PhysicalDisk(_Total)\Disk Read Bytes/sec");
            Add("diskWrite", @"\PhysicalDisk(_Total)\Disk Write Bytes/sec");
            Add("zoneTemp", @"\Thermal Zone Information(*)\Temperature");
            Add("zoneLimit", @"\Thermal Zone Information(*)\% Passive Limit");
            // Rate counters need two collections; the first one primes them.
            Native.PdhCollectQueryData(_query);
            System.Threading.Thread.Sleep(120);
        }

        void Add(string key, string path)
        {
            IntPtr c;
            if (Native.PdhAddEnglishCounter(_query, path, IntPtr.Zero, out c) == 0) _counters[key] = c;
        }

        public void Collect() { Native.PdhCollectQueryData(_query); }

        public double Get(string key)
        {
            IntPtr c;
            if (!_counters.TryGetValue(key, out c)) return 0;
            uint type;
            Native.PDH_VALUE v;
            uint st = Native.PdhGetFormattedCounterValue(c, Native.PDH_FMT_DOUBLE | Native.PDH_FMT_NOCAP100, out type, out v);
            return st == 0 && v.Status <= 1 ? v.Value : 0;
        }

        public Dictionary<string, double> GetArray(string key)
        {
            var res = new Dictionary<string, double>();
            IntPtr c;
            if (!_counters.TryGetValue(key, out c)) return res;
            int size = 0, count;
            Native.PdhGetFormattedCounterArray(c, Native.PDH_FMT_DOUBLE | Native.PDH_FMT_NOCAP100, ref size, out count, IntPtr.Zero);
            if (size <= 0) return res;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                if (Native.PdhGetFormattedCounterArray(c, Native.PDH_FMT_DOUBLE | Native.PDH_FMT_NOCAP100, ref size, out count, buf) != 0) return res;
                int item = IntPtr.Size + 16;
                for (int i = 0; i < count; i++)
                {
                    IntPtr p = IntPtr.Add(buf, i * item);
                    string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p));
                    var val = (Native.PDH_VALUE)Marshal.PtrToStructure(IntPtr.Add(p, IntPtr.Size), typeof(Native.PDH_VALUE));
                    if (val.Status <= 1 && name != null) res[name] = val.Value;
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
            return res;
        }
    }

    // Process snapshot through NtQuerySystemInformation: fast, and includes protected processes.
    static class ProcessList
    {
        class Prev { public long Cpu; public long Io; }

        static Dictionary<int, Prev> _prev = new Dictionary<int, Prev>();
        static long _prevTick;
        static readonly Dictionary<string, string> PathCache = new Dictionary<string, string>();
        static readonly Dictionary<string, string> TitleCache = new Dictionary<string, string>();
        static readonly int LogicalCpus = Environment.ProcessorCount;

        // Processes Windows depends on: never offered for closing.
        public static readonly HashSet<string> Critical = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "System", "Idle", "Registry", "Memory Compression", "Secure System", "smss", "csrss", "wininit", "winlogon",
            "services", "lsass", "lsaiso", "svchost", "dwm", "fontdrvhost", "sihost", "ctfmon", "taskhostw", "spoolsv",
            "explorer", "SearchHost", "StartMenuExperienceHost", "ShellExperienceHost", "RuntimeBroker", "WmiPrvSE",
            "dllhost", "conhost", "MsMpEng", "NisSrv", "SecurityHealthService", "SecurityHealthSystray", "audiodg",
            "TextInputHost", "LsaIso", "SgrmBroker", "WUDFHost", "dasHost", "AggregatorHost", "Interrupts", "smartscreen",
            "GUltraHelper", "G Ultra"
        };

        public struct Entry
        {
            public int Pid; public string Name; public long Cpu; public long PrivateWs; public long Ws; public long Commit; public long Io;
        }

        public static List<Entry> Snapshot()
        {
            int size = 1 << 20;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                int ret;
                int st;
                while ((st = Native.NtQuerySystemInformation(5, buf, size, out ret)) == unchecked((int)0xC0000004))
                {
                    size = Math.Max(size * 2, ret + 65536);
                    Marshal.FreeHGlobal(buf);
                    buf = Marshal.AllocHGlobal(size);
                }
                if (st != 0) return new List<Entry>();

                var list = new List<Entry>(400);
                int off = 0;
                while (true)
                {
                    IntPtr p = IntPtr.Add(buf, off);
                    int next = Marshal.ReadInt32(p, 0x00);
                    long userTime = Marshal.ReadInt64(p, 0x28);
                    long kernelTime = Marshal.ReadInt64(p, 0x30);
                    int nameLen = (ushort)Marshal.ReadInt16(p, 0x38);
                    IntPtr namePtr = Marshal.ReadIntPtr(p, 0x40);
                    int pid = (int)Marshal.ReadIntPtr(p, 0x50).ToInt64();
                    string name = nameLen > 0 && namePtr != IntPtr.Zero ? Marshal.PtrToStringUni(namePtr, nameLen / 2) : (pid == 0 ? "Idle" : "System");
                    if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);

                    list.Add(new Entry
                    {
                        Pid = pid,
                        Name = name,
                        Cpu = userTime + kernelTime,
                        PrivateWs = Marshal.ReadInt64(p, 0x08),
                        Ws = Marshal.ReadInt64(p, 0x90),
                        Commit = Marshal.ReadInt64(p, 0xC8),
                        Io = Marshal.ReadInt64(p, 0xE8) + Marshal.ReadInt64(p, 0xF0),
                    });
                    if (next == 0) break;
                    off += next;
                }
                return list;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        class Group
        {
            public string Name; public double Cpu; public long Mem; public double Disk; public List<object> Pids = new List<object>(); public int FirstPid;
        }

        public static List<object> Sample(long totalRam)
        {
            var snap = Snapshot();
            long now = Stopwatch.GetTimestamp();
            double elapsedSec = _prevTick == 0 ? 0 : (now - _prevTick) / (double)Stopwatch.Frequency;
            var next = new Dictionary<int, Prev>(snap.Count);
            var groups = new Dictionary<string, Group>(StringComparer.OrdinalIgnoreCase);

            foreach (Entry e in snap)
            {
                if (e.Pid == 0) { next[e.Pid] = new Prev { Cpu = e.Cpu, Io = e.Io }; continue; }
                double cpu = 0, disk = 0;
                Prev prev;
                if (elapsedSec > 0 && _prev.TryGetValue(e.Pid, out prev))
                {
                    cpu = Math.Max(0, (e.Cpu - prev.Cpu) / 1e7 / elapsedSec / LogicalCpus * 100.0);
                    disk = Math.Max(0, (e.Io - prev.Io) / elapsedSec);
                }
                next[e.Pid] = new Prev { Cpu = e.Cpu, Io = e.Io };

                Group g;
                if (!groups.TryGetValue(e.Name, out g))
                {
                    g = new Group { Name = e.Name, FirstPid = e.Pid };
                    groups[e.Name] = g;
                }
                g.Cpu += cpu;
                g.Disk += disk;
                // Same figure as Task Manager: the private working set.
                g.Mem += e.PrivateWs > 0 ? e.PrivateWs : e.Ws;
                g.Pids.Add(e.Pid);
            }
            _prev = next;
            _prevTick = now;

            return groups.Values
                .Where(g => g.Mem > 1 << 20 || g.Cpu > 0.05)
                .OrderByDescending(g => g.Mem)
                .Take(120)
                .Select(g =>
                {
                    string path = PathOf(g.Name, g.FirstPid);
                    return (object)J.D(
                        "key", g.Name,
                        "name", g.Name,
                        "title", TitleOf(g.Name, path),
                        "path", path,
                        "pids", g.Pids,
                        "cpu", J.R(g.Cpu, 1),
                        "mem", g.Mem,
                        "disk", (long)g.Disk,
                        "critical", Critical.Contains(g.Name));
                }).ToList();
        }

        static string PathOf(string name, int pid)
        {
            string cached;
            if (PathCache.TryGetValue(name, out cached) && cached != null) return cached;
            string path = null;
            IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h != IntPtr.Zero)
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                if (Native.QueryFullProcessImageName(h, 0, sb, ref size)) path = sb.ToString();
                Native.CloseHandle(h);
            }
            PathCache[name] = path;
            return path;
        }

        // The friendly name from the exe resources ("Google Chrome" rather than "chrome").
        static string TitleOf(string name, string path)
        {
            string cached;
            if (TitleCache.TryGetValue(name, out cached)) return cached;
            string title = name;
            if (path != null)
            {
                try
                {
                    var info = FileVersionInfo.GetVersionInfo(path);
                    string desc = (info.FileDescription ?? "").Trim();
                    if (desc.Length > 1 && desc.Length < 48) title = desc;
                    else if (!string.IsNullOrWhiteSpace(info.ProductName) && info.ProductName.Length < 48) title = info.ProductName.Trim();
                }
                catch { }
                TitleCache[name] = title;
            }
            return title;
        }

        // force=false: asks the windows to close, so the app can save.
        // force=true: terminates the processes.
        public static object End(List<int> pids, bool force)
        {
            int closed = 0, failed = 0, refused = 0, asked = 0;
            var snap = Snapshot().ToDictionary(e => e.Pid, e => e.Name);
            int self = Process.GetCurrentProcess().Id;
            int parent = Parent();

            if (!force)
            {
                var targets = new HashSet<int>(pids.Where(p => snap.ContainsKey(p) && !Critical.Contains(snap[p])));
                Native.EnumWindows((hwnd, l) =>
                {
                    int pid;
                    Native.GetWindowThreadProcessId(hwnd, out pid);
                    if (targets.Contains(pid) && Native.IsWindowVisible(hwnd))
                    {
                        Native.PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
                        asked++;
                    }
                    return true;
                }, IntPtr.Zero);

                // Give apps a few seconds to close on their own.
                var deadline = DateTime.UtcNow.AddSeconds(asked > 0 ? 3 : 0);
                while (DateTime.UtcNow < deadline)
                {
                    var alive = new HashSet<int>(Snapshot().Select(e => e.Pid));
                    if (!targets.Any(alive.Contains)) break;
                    System.Threading.Thread.Sleep(200);
                }
                var stillAlive = new HashSet<int>(Snapshot().Select(e => e.Pid));
                int remaining = targets.Count(stillAlive.Contains);
                return J.D("closed", targets.Count - remaining, "remaining", remaining, "asked", asked, "failed", 0, "refused", pids.Count - targets.Count);
            }

            foreach (int pid in pids)
            {
                string name;
                if (!snap.TryGetValue(pid, out name)) continue;
                if (Critical.Contains(name) || pid == self || pid == parent) { refused++; continue; }
                IntPtr h = Native.OpenProcess(Native.PROCESS_TERMINATE, false, pid);
                if (h == IntPtr.Zero) { failed++; continue; }
                if (TerminateProcess(h, 1)) closed++; else failed++;
                Native.CloseHandle(h);
            }
            return J.D("closed", closed, "remaining", failed, "asked", 0, "failed", failed, "refused", refused);
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(IntPtr h, uint code);

        public static bool HasVisibleWindow(List<int> pids)
        {
            var set = new HashSet<int>(pids);
            bool found = false;
            Native.EnumWindows((hwnd, l) =>
            {
                int pid;
                Native.GetWindowThreadProcessId(hwnd, out pid);
                if (set.Contains(pid) && Native.IsWindowVisible(hwnd))
                {
                    found = true;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        static int Parent()
        {
            try
            {
                using (var s = new ManagementObjectSearcher("SELECT ParentProcessId FROM Win32_Process WHERE ProcessId=" + Process.GetCurrentProcess().Id))
                using (var r = s.Get())
                    foreach (ManagementBaseObject o in r) return Convert.ToInt32(o["ParentProcessId"]);
            }
            catch { }
            return -1;
        }
    }

    static class MemoryCleaner
    {
        // Trims the working set of every reachable process; in full mode also purges the standby list.
        public static object Free(bool standby)
        {
            ulong before = Native.MemStatus().ullAvailPhys;
            int trimmed = 0, denied = 0;
            int self = Process.GetCurrentProcess().Id;
            bool elevated = SystemInfo.IsElevated();
            if (elevated) Native.EnablePrivilege("SeDebugPrivilege");

            foreach (var e in ProcessList.Snapshot())
            {
                if (e.Pid <= 4 || e.Pid == self) continue;
                IntPtr h = Native.OpenProcess(Native.PROCESS_SET_QUOTA | Native.PROCESS_QUERY_LIMITED_INFORMATION, false, e.Pid);
                if (h == IntPtr.Zero) { denied++; continue; }
                if (Native.EmptyWorkingSet(h)) trimmed++; else denied++;
                Native.CloseHandle(h);
            }

            bool purged = false;
            string purgeError = null;
            if (standby)
            {
                if (!elevated) purgeError = "admin";
                else if (!Native.EnablePrivilege("SeProfileSingleProcessPrivilege")) purgeError = "privilege";
                else
                {
                    int flushModified = 3, purgeStandby = 4;
                    Native.NtSetSystemInformation(80, ref flushModified, 4);
                    int st = Native.NtSetSystemInformation(80, ref purgeStandby, 4);
                    purged = st == 0;
                    if (!purged) purgeError = "ntstatus:" + st.ToString("X");
                }
            }

            System.Threading.Thread.Sleep(350);
            ulong after = Native.MemStatus().ullAvailPhys;
            return J.D(
                "before", (long)before,
                "after", (long)after,
                "freed", after > before ? (long)(after - before) : 0L,
                "trimmed", trimmed,
                "denied", denied,
                "standbyPurged", purged,
                "standbyError", purgeError,
                "elevated", elevated);
        }
    }

    static class MemoryInfo
    {
        static readonly Dictionary<string, string> Jedec = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "80CE", "Samsung" }, { "CE00", "Samsung" }, { "CE", "Samsung" }, { "802C", "Micron" }, { "2C00", "Micron" }, { "2C", "Micron" },
            { "80AD", "SK hynix" }, { "AD00", "SK hynix" }, { "AD", "SK hynix" }, { "859B", "Crucial" }, { "9B05", "Crucial" }, { "04CB", "ADATA" },
            { "CB04", "ADATA" }, { "029E", "Corsair" }, { "9E02", "Corsair" }, { "04CD", "G.Skill" }, { "CD04", "G.Skill" }, { "0198", "Kingston" },
            { "9801", "Kingston" }, { "0BAD", "Patriot" }, { "8551", "Qimonda" }, { "01BA", "PNY" }, { "BA01", "PNY" }, { "83CB", "Teamgroup" }, { "EF", "Team" }
        };

        static string DecodeManufacturer(string m)
        {
            m = (m ?? "").Trim();
            string key = m.Replace(" ", "");
            if (key.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) key = key.Substring(2);
            if (key.Length > 4) key = key.TrimEnd('0');
            string name;
            if (Jedec.TryGetValue(key, out name)) return name;
            if (m.Length == 0 || m.Equals("Unknown", StringComparison.OrdinalIgnoreCase) || m.StartsWith("Manufacturer", StringComparison.OrdinalIgnoreCase)) return "Unknown";
            return m;
        }

        static string TypeName(int smbios, int legacy)
        {
            switch (smbios)
            {
                case 20: return "DDR";
                case 21: return "DDR2";
                case 22: return "DDR2 FB-DIMM";
                case 24: return "DDR3";
                case 26: return "DDR4";
                case 27: return "LPDDR";
                case 28: return "LPDDR2";
                case 29: return "LPDDR3";
                case 30: return "LPDDR4";
                case 34: return "DDR5";
                case 35: return "LPDDR5";
            }
            switch (legacy)
            {
                case 20: return "DDR";
                case 21: return "DDR2";
                case 24: return "DDR3";
                case 26: return "DDR4";
            }
            return null;
        }

        static string FormName(int f)
        {
            switch (f)
            {
                case 8: return "DIMM";
                case 12: return "SO-DIMM";
                case 11: return "Soldered";
                case 13: return "TSOP";
            }
            return null;
        }

        public static object Get()
        {
            var modules = new List<object>();
            int slots = 0;
            long maxKb = 0;
            long installed = 0;
            bool anySoldered = false, anySocketed = false, unknownForm = false;
            int solderedCount = 0;
            long solderedBytes = 0;
            string cpuName = "";
            string typeLabel = null;
            int speed = 0;

            SystemInfo.Wmi("Win32_PhysicalMemory", o =>
            {
                long cap = Convert.ToInt64(o["Capacity"] ?? 0L);
                int smbiosType = Convert.ToInt32(o["SMBIOSMemoryType"] ?? 0);
                int legacy = Convert.ToInt32(o["MemoryType"] ?? 0);
                int form = Convert.ToInt32(o["FormFactor"] ?? 0);
                int spd = Convert.ToInt32(o["Speed"] ?? 0);
                int configured = Convert.ToInt32(o["ConfiguredClockSpeed"] ?? 0);
                int voltage = 0;
                try { voltage = Convert.ToInt32(o["ConfiguredVoltage"] ?? 0); } catch { }
                string locator = SystemInfo.Str(o["DeviceLocator"]);
                string bank = SystemInfo.Str(o["BankLabel"]);
                string part = SystemInfo.Str(o["PartNumber"]);
                string type = TypeName(smbiosType, legacy);
                string formName = FormName(form);
                bool lp = type != null && type.StartsWith("LP");
                bool onboard = locator.IndexOf("onboard", StringComparison.OrdinalIgnoreCase) >= 0 || locator.IndexOf("soldered", StringComparison.OrdinalIgnoreCase) >= 0 || form == 11;
                bool soldered = lp || onboard;
                if (soldered)
                {
                    anySoldered = true;
                    solderedCount++;
                    solderedBytes += cap;
                }
                else if (form == 8 || form == 12) anySocketed = true;
                else unknownForm = true;

                installed += cap;
                if (type != null) typeLabel = type;
                if (spd > speed) speed = spd;

                modules.Add(J.D(
                    "slot", locator,
                    "bank", bank,
                    "manufacturer", DecodeManufacturer(SystemInfo.Str(o["Manufacturer"])),
                    "partNumber", part,
                    "serial", null,
                    "capacity", cap,
                    "type", type,
                    "form", soldered && formName == null ? "Soldered" : formName,
                    "speed", spd,
                    "configuredSpeed", configured,
                    "voltage", voltage > 0 ? (object)(voltage / 1000.0) : null,
                    "soldered", soldered));
            });

            SystemInfo.Wmi("Win32_PhysicalMemoryArray", o =>
            {
                int use = Convert.ToInt32(o["Use"] ?? 3);
                if (use != 3 && use != 0) return; // system memory only
                slots += Convert.ToInt32(o["MemoryDevices"] ?? 0);
                long kb = 0;
                try { kb = Convert.ToInt64(o["MaxCapacityEx"] ?? 0L); } catch { }
                if (kb == 0) kb = Convert.ToInt64(o["MaxCapacity"] ?? 0L);
                maxKb += kb;
            });

            int used = modules.Count;
            if (slots < used) slots = used;
            int freeSlots = slots - used;
            long biosBytes = maxKb * 1024;
            SystemInfo.Wmi("Win32_Processor", o => { cpuName = SystemInfo.Str(o["Name"]).Replace("(R)", "").Replace("(TM)", "").Trim(); });
            var limit = RamLimits.Compute(cpuName, typeLabel, slots, solderedCount, solderedBytes, biosBytes, installed);
            long maxBytes = limit.MaxBytes;
            string maxConfig = null;

            string verdict, title;
            var details = new List<object>();
            if (anySoldered && !anySocketed)
            {
                verdict = "no";
                title = "This RAM can't be upgraded";
                details.Add("The memory is soldered to the motherboard" + (typeLabel != null && typeLabel.StartsWith("LP") ? " (" + typeLabel + " always is)." : "."));
                details.Add("Capacity stays as it is for the life of this device.");
            }
            else if (anySoldered)
            {
                verdict = freeSlots > 0 ? "yes" : "replace";
                title = freeSlots > 0 ? "You can add more RAM" : "Partial upgrade possible";
                details.Add("Part of the memory is soldered, but there is also a slot" + (freeSlots > 0 ? " that is free." : " in use that can be replaced."));
            }
            else if (!anySocketed && unknownForm)
            {
                verdict = "unknown";
                title = "Can't tell for sure";
                details.Add("The BIOS doesn't report the physical module type. Check the manufacturer's manual.");
            }
            else if (freeSlots > 0)
            {
                verdict = "yes";
                title = "You can add more RAM";
                details.Add(freeSlots + (freeSlots == 1 ? " free slot" : " free slots") + " out of " + slots + ". You can add a module without removing the existing ones.");
            }
            else
            {
                verdict = "replace";
                title = "Yes, by replacing the modules";
                details.Add("All " + slots + " slots are in use. To get more RAM, replace the current modules with larger ones.");
            }

            if (verdict != "no" && verdict != "unknown" && typeLabel != null)
            {
                string form = null;
                foreach (Dictionary<string, object> m in modules)
                    if (m["soldered"] is bool && !(bool)m["soldered"] && m["form"] != null) form = (string)m["form"];
                details.Add("What to buy: " + typeLabel + (form != null ? " " + form : "") + (speed > 0 ? ", " + speed + " MT/s or faster." : "."));
            }
            const long GB = 1L << 30;
            if (verdict == "no")
            {
                maxBytes = installed;
            }
            else if (verdict != "unknown" && maxBytes > 0)
            {
                maxConfig = limit.SocketSlots + " x " + (limit.PerSlotBytes / GB) + " GB" + (solderedBytes > 0 ? " + " + (solderedBytes / GB) + " GB soldered" : "");
                if (limit.LimitedBy == "processor")
                    details.Add("The limit comes from the processor: the " + cpuName.Split('@')[0].Trim() + " supports up to " + limit.CpuGb + " GB." + (biosBytes > (long)limit.CpuGb.Value * GB ? " The BIOS lists " + (biosBytes / GB) + " GB, but the hardware can't use that much." : ""));
                else if (limit.LimitedBy == "modules")
                    details.Add("The limit comes from the slots: " + limit.SocketSlots + (limit.SocketSlots == 1 ? " slot" : " slots") + " and the largest " + typeLabel + " modules sold, " + (limit.PerSlotBytes / GB) + " GB each.");
                else
                    details.Add("The limit comes from the motherboard, which reports a maximum of " + (biosBytes / GB) + " GB.");
                details.Add("Makers sometimes publish a lower official limit, which is only what they tested. Check it before buying the largest modules.");
            }
            else if (verdict != "unknown" && biosBytes > 0)
            {
                maxBytes = biosBytes;
                details.Add("The BIOS reports a maximum of " + (biosBytes / GB) + " GB, but this processor isn't in G Ultra's list, so check the maker's manual.");
            }

            return J.D(
                "platform", "windows",
                "installed", installed,
                "type", typeLabel,
                "speed", speed,
                "slotsTotal", slots,
                "slotsUsed", used,
                "maxCapacity", maxBytes > 0 ? (object)maxBytes : null,
                "maxConfig", maxConfig,
                "maxSource", limit.LimitedBy,
                "dualChannel", used >= 2 ? (object)true : null,
                "modules", modules,
                "upgrade", J.D("verdict", verdict, "title", title, "details", details));
        }
    }
}
