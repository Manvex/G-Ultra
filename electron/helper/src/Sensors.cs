using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using LibreHardwareMonitor.Hardware;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace GUltra
{
    class HardwareSample
    {
        public List<object> Sensors = new List<object>();
        public List<object> Gpus = new List<object>();
    }

    // Temperatures come from three sources, each labelled in the data:
    //  - LibreHardwareMonitor: the real CPU/GPU sensors (the CPU needs admin + the PawnIO driver)
    //  - ACPI thermal zones: need no privileges, but are approximate and not the CPU sensor
    //  - battery and NVMe, read directly
    static class Sensors
    {
        static readonly object Lock = new object();
        static LhmHost _lhm;
        static bool _started;
        static string _lhmError;
        static int _cpuSensorCount;

        /** In economy mode the library stays unloaded unless a rule needs it. */
        public static volatile bool LhmWanted = true;

        static void EnsureStarted()
        {
            lock (Lock)
            {
                if (_started) return;
                _started = true;
            }
            var t = new Thread(OpenLhm);
            t.IsBackground = true;
            t.Start();
        }

        // Kept in its own method: if the DLL is missing the failure stays here and the helper keeps running.
        static void OpenLhm()
        {
            try
            {
                var host = new LhmHost();
                host.Open();
                lock (Lock)
                {
                    _lhm = host;
                    _lhmError = null;
                }
            }
            catch (Exception ex)
            {
                lock (Lock) _lhmError = ex.GetType().Name + ": " + ex.Message;
            }
        }

        // The driver is picked up when the library opens, so a fresh install needs a reopen.
        public static object Reload()
        {
            Shutdown();
            lock (Lock) _cpuSensorCount = 0;
            OpenLhm();
            return DriverState();
        }

        public static void Shutdown()
        {
            LhmHost host;
            lock (Lock)
            {
                host = _lhm;
                _lhm = null;
            }
            if (host != null)
            {
                lock (Hw.Lock)
                {
                    try { host.Close(); } catch { }
                }
            }
        }

        public static bool PawnIoInstalled()
        {
            try
            {
                using (var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO"))
                    if (k != null) return true;
                using (var k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\PawnIO"))
                    if (k != null) return true;
                string lib = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"PawnIO\PawnIOLib.dll");
                return File.Exists(lib);
            }
            catch { return false; }
        }

        public static object DriverState()
        {
            int cpu;
            string err;
            bool loaded;
            lock (Lock) { cpu = _cpuSensorCount; err = _lhmError; loaded = _lhm != null; }
            return J.D(
                "installed", PawnIoInstalled(),
                "elevated", SystemInfo.IsElevated(),
                "cpuSensors", cpu,
                "libLoaded", loaded,
                "error", err);
        }

        public static HardwareSample Read(Dictionary<string, double> zones)
        {
            if (LhmWanted) EnsureStarted();
            var sample = new HardwareSample();
            var fans = new List<IFanControl>();
            double? hottest = null;

            LhmHost host;
            lock (Lock) host = _lhm;
            if (host != null)
            {
                try
                {
                    int cpu = host.Collect(sample, fans, ref hottest);
                    lock (Lock) _cpuSensorCount = cpu;
                }
                catch (Exception ex) { lock (Lock) _lhmError = ex.Message; }
                Fans.Update(fans);
                Fans.Watchdog(hottest);
            }

            foreach (var z in zones.OrderBy(k => k.Key))
            {
                double c = z.Value - 273.15;
                // Some zones report impossible fixed values, such as 10 °C inside a running laptop.
                if (c < 20 || c > 115) continue;
                sample.Sensors.Add(Sensor("acpi:" + z.Key, "Thermal zone " + z.Key.ToUpperInvariant().Replace(@"\_TZ.", ""), "board", J.R(c, 1), "acpi", true));
            }

            double? bat = BatteryInfo.Temperature();
            if (bat.HasValue) sample.Sensors.Add(Sensor("battery", "Battery", "battery", J.R(bat.Value, 1), "battery", false));

            foreach (var d in NvmeSmart.Temperatures())
                sample.Sensors.Add(Sensor("disk:" + d.Key, d.Key, "storage", d.Value, "smart", false));

            return sample;
        }

        public static object Sensor(string id, string name, string group, double c, string source, bool approx)
        {
            return J.D("id", id, "name", name, "group", group, "celsius", c, "source", source, "approximate", approx);
        }
    }

    class LhmFan : IFanControl
    {
        readonly ISensor _control;
        readonly ISensor _rpm;
        readonly string _hardware;
        readonly string _group;

        public LhmFan(ISensor control, ISensor rpm, string hardware, string group)
        {
            _control = control;
            _rpm = rpm;
            _hardware = hardware;
            _group = group;
        }

        public string Id { get { return (_control ?? _rpm).Identifier.ToString(); } }
        public string Name { get { return (_rpm ?? _control).Name.Replace(" Control", "").Replace("#", "").Trim(); } }
        public string Hardware { get { return _hardware; } }
        public string Group { get { return _group; } }
        public double? Rpm { get { return _rpm != null && _rpm.Value.HasValue ? (double?)_rpm.Value.Value : null; } }
        public double? Percent { get { return _control != null && _control.Value.HasValue ? (double?)_control.Value.Value : null; } }
        public bool CanControl { get { return _control != null && _control.Control != null; } }
        public bool IsManual { get { return CanControl && _control.Control.ControlMode == ControlMode.Software; } }
        public float MinPercent { get { return CanControl ? _control.Control.MinSoftwareValue : 0f; } }
        public float MaxPercent { get { return CanControl ? _control.Control.MaxSoftwareValue : 0f; } }
        public void Set(float percent) { _control.Control.SetSoftware(percent); }
        public void Auto() { _control.Control.SetDefault(); }
    }

    class LhmHost
    {
        readonly Computer _pc = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMotherboardEnabled = true,
            IsMemoryEnabled = true,
            // USB fan and pump controllers (Corsair, NZXT, Aquacomputer...).
            IsControllerEnabled = true,
            IsStorageEnabled = false,
            IsNetworkEnabled = false,
        };

        public void Open() { _pc.Open(); }
        public void Close() { _pc.Close(); }

        // Returns how many real processor sensors were found.
        public int Collect(HardwareSample sample, List<IFanControl> fans, ref double? hottest)
        {
            int cpuCount = 0;
            lock (Hw.Lock)
            {
                foreach (IHardware hw in _pc.Hardware)
                {
                    hw.Update();
                    cpuCount += Walk(hw, hw, sample, fans, ref hottest);
                    foreach (IHardware sub in hw.SubHardware)
                    {
                        sub.Update();
                        cpuCount += Walk(hw, sub, sample, fans, ref hottest);
                    }
                    if (GroupOf(hw.HardwareType) == "gpu") sample.Gpus.Add(GpuMetrics(hw));
                }
            }
            return cpuCount;
        }

        static int Walk(IHardware top, IHardware hw, HardwareSample sample, List<IFanControl> fans, ref double? hottest)
        {
            int cpu = 0;
            string group = GroupOf(top.HardwareType);
            foreach (ISensor s in hw.Sensors)
            {
                if (s.SensorType != SensorType.Temperature || s.Value == null) continue;
                double v = s.Value.Value;
                if (s.Name.IndexOf("Distance", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                if (v <= 0 || v > 150) continue;
                if (group == "cpu") cpu++;
                if ((group == "cpu" || group == "gpu") && (!hottest.HasValue || v > hottest.Value)) hottest = v;
                sample.Sensors.Add(Sensors.Sensor("lhm:" + s.Identifier, NameOf(group, hw, s.Name), group, Math.Round(v, 1), "lhm", false));
            }

            // Pair each fan speed reading with its control channel, when there is one.
            var controls = hw.Sensors.Where(x => x.SensorType == SensorType.Control).ToList();
            var speeds = hw.Sensors.Where(x => x.SensorType == SensorType.Fan).ToList();
            var usedControls = new HashSet<ISensor>();
            foreach (ISensor rpm in speeds)
            {
                ISensor reading = rpm;
                ISensor control = controls.FirstOrDefault(c => c.Index == reading.Index && !usedControls.Contains(c));
                // A fan that reports 0 RPM and has no control channel isn't connected.
                if (control == null && (rpm.Value == null || rpm.Value.Value <= 0)) continue;
                if (control != null) usedControls.Add(control);
                fans.Add(new LhmFan(control, rpm, hw.Name, group));
            }
            foreach (ISensor control in controls)
            {
                if (usedControls.Contains(control) || control.Control == null) continue;
                fans.Add(new LhmFan(control, null, hw.Name, group));
            }
            return cpu;
        }

        static object GpuMetrics(IHardware hw)
        {
            string vendor = hw.HardwareType == HardwareType.GpuNvidia ? "nvidia" : hw.HardwareType == HardwareType.GpuAmd ? "amd" : "intel";
            var all = hw.Sensors.Concat(hw.SubHardware.SelectMany(x => x.Sensors)).Where(s => s.Value != null).ToList();
            Func<SensorType, string[], double?> pick = (type, names) =>
            {
                foreach (string name in names)
                {
                    string wanted = name;
                    var s = all.FirstOrDefault(x => x.SensorType == type && x.Name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0);
                    if (s != null) return Math.Round((double)s.Value.Value, 1);
                }
                return null;
            };
            double? load = pick(SensorType.Load, new[] { "GPU Core", "D3D 3D", "3D" });
            if (!load.HasValue)
            {
                var loads = all.Where(s => s.SensorType == SensorType.Load).ToList();
                if (loads.Count > 0) load = Math.Round((double)loads.Max(s => s.Value.Value), 1);
            }
            double? vramUsed = pick(SensorType.SmallData, new[] { "GPU Memory Used", "D3D Dedicated Memory Used", "D3D Shared Memory Used", "Memory Used" });
            double? vramTotal = pick(SensorType.SmallData, new[] { "GPU Memory Total", "D3D Dedicated Memory Total", "D3D Shared Memory Total", "Memory Total" });
            return J.D(
                "id", hw.Identifier.ToString(),
                "name", hw.Name,
                "vendor", vendor,
                "load", load,
                "coreMHz", pick(SensorType.Clock, new[] { "GPU Core", "Core" }),
                "memMHz", pick(SensorType.Clock, new[] { "GPU Memory", "Memory" }),
                "watts", pick(SensorType.Power, new[] { "GPU Package", "GPU Power", "Package", "Power", "GPU Core" }),
                "tempC", pick(SensorType.Temperature, new[] { "GPU Core", "Core" }),
                "hotspotC", pick(SensorType.Temperature, new[] { "Hot Spot", "Junction" }),
                "vramUsedMB", vramUsed,
                "vramTotalMB", vramTotal);
        }

        static string GroupOf(HardwareType t)
        {
            switch (t)
            {
                case HardwareType.Cpu: return "cpu";
                case HardwareType.GpuAmd:
                case HardwareType.GpuIntel:
                case HardwareType.GpuNvidia: return "gpu";
                case HardwareType.Memory: return "memory";
                case HardwareType.Storage: return "storage";
                default: return "board";
            }
        }

        static string NameOf(string group, IHardware hw, string name)
        {
            if (group == "cpu")
            {
                if (name.StartsWith("Core #")) return "Core " + name.Substring(6).Split(' ')[0];
                if (name == "Core Max") return "Hottest core";
                if (name == "Core Average") return "Core average";
                return name;
            }
            if (group == "gpu") return hw.Name + " · " + name.Replace("GPU ", "");
            if (group == "memory") return hw.Name;
            return name;
        }
    }

    // Battery data straight from the driver (IOCTL). Works without admin rights.
    static class BatteryInfo
    {
        static readonly Guid BatteryClass = new Guid("72631E54-78A4-11D0-BCF7-00AA00B7B32A");
        const uint IOCTL_BATTERY_QUERY_TAG = 0x294040;
        const uint IOCTL_BATTERY_QUERY_INFORMATION = 0x294044;
        const uint IOCTL_BATTERY_QUERY_STATUS = 0x29404C;

        static string _path;
        static bool _searched;
        static DateTime _tempAt = DateTime.MinValue;
        static double? _temp;

        static string DevicePath()
        {
            if (_searched) return _path;
            _searched = true;
            Guid cls = BatteryClass;
            IntPtr set = Native.SetupDiGetClassDevs(ref cls, null, IntPtr.Zero, 0x12); // PRESENT | DEVICEINTERFACE
            if (set == new IntPtr(-1)) return null;
            try
            {
                var data = new Native.SP_DEVICE_INTERFACE_DATA { cbSize = Marshal.SizeOf(typeof(Native.SP_DEVICE_INTERFACE_DATA)) };
                if (!Native.SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref cls, 0, ref data)) return null;
                int need;
                Native.SetupDiGetDeviceInterfaceDetail(set, ref data, IntPtr.Zero, 0, out need, IntPtr.Zero);
                IntPtr buf = Marshal.AllocHGlobal(need);
                try
                {
                    Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
                    if (Native.SetupDiGetDeviceInterfaceDetail(set, ref data, buf, need, out need, IntPtr.Zero))
                        _path = Marshal.PtrToStringUni(IntPtr.Add(buf, 4));
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            finally { Native.SetupDiDestroyDeviceInfoList(set); }
            return _path;
        }

        static SafeFileHandle Open()
        {
            string p = DevicePath();
            if (p == null) return null;
            var h = Native.CreateFile(p, Native.GENERIC_READ, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, IntPtr.Zero, Native.OPEN_EXISTING, 0x80, IntPtr.Zero);
            if (h.IsInvalid) { h.Dispose(); return null; }
            return h;
        }

        static uint Tag(SafeFileHandle h)
        {
            IntPtr inBuf = Marshal.AllocHGlobal(4), outBuf = Marshal.AllocHGlobal(4);
            try
            {
                Marshal.WriteInt32(inBuf, 0); // don't wait
                int ret;
                if (!Native.DeviceIoControl(h, IOCTL_BATTERY_QUERY_TAG, inBuf, 4, outBuf, 4, out ret, IntPtr.Zero)) return 0;
                return (uint)Marshal.ReadInt32(outBuf);
            }
            finally { Marshal.FreeHGlobal(inBuf); Marshal.FreeHGlobal(outBuf); }
        }

        // level: 0 = Information, 2 = Temperature, 4 = DeviceName, 6 = ManufactureName
        static byte[] Query(SafeFileHandle h, uint tag, int level, int outSize)
        {
            IntPtr inBuf = Marshal.AllocHGlobal(12), outBuf = Marshal.AllocHGlobal(outSize);
            try
            {
                Marshal.WriteInt32(inBuf, 0, (int)tag);
                Marshal.WriteInt32(inBuf, 4, level);
                Marshal.WriteInt32(inBuf, 8, 0);
                int ret;
                if (!Native.DeviceIoControl(h, IOCTL_BATTERY_QUERY_INFORMATION, inBuf, 12, outBuf, outSize, out ret, IntPtr.Zero)) return null;
                var bytes = new byte[ret];
                Marshal.Copy(outBuf, bytes, 0, ret);
                return bytes;
            }
            finally { Marshal.FreeHGlobal(inBuf); Marshal.FreeHGlobal(outBuf); }
        }

        public static double? Temperature()
        {
            if ((DateTime.UtcNow - _tempAt).TotalSeconds < 10) return _temp;
            _tempAt = DateTime.UtcNow;
            _temp = null;
            using (var h = Open())
            {
                if (h == null) return null;
                uint tag = Tag(h);
                if (tag == 0) return null;
                var b = Query(h, tag, 2, 4);
                if (b != null && b.Length >= 4)
                {
                    double c = BitConverter.ToUInt32(b, 0) / 10.0 - 273.15;
                    if (c > 0 && c < 100) _temp = c;
                }
            }
            return _temp;
        }

        public static object LiveStatus()
        {
            using (var h = Open())
            {
                if (h == null) return null;
                uint tag = Tag(h);
                if (tag == 0) return null;
                IntPtr inBuf = Marshal.AllocHGlobal(20), outBuf = Marshal.AllocHGlobal(16);
                try
                {
                    Marshal.WriteInt32(inBuf, 0, (int)tag);
                    for (int i = 4; i < 20; i += 4) Marshal.WriteInt32(inBuf, i, 0);
                    int ret;
                    if (!Native.DeviceIoControl(h, IOCTL_BATTERY_QUERY_STATUS, inBuf, 20, outBuf, 16, out ret, IntPtr.Zero)) return null;
                    uint state = (uint)Marshal.ReadInt32(outBuf, 0);
                    uint capacity = (uint)Marshal.ReadInt32(outBuf, 4);
                    int rate = Marshal.ReadInt32(outBuf, 12);
                    var info = Query(h, tag, 0, 36);
                    uint full = info != null && info.Length >= 20 ? BitConverter.ToUInt32(info, 16) : 0;
                    double pct = full > 0 && capacity != 0xFFFFFFFF ? Math.Min(100.0, capacity * 100.0 / full) : -1;
                    bool valid = rate != int.MinValue;
                    return J.D(
                        "percent", pct >= 0 ? (object)Math.Round(pct) : null,
                        "charging", (state & 4) != 0,
                        "onAc", (state & 1) != 0,
                        "watts", valid ? (object)Math.Round(Math.Abs(rate) / 1000.0, 1) : null);
                }
                finally { Marshal.FreeHGlobal(inBuf); Marshal.FreeHGlobal(outBuf); }
            }
        }

        public static object Health()
        {
            using (var h = Open())
            {
                if (h == null) return null;
                uint tag = Tag(h);
                if (tag == 0) return null;
                var b = Query(h, tag, 0, 36);
                if (b == null || b.Length < 36) return null;
                string chemistry = Encoding.ASCII.GetString(b, 8, 4).Trim('\0', ' ');
                uint design = BitConverter.ToUInt32(b, 12);
                uint full = BitConverter.ToUInt32(b, 16);
                uint cycles = BitConverter.ToUInt32(b, 32);
                var nameBytes = Query(h, tag, 4, 256);
                var makerBytes = Query(h, tag, 6, 256);
                return J.D(
                    "present", true,
                    "designCapacity", (long)design,
                    "fullCapacity", (long)full,
                    "unit", "mWh",
                    "healthPct", design > 0 ? (object)Math.Round(Math.Min(100.0, full * 100.0 / design), 1) : null,
                    "cycles", cycles > 0 ? (object)(long)cycles : null,
                    "chemistry", ChemistryName(chemistry),
                    "name", nameBytes != null ? Encoding.Unicode.GetString(nameBytes).Trim('\0', ' ') : null,
                    "manufacturer", makerBytes != null ? Encoding.Unicode.GetString(makerBytes).Trim('\0', ' ') : null);
            }
        }

        static string ChemistryName(string c)
        {
            switch (c.ToUpperInvariant())
            {
                case "LION":
                case "LI-I":
                case "LI I": return "Lithium-ion";
                case "LIP":
                case "LIPO": return "Lithium-polymer";
                case "NIMH": return "NiMH";
                case "NICD": return "NiCd";
                case "PBAC": return "Lead-acid";
            }
            return c.Length > 0 ? c : null;
        }
    }
}
