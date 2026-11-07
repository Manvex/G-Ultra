using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Win32;

namespace GUltra
{
    // Battery-saving settings, through the same Windows power APIs the Settings app uses.
    // Each one applies only on battery and can be changed back at any time.
    static class BatteryService
    {
        [DllImport("powrprof.dll")] static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);
        [DllImport("powrprof.dll")] static extern uint PowerSetActiveScheme(IntPtr root, ref Guid scheme);
        [DllImport("powrprof.dll")] static extern uint PowerReadDCValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, out uint value);
        [DllImport("powrprof.dll")] static extern uint PowerWriteDCValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, uint value);
        [DllImport("powrprof.dll")] static extern uint PowerReadACValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, out uint value);
        [DllImport("powrprof.dll")] static extern uint PowerWriteACValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, uint value);
        [DllImport("powrprof.dll", EntryPoint = "PowerGetActualOverlayScheme")] static extern uint GetOverlay(out Guid overlay);
        [DllImport("powrprof.dll", EntryPoint = "PowerSetActiveOverlayScheme")] static extern uint SetOverlay(Guid overlay);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

        [StructLayout(LayoutKind.Sequential)]
        struct SYSTEM_POWER_STATUS
        {
            public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
            public int BatteryLifeTime, BatteryFullLifeTime;
        }

        [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
        struct DEVMODE
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
            public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
            public uint dmFields;
            public int dmPositionX, dmPositionY;
            public uint dmDisplayOrientation, dmDisplayFixedOutput;
            public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
            public ushort dmLogPixels;
            public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
            public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
        }

        [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
        [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);

        const int ENUM_CURRENT_SETTINGS = -1;
        const uint DM_DISPLAYFREQUENCY = 0x400000;
        const uint CDS_UPDATEREGISTRY = 1;

        static readonly Guid SubVideo = new Guid("7516b95f-f776-4464-8c53-06167f40cc99");
        static readonly Guid VideoIdle = new Guid("3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e");
        static readonly Guid SubSleep = new Guid("238c9fa8-0aad-41ed-83f4-97be242c8f20");
        static readonly Guid StandbyIdle = new Guid("29f6c1db-86da-48c5-9fdb-f2b67b1f44da");
        static readonly Guid SubProcessor = new Guid("54533251-82be-4824-96c1-47b60b740d00");
        static readonly Guid ThrottleMax = new Guid("bc5038f7-23e0-4960-96da-33abaf5935ec");
        static readonly Guid SubSaver = new Guid("de830923-a562-41af-a086-e3a2c6bad2da");
        static readonly Guid SaverThreshold = new Guid("e69653ca-cf7f-4f05-aa73-cb833fa90ad4");

        // Windows power modes. These aren't in the public headers, but they haven't changed since Windows 10.
        static readonly Guid ModeEfficiency = new Guid("961cc777-2547-4f9d-8174-7d86181b8a7a");
        static readonly Guid ModeBalanced = Guid.Empty;
        static readonly Guid ModePerformance = new Guid("ded574b5-45a0-4f42-8737-46345c09c238");

        static Guid ActiveScheme()
        {
            IntPtr p;
            if (PowerGetActiveScheme(IntPtr.Zero, out p) != 0) throw new Exception("Couldn't read the power plan.");
            try { return (Guid)Marshal.PtrToStructure(p, typeof(Guid)); }
            finally { LocalFree(p); }
        }

        static object ReadDc(Guid sub, Guid setting)
        {
            try
            {
                Guid scheme = ActiveScheme();
                uint value;
                Guid s = sub, g = setting;
                if (PowerReadDCValueIndex(IntPtr.Zero, ref scheme, ref s, ref g, out value) != 0) return null;
                return (long)value;
            }
            catch { return null; }
        }

        static void WriteDc(Guid sub, Guid setting, uint value)
        {
            Guid scheme = ActiveScheme();
            Guid s = sub, g = setting;
            uint st = PowerWriteDCValueIndex(IntPtr.Zero, ref scheme, ref s, ref g, value);
            if (st != 0) throw new Exception("Windows refused this power setting (code " + st + ").");
            PowerSetActiveScheme(IntPtr.Zero, ref scheme);
        }

        static string PowerMode()
        {
            try
            {
                Guid g;
                if (GetOverlay(out g) != 0) return null;
                if (g == ModeEfficiency) return "efficiency";
                if (g == ModePerformance) return "performance";
                return "balanced";
            }
            catch { return null; }
        }

        static object Brightness()
        {
            object result = null;
            SystemInfo.WmiNs(@"root\wmi", "SELECT CurrentBrightness FROM WmiMonitorBrightness", o =>
            {
                if (result == null) result = Convert.ToInt32(o["CurrentBrightness"]);
            });
            return result;
        }

        static void SetBrightness(int percent)
        {
            bool done = false;
            string error = null;
            SystemInfo.WmiNs(@"root\wmi", "SELECT * FROM WmiMonitorBrightnessMethods", o =>
            {
                try
                {
                    ((ManagementObject)o).InvokeMethod("WmiSetBrightness", new object[] { (uint)1, (byte)percent });
                    done = true;
                }
                catch (Exception ex) { error = ex.Message; }
            });
            if (!done) throw new Exception(error ?? "This screen's brightness can't be set from Windows.");
        }

        static DEVMODE NewMode()
        {
            var dm = new DEVMODE();
            dm.dmDeviceName = new string('\0', 32);
            dm.dmFormName = new string('\0', 32);
            dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
            return dm;
        }

        static object RefreshInfo()
        {
            var current = NewMode();
            if (!EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref current)) return null;
            var rates = new SortedSet<int>();
            for (int i = 0; ; i++)
            {
                var dm = NewMode();
                if (!EnumDisplaySettings(null, i, ref dm)) break;
                if (dm.dmPelsWidth == current.dmPelsWidth && dm.dmPelsHeight == current.dmPelsHeight && dm.dmBitsPerPel == current.dmBitsPerPel && dm.dmDisplayFrequency > 1)
                    rates.Add((int)dm.dmDisplayFrequency);
            }
            return J.D("current", (int)current.dmDisplayFrequency, "options", rates.Cast<object>().ToList());
        }

        static void SetRefresh(int hz)
        {
            var dm = NewMode();
            if (!EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref dm)) throw new Exception("Couldn't read the display mode.");
            dm.dmDisplayFrequency = (uint)hz;
            dm.dmFields = DM_DISPLAYFREQUENCY;
            int st = ChangeDisplaySettingsEx(null, ref dm, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero);
            if (st != 0) throw new Exception("This display refused " + hz + " Hz.");
        }

        public static object Info()
        {
            SYSTEM_POWER_STATUS ps;
            GetSystemPowerStatus(out ps);
            var health = BatteryInfo.Health() as Dictionary<string, object>;
            var live = BatteryInfo.LiveStatus() as Dictionary<string, object>;
            return J.D(
                "present", health != null,
                "percent", live != null ? live["percent"] : null,
                "charging", live != null && (bool)live["charging"],
                "onAc", ps.ACLineStatus == 1,
                "watts", live != null ? live["watts"] : null,
                "secondsLeft", ps.BatteryLifeTime > 0 ? (object)ps.BatteryLifeTime : null,
                "saverOn", (ps.SystemStatusFlag & 1) != 0,
                "saverThreshold", ReadDc(SubSaver, SaverThreshold),
                "powerMode", PowerMode(),
                "brightness", Brightness(),
                "screenOffSec", ReadDc(SubVideo, VideoIdle),
                "sleepSec", ReadDc(SubSleep, StandbyIdle),
                "cpuMax", ReadDc(SubProcessor, ThrottleMax),
                "refresh", RefreshInfo(),
                "health", health);
        }

        public static object Set(string key, double value)
        {
            switch (key)
            {
                case "powerMode":
                    Guid mode = value == 0 ? ModeEfficiency : value == 2 ? ModePerformance : ModeBalanced;
                    uint st = SetOverlay(mode);
                    if (st != 0) throw new Exception("Windows refused the power mode (code " + st + ").");
                    break;
                case "saverThreshold":
                    WriteDc(SubSaver, SaverThreshold, (uint)Clamp(value, 0, 100));
                    break;
                case "screenOff":
                    WriteDc(SubVideo, VideoIdle, (uint)Clamp(value, 0, 86400));
                    break;
                case "sleep":
                    WriteDc(SubSleep, StandbyIdle, (uint)Clamp(value, 0, 86400));
                    break;
                case "cpuMax":
                    // Never below 50%: lower makes the computer painfully slow.
                    WriteDc(SubProcessor, ThrottleMax, (uint)Clamp(value, 50, 100));
                    break;
                case "brightness":
                    SetBrightness((int)Clamp(value, 0, 100));
                    break;
                case "refreshRate":
                    SetRefresh((int)value);
                    break;
                default:
                    throw new Exception("Unknown setting.");
            }
            return J.D("ok", true);
        }

        static double Clamp(double v, double lo, double hi)
        {
            return Math.Max(lo, Math.Min(hi, v));
        }

        // ---- used by the CPU cooling settings ----
        public static Guid ActivePlan()
        {
            return ActiveScheme();
        }

        public static void ActivatePlan()
        {
            Guid scheme = ActiveScheme();
            PowerSetActiveScheme(IntPtr.Zero, ref scheme);
        }

        public static bool ReadProcessor(Guid plan, Guid setting, out uint ac, out uint dc)
        {
            ac = dc = 0;
            Guid s = SubProcessor, g = setting;
            return PowerReadACValueIndex(IntPtr.Zero, ref plan, ref s, ref g, out ac) == 0 && PowerReadDCValueIndex(IntPtr.Zero, ref plan, ref s, ref g, out dc) == 0;
        }

        public static void WriteProcessor(Guid plan, Guid setting, uint ac, uint dc)
        {
            Guid s = SubProcessor, g = setting;
            uint st = PowerWriteACValueIndex(IntPtr.Zero, ref plan, ref s, ref g, ac);
            if (st == 0) st = PowerWriteDCValueIndex(IntPtr.Zero, ref plan, ref s, ref g, dc);
            if (st != 0) throw new Exception("Windows refused this power setting (code " + st + ").");
        }

        // ---- used by the temperature and battery rules ----
        public static int[] GetCpuLimits()
        {
            try
            {
                Guid scheme = ActiveScheme();
                Guid s = SubProcessor, g = ThrottleMax;
                uint ac, dc;
                if (PowerReadACValueIndex(IntPtr.Zero, ref scheme, ref s, ref g, out ac) != 0) return null;
                if (PowerReadDCValueIndex(IntPtr.Zero, ref scheme, ref s, ref g, out dc) != 0) return null;
                return new[] { (int)ac, (int)dc };
            }
            catch { return null; }
        }

        public static void SetCpuLimits(int percent)
        {
            SetCpuLimits(percent, percent);
        }

        public static void SetCpuLimits(int ac, int dc)
        {
            Guid scheme = ActiveScheme();
            Guid s = SubProcessor, g = ThrottleMax;
            PowerWriteACValueIndex(IntPtr.Zero, ref scheme, ref s, ref g, (uint)Clamp(ac, 50, 100));
            PowerWriteDCValueIndex(IntPtr.Zero, ref scheme, ref s, ref g, (uint)Clamp(dc, 50, 100));
            PowerSetActiveScheme(IntPtr.Zero, ref scheme);
        }

        public static string GetPowerMode()
        {
            return PowerMode();
        }

        public static void SetPowerMode(string mode)
        {
            SetOverlay(mode == "efficiency" ? ModeEfficiency : mode == "performance" ? ModePerformance : ModeBalanced);
        }

        // ---- capacity history, from the Windows battery report ----
        static object _report;
        static DateTime _reportAt = DateTime.MinValue;
        static readonly object ReportLock = new object();

        public static object Report()
        {
            lock (ReportLock)
            {
                if (_report != null && (DateTime.UtcNow - _reportAt).TotalMinutes < 10) return _report;
                _report = BuildReport();
                _reportAt = DateTime.UtcNow;
                return _report;
            }
        }

        static object BuildReport()
        {
            string path = Path.Combine(Path.GetTempPath(), "gultra-battery-" + Guid.NewGuid().ToString("N") + ".xml");
            try
            {
                var psi = new ProcessStartInfo("powercfg.exe", "/batteryreport /xml /output \"" + path + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (var p = Process.Start(psi))
                {
                    p.OutputDataReceived += (s, e) => { };
                    p.ErrorDataReceived += (s, e) => { };
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    if (!p.WaitForExit(20000))
                    {
                        try { p.Kill(); } catch { }
                        return null;
                    }
                }
                if (!File.Exists(path)) return null;

                XDocument doc = XDocument.Load(path);
                XNamespace ns = "http://schemas.microsoft.com/battery/2012";
                XElement battery = doc.Root.Descendants(ns + "Battery").FirstOrDefault();
                Func<string, string> field = name =>
                {
                    XElement e = battery == null ? null : battery.Element(ns + name);
                    return e == null ? null : e.Value.Trim();
                };

                var entries = doc.Root.Descendants(ns + "HistoryEntry").ToList();
                // A swapped battery starts its history again.
                int lastSwap = entries.FindLastIndex(e => (string)e.Attribute("BatteryChanged") == "1");
                if (lastSwap > 0) entries = entries.Skip(lastSwap).ToList();

                var points = new List<KeyValuePair<DateTime, double>>();
                double design = 0;
                TimeSpan runtime = TimeSpan.Zero;
                TimeSpan designRuntime = TimeSpan.Zero;
                foreach (XElement e in entries)
                {
                    DateTime date;
                    double full;
                    string dateText = (string)e.Attribute("LocalStartDate") ?? (string)e.Attribute("StartDate");
                    if (!DateTime.TryParse(dateText, CultureInfo.InvariantCulture, DateTimeStyles.None, out date)) continue;
                    if (!double.TryParse((string)e.Attribute("FullChargeCapacity"), NumberStyles.Float, CultureInfo.InvariantCulture, out full) || full <= 0) continue;
                    double d;
                    if (double.TryParse((string)e.Attribute("DesignCapacity"), NumberStyles.Float, CultureInfo.InvariantCulture, out d) && d > 0) design = d;
                    points.Add(new KeyValuePair<DateTime, double>(date, full));
                    TimeSpan t = Duration((string)e.Attribute("EstimatedFullChargeActiveTime"));
                    if (t > TimeSpan.Zero) runtime = t;
                    t = Duration((string)e.Attribute("EstimatedDesignActiveTime"));
                    if (t > TimeSpan.Zero) designRuntime = t;
                }

                object wearPerYear = null;
                object yearsTo60 = null;
                if (points.Count >= 2 && design > 0)
                {
                    double days = (points[points.Count - 1].Key - points[0].Key).TotalDays;
                    double lost = (points[0].Value - points[points.Count - 1].Value) / design * 100;
                    // Too short a span says nothing about the long-term trend.
                    if (days >= 45 && lost > 0)
                    {
                        double perYear = lost / days * 365;
                        wearPerYear = Math.Round(perYear, 1);
                        double nowPct = points[points.Count - 1].Value / design * 100;
                        if (nowPct > 60) yearsTo60 = Math.Round((nowPct - 60) / perYear, 1);
                    }
                }

                return J.D(
                    "history", points.Select(p => (object)J.D("date", p.Key.ToString("yyyy-MM-dd"), "full", p.Value)).ToList(),
                    "design", design,
                    "cycles", ParseLong(field("CycleCount")),
                    "manufacturer", field("Manufacturer"),
                    "serial", field("SerialNumber"),
                    "id", field("Id"),
                    "chemistry", field("Chemistry"),
                    "manufactureDate", field("ManufactureDate"),
                    "runtimeSec", runtime > TimeSpan.Zero ? (object)(long)runtime.TotalSeconds : null,
                    "designRuntimeSec", designRuntime > TimeSpan.Zero ? (object)(long)designRuntime.TotalSeconds : null,
                    "wearPerYear", wearPerYear,
                    "yearsTo60", yearsTo60);
            }
            catch { return null; }
            finally
            {
                try { File.Delete(path); } catch { }
            }
        }

        static TimeSpan Duration(string iso)
        {
            if (string.IsNullOrEmpty(iso)) return TimeSpan.Zero;
            try { return XmlConvert.ToTimeSpan(iso); }
            catch { return TimeSpan.Zero; }
        }

        static object ParseLong(string s)
        {
            long v;
            return long.TryParse(s, out v) && v > 0 ? (object)v : null;
        }

        // ---- apps that start with Windows ----
        // Same switch Task Manager uses: entries stay in place and are only marked on or off.
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunKey32 = @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";
        const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\";

        class StartupEntry
        {
            public string Id, Name, Path;
            public RegistryKey Hive;
            public string Approved;
        }

        static List<StartupEntry> StartupEntries()
        {
            var list = new List<StartupEntry>();
            Action<RegistryKey, string, string, string> fromRun = (hive, tag, key, approved) =>
            {
                using (var k = hive.OpenSubKey(key))
                {
                    if (k == null) return;
                    foreach (string name in k.GetValueNames())
                    {
                        if (name.Length == 0) continue;
                        list.Add(new StartupEntry { Id = tag + "|" + name, Name = name, Path = ExeFromCommand(k.GetValue(name) as string), Hive = hive, Approved = approved });
                    }
                }
            };
            fromRun(Registry.CurrentUser, "user", RunKey, "Run");
            fromRun(Registry.LocalMachine, "machine", RunKey, "Run");
            fromRun(Registry.LocalMachine, "machine32", RunKey32, "Run32");

            Action<RegistryKey, string, Environment.SpecialFolder> fromFolder = (hive, tag, folder) =>
            {
                string dir = Environment.GetFolderPath(folder);
                if (!Directory.Exists(dir)) return;
                foreach (string file in Directory.GetFiles(dir))
                {
                    string name = Path.GetFileName(file);
                    if (name.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase)) continue;
                    list.Add(new StartupEntry { Id = tag + "|" + name, Name = name, Path = file, Hive = hive, Approved = "StartupFolder" });
                }
            };
            fromFolder(Registry.CurrentUser, "userFolder", Environment.SpecialFolder.Startup);
            fromFolder(Registry.LocalMachine, "machineFolder", Environment.SpecialFolder.CommonStartup);
            return list;
        }

        static string ExeFromCommand(string command)
        {
            if (string.IsNullOrWhiteSpace(command)) return null;
            string c = Environment.ExpandEnvironmentVariables(command.Trim());
            if (c.StartsWith("\""))
            {
                int end = c.IndexOf('"', 1);
                return end > 1 ? c.Substring(1, end - 1) : null;
            }
            int exe = c.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            return exe > 0 ? c.Substring(0, exe + 4) : c.Split(' ')[0];
        }

        static bool IsEnabled(StartupEntry e)
        {
            using (var k = e.Hive.OpenSubKey(ApprovedKey + e.Approved))
            {
                byte[] v = k == null ? null : k.GetValue(e.Name) as byte[];
                return v == null || v.Length == 0 || (v[0] & 1) == 0;
            }
        }

        public static object StartupList()
        {
            return StartupEntries().Select(e =>
            {
                string title = e.Name;
                if (e.Path != null && e.Path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(e.Path))
                {
                    try
                    {
                        string desc = (FileVersionInfo.GetVersionInfo(e.Path).FileDescription ?? "").Trim();
                        if (desc.Length > 1 && desc.Length < 48) title = desc;
                    }
                    catch { }
                }
                else if (title.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
                {
                    title = title.Substring(0, title.Length - 4);
                }
                return (object)J.D("id", e.Id, "title", title, "path", e.Path, "enabled", IsEnabled(e), "needsAdmin", e.Hive == Registry.LocalMachine && !SystemInfo.IsElevated());
            }).ToList();
        }

        public static object StartupSet(string id, bool on)
        {
            StartupEntry entry = StartupEntries().FirstOrDefault(e => e.Id == id);
            if (entry == null) throw new Exception("That startup app is no longer there.");
            try
            {
                using (var k = entry.Hive.CreateSubKey(ApprovedKey + entry.Approved))
                {
                    var value = new byte[12];
                    value[0] = on ? (byte)2 : (byte)3;
                    if (!on) BitConverter.GetBytes(DateTime.UtcNow.ToFileTimeUtc()).CopyTo(value, 4);
                    k.SetValue(entry.Name, value, RegistryValueKind.Binary);
                }
            }
            catch (UnauthorizedAccessException)
            {
                throw new Exception("Changing this one needs full mode.");
            }
            return J.D("ok", true);
        }
    }
}
