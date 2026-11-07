using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace GUltra
{
    static class DiskInfo
    {
        public class Phys
        {
            public int Index; public string Model; public long Size; public string Bus; public string Media; public string Health;
            public List<string> Letters = new List<string>();
        }

        static List<Phys> _cache;
        static DateTime _at;

        public static List<Phys> Physical(int maxAgeSec = 30)
        {
            if (_cache != null && (DateTime.UtcNow - _at).TotalSeconds < maxAgeSec) return _cache;
            var map = new Dictionary<int, Phys>();
            SystemInfo.Wmi("Win32_DiskDrive", o =>
            {
                int index = Convert.ToInt32(o["Index"] ?? -1);
                if (index < 0) return;
                map[index] = new Phys
                {
                    Index = index,
                    Model = Trim(SystemInfo.Str(o["Model"])),
                    Size = Convert.ToInt64(o["Size"] ?? 0L),
                    Bus = SystemInfo.Str(o["InterfaceType"]),
                };
            });

            // The real type (SSD/HDD, NVMe/SATA) and status come from the storage API.
            SystemInfo.WmiNs(@"root\microsoft\windows\storage", "SELECT DeviceId,MediaType,BusType,HealthStatus FROM MSFT_PhysicalDisk", o =>
            {
                int index;
                if (!int.TryParse(SystemInfo.Str(o["DeviceId"]), out index)) return;
                Phys p;
                if (!map.TryGetValue(index, out p)) return;
                int media = Convert.ToInt32(o["MediaType"] ?? 0);
                int bus = Convert.ToInt32(o["BusType"] ?? 0);
                int health = Convert.ToInt32(o["HealthStatus"] ?? 5);
                p.Media = media == 4 ? "SSD" : media == 3 ? "HDD" : media == 5 ? "SCM" : null;
                p.Bus = bus == 17 ? "NVMe" : bus == 11 ? "SATA" : bus == 7 ? "USB" : bus == 12 ? "SD" : bus == 13 ? "MMC" : bus == 1 ? "SCSI" : bus == 8 ? "RAID" : p.Bus;
                p.Health = health == 0 ? "ok" : health == 1 ? "warning" : health == 2 ? "bad" : null;
            });

            // Drive letters for each physical disk.
            var partToDisk = new Dictionary<string, int>();
            SystemInfo.Wmi("Win32_DiskDriveToDiskPartition", o =>
            {
                string a = SystemInfo.Str(o["Antecedent"]), d = SystemInfo.Str(o["Dependent"]);
                int idx = a.LastIndexOf("PHYSICALDRIVE", StringComparison.OrdinalIgnoreCase);
                int disk;
                if (idx >= 0 && int.TryParse(a.Substring(idx + 13).Trim('"'), out disk)) partToDisk[PropValue(d)] = disk;
            });
            SystemInfo.Wmi("Win32_LogicalDiskToPartition", o =>
            {
                string part = PropValue(SystemInfo.Str(o["Antecedent"])), letter = PropValue(SystemInfo.Str(o["Dependent"]));
                int disk;
                Phys p;
                if (partToDisk.TryGetValue(part, out disk) && map.TryGetValue(disk, out p)) p.Letters.Add(letter);
            });

            _cache = map.Values.OrderBy(p => p.Index).ToList();
            _at = DateTime.UtcNow;
            return _cache;
        }

        static string PropValue(string wmiPath)
        {
            int i = wmiPath.IndexOf("=\"", StringComparison.Ordinal);
            return i < 0 ? wmiPath : wmiPath.Substring(i + 2).TrimEnd('"');
        }

        static string Trim(string s)
        {
            return s.Replace(" SCSI Disk Device", "").Replace(" USB Device", "").Replace(" ATA Device", "").Trim();
        }

        public static object Get()
        {
            var phys = Physical();
            var volumes = new List<object>();
            foreach (var d in DriveInfo.GetDrives())
            {
                try
                {
                    if (!d.IsReady) continue;
                    if (d.DriveType != DriveType.Fixed && d.DriveType != DriveType.Removable) continue;
                    string letter = d.Name.Substring(0, 2);
                    var owner = phys.FirstOrDefault(p => p.Letters.Contains(letter, StringComparer.OrdinalIgnoreCase));
                    volumes.Add(J.D(
                        "path", d.Name,
                        "letter", letter,
                        "label", d.VolumeLabel,
                        "fs", d.DriveFormat,
                        "total", d.TotalSize,
                        "free", d.AvailableFreeSpace,
                        "removable", d.DriveType == DriveType.Removable,
                        "system", string.Equals(Path.GetPathRoot(Environment.SystemDirectory), d.Name, StringComparison.OrdinalIgnoreCase),
                        "model", owner != null ? owner.Model : null,
                        "media", owner != null ? owner.Media : null,
                        "bus", owner != null ? owner.Bus : null));
                }
                catch { }
            }
            return J.D("platform", "windows", "volumes", volumes);
        }
    }

    // The NVMe SMART log, requested directly from the storage driver.
    static class NvmeSmart
    {
        const uint IOCTL_STORAGE_QUERY_PROPERTY = 0x002D1400;
        const int StorageDeviceProtocolSpecificProperty = 50;
        const int ProtocolTypeNvme = 3;
        const int NVMeDataTypeLogPage = 2;
        const int NVME_LOG_PAGE_HEALTH_INFO = 2;
        const int HeaderSize = 48;
        const int LogSize = 512;

        public class Log
        {
            public double? TempC; public int Warning; public int Spare; public int SpareThreshold; public int PercentUsed;
            public double DataReadBytes; public double DataWrittenBytes; public double PowerCycles; public double PowerOnHours;
            public double UnsafeShutdowns; public double MediaErrors; public double ErrorLogEntries;
        }

        static DateTime _tempsAt = DateTime.MinValue;
        static List<KeyValuePair<string, double>> _temps = new List<KeyValuePair<string, double>>();
        static readonly object Lock = new object();
        static bool _refreshing;

        // Reads happen on another thread: a live sample must never wait for WMI or the disk.
        public static List<KeyValuePair<string, double>> Temperatures()
        {
            lock (Lock)
            {
                if (!_refreshing && (DateTime.UtcNow - _tempsAt).TotalSeconds >= 15)
                {
                    _refreshing = true;
                    System.Threading.ThreadPool.QueueUserWorkItem(_ => Refresh());
                }
                return _temps;
            }
        }

        static void Refresh()
        {
            var res = new List<KeyValuePair<string, double>>();
            try
            {
                foreach (var p in DiskInfo.Physical(300))
                {
                    if (p.Bus != "NVMe") continue;
                    var log = Read(p.Index);
                    if (log != null && log.TempC.HasValue) res.Add(new KeyValuePair<string, double>(p.Model, log.TempC.Value));
                }
            }
            catch { }
            lock (Lock)
            {
                _temps = res;
                _tempsAt = DateTime.UtcNow;
                _refreshing = false;
            }
        }

        public static Log Read(int disk)
        {
            // Try without read access first: many Windows versions allow it.
            foreach (uint access in new[] { 0u, Native.GENERIC_READ })
            {
                using (var h = Native.CreateFile(@"\\.\PhysicalDrive" + disk, access, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, IntPtr.Zero, Native.OPEN_EXISTING, 0, IntPtr.Zero))
                {
                    if (h.IsInvalid) continue;
                    var log = Query(h);
                    if (log != null) return log;
                }
            }
            return null;
        }

        static Log Query(SafeFileHandle h)
        {
            int size = 8 + 40 + LogSize;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                for (int i = 0; i < size; i++) Marshal.WriteByte(buf, i, 0);
                Marshal.WriteInt32(buf, 0, StorageDeviceProtocolSpecificProperty);
                Marshal.WriteInt32(buf, 4, 0);
                Marshal.WriteInt32(buf, 8, ProtocolTypeNvme);
                Marshal.WriteInt32(buf, 12, NVMeDataTypeLogPage);
                Marshal.WriteInt32(buf, 16, NVME_LOG_PAGE_HEALTH_INFO);
                Marshal.WriteInt32(buf, 20, 0);
                Marshal.WriteInt32(buf, 24, 40); // ProtocolDataOffset
                Marshal.WriteInt32(buf, 28, LogSize);
                int ret;
                if (!Native.DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, buf, size, buf, size, out ret, IntPtr.Zero)) return null;
                if (ret < HeaderSize + 192) return null;
                var d = new byte[LogSize];
                Marshal.Copy(IntPtr.Add(buf, HeaderSize), d, 0, LogSize);
                int kelvin = d[1] | (d[2] << 8);
                return new Log
                {
                    Warning = d[0],
                    TempC = kelvin > 0 ? (double?)(kelvin - 273) : null,
                    Spare = d[3],
                    SpareThreshold = d[4],
                    PercentUsed = d[5],
                    DataReadBytes = U128(d, 32) * 512000.0,
                    DataWrittenBytes = U128(d, 48) * 512000.0,
                    PowerCycles = U128(d, 112),
                    PowerOnHours = U128(d, 128),
                    UnsafeShutdowns = U128(d, 144),
                    MediaErrors = U128(d, 160),
                    ErrorLogEntries = U128(d, 176),
                };
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        static double U128(byte[] d, int off)
        {
            double v = 0, mul = 1;
            for (int i = 0; i < 16; i++) { v += d[off + i] * mul; mul *= 256.0; }
            return v;
        }
    }

    static class HealthInfo
    {
        public static object Get()
        {
            var disks = new List<object>();
            var counters = ReliabilityCounters();

            foreach (var p in DiskInfo.Physical())
            {
                object smart = null;
                string reason = null;
                if (p.Bus == "NVMe")
                {
                    var log = NvmeSmart.Read(p.Index);
                    if (log != null)
                        smart = J.D(
                            "source", "nvme",
                            "tempC", log.TempC,
                            "percentUsed", log.PercentUsed,
                            "availableSpare", log.Spare,
                            "spareThreshold", log.SpareThreshold,
                            "dataWritten", log.DataWrittenBytes,
                            "dataRead", log.DataReadBytes,
                            "powerOnHours", log.PowerOnHours,
                            "powerCycles", log.PowerCycles,
                            "unsafeShutdowns", log.UnsafeShutdowns,
                            "mediaErrors", log.MediaErrors,
                            "errorLogEntries", log.ErrorLogEntries,
                            "criticalWarning", log.Warning);
                }

                Dictionary<string, object> rc;
                if (smart == null && counters.TryGetValue(p.Index, out rc)) smart = rc;
                bool external = p.Bus == "USB" || p.Bus == "SD" || p.Bus == "MMC" || p.Model.IndexOf("Card", StringComparison.OrdinalIgnoreCase) >= 0;
                if (smart == null) reason = external || SystemInfo.IsElevated() ? "unsupported" : "admin";

                disks.Add(J.D(
                    "index", p.Index,
                    "model", p.Model,
                    "size", p.Size,
                    "bus", p.Bus,
                    "media", p.Media,
                    "status", p.Health,
                    "letters", p.Letters.Cast<object>().ToList(),
                    "smart", smart,
                    "smartReason", reason));
            }

            return J.D(
                "platform", "windows",
                "disks", disks,
                "battery", BatteryInfo.Health(),
                "hardwareErrors", CountEvents("*[System[Provider[@Name='Microsoft-Windows-WHEA-Logger'] and TimeCreated[timediff(@SystemTime) <= 2592000000]]]"),
                "unexpectedShutdowns", CountEvents("*[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=41 and TimeCreated[timediff(@SystemTime) <= 2592000000]]]"),
                "uptimeSec", (long)(Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency));
        }

        static object CountEvents(string query)
        {
            try
            {
                int n = 0;
                using (var reader = new EventLogReader(new EventLogQuery("System", PathType.LogName, query)))
                {
                    EventRecord r;
                    while ((r = reader.ReadEvent()) != null && n < 1000) { r.Dispose(); n++; }
                }
                return n;
            }
            catch { return null; }
        }

        // SATA/SCSI: Windows counters. These need admin rights.
        static Dictionary<int, Dictionary<string, object>> ReliabilityCounters()
        {
            var res = new Dictionary<int, Dictionary<string, object>>();
            SystemInfo.WmiNs(@"root\microsoft\windows\storage", "SELECT * FROM MSFT_StorageReliabilityCounter", o =>
            {
                int index;
                if (!int.TryParse(SystemInfo.Str(o["DeviceId"]), out index)) return;
                int temp = SafeInt(o, "Temperature");
                int wear = SafeInt(o, "Wear");
                res[index] = J.D(
                    "source", "windows",
                    "tempC", temp > 0 ? (object)temp : null,
                    "percentUsed", wear,
                    "powerOnHours", SafeInt(o, "PowerOnHours"),
                    "powerCycles", SafeInt(o, "StartStopCycleCount"),
                    "mediaErrors", SafeInt(o, "ReadErrorsUncorrected"));
            });
            return res;
        }

        static int SafeInt(ManagementBaseObject o, string prop)
        {
            try { return Convert.ToInt32(o[prop] ?? 0); } catch { return 0; }
        }
    }
}
