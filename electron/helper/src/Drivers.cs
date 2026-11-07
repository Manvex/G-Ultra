using System;
using System.Collections.Generic;
using System.Linq;
using System.Management;
using System.Threading;

namespace GUltra
{
    // Driver updates come only from Windows Update, so everything installed here is signed and
    // offered by Microsoft for this PC's hardware. The query asks for drivers only, so Windows
    // updates and other software never appear.
    static class Drivers
    {
        const string Query = "IsInstalled=0 and Type='Driver' and IsHidden=0";
        static int _installing;

        static dynamic NewSession()
        {
            Type t = Type.GetTypeFromProgID("Microsoft.Update.Session");
            if (t == null) throw new Exception("Windows Update isn't available on this PC.");
            dynamic session = Activator.CreateInstance(t);
            session.ClientApplicationID = "G Ultra";
            return session;
        }

        static dynamic Search(object sessionObject)
        {
            try
            {
                dynamic session = sessionObject;
                dynamic searcher = session.CreateUpdateSearcher();
                dynamic result = searcher.Search(Query);
                return result.Updates;
            }
            catch (Exception ex)
            {
                throw new Exception(Explain(ex.HResult));
            }
        }

        static string Explain(int hresult)
        {
            switch ((uint)hresult)
            {
                case 0x80072EE7:
                case 0x80072EFD:
                case 0x80072EE2:
                case 0x8024402C:
                case 0x8024401C:
                    return "Windows Update couldn't be reached. Check your internet connection and try again.";
                case 0x80070422:
                    return "The Windows Update service is turned off. Turn it on in Windows Services and try again.";
                case 0x80240016:
                    return "Windows is already installing another update. Try again when it finishes.";
                case 0x80070005:
                    return "This needs full mode.";
                default:
                    return "Windows Update reported an error (0x" + ((uint)hresult).ToString("X8") + ").";
            }
        }

        static string Str(Func<object> read)
        {
            try { object v = read(); return v == null ? null : v.ToString().Trim(); }
            catch { return null; }
        }

        static double Num(Func<object> read)
        {
            try { return Convert.ToDouble(read()); }
            catch { return 0; }
        }

        static bool Flag(Func<object> read)
        {
            try { return Convert.ToBoolean(read()); }
            catch { return false; }
        }

        static string Day(Func<object> read)
        {
            try { return Convert.ToDateTime(read()).ToString("yyyy-MM-dd"); }
            catch { return null; }
        }

        public static object Scan()
        {
            object session = NewSession();
            dynamic updates = Search(session);
            var list = new List<object>();
            int count = updates.Count;
            for (int i = 0; i < count; i++)
            {
                dynamic u = updates[i];
                string id = Str(() => u.Identity.UpdateID);
                string title = Str(() => u.Title);
                string provider = Str(() => u.DriverProvider);
                string cls = Str(() => u.DriverClass);
                string date = Day(() => u.DriverVerDate);
                double size = Num(() => u.MaxDownloadSize);
                bool needsTerms = !Flag(() => u.EulaAccepted);
                list.Add(J.D("id", id, "title", title, "provider", provider, "driverClass", cls,
                    "date", date, "size", size, "needsTerms", needsTerms));
            }
            return J.D("updates", list, "elevated", SystemInfo.IsElevated());
        }

        public static object Install(List<string> ids, bool allowNoRestorePoint)
        {
            if (!SystemInfo.IsElevated()) throw new Exception("Installing drivers needs full mode.");
            if (ids.Count == 0) throw new Exception("No drivers selected.");
            if (Interlocked.CompareExchange(ref _installing, 1, 0) != 0) throw new Exception("Drivers are already being installed.");
            try
            {
                Program.Emit("driverInstall", J.D("stage", "restore"));
                Dictionary<string, object> restore = CreateRestorePoint();
                if ((string)restore["state"] == "unavailable" && !allowNoRestorePoint)
                    return J.D("needsConfirm", true, "restore", restore, "results", new List<object>(), "rebootRequired", false);

                object session = NewSession();
                dynamic updates = Search(session);
                var offered = new Dictionary<string, object>();
                int count = updates.Count;
                for (int i = 0; i < count; i++)
                {
                    dynamic u = updates[i];
                    string id = Str(() => u.Identity.UpdateID);
                    if (id != null) offered[id] = (object)u;
                }

                // Only ids Windows Update is offering right now can be installed.
                var results = new List<object>();
                bool reboot = false;
                for (int i = 0; i < ids.Count; i++)
                {
                    object found;
                    if (!offered.TryGetValue(ids[i], out found))
                    {
                        results.Add(J.D("id", ids[i], "title", null, "state", "skipped", "message", "Windows Update no longer offers this driver."));
                        continue;
                    }
                    dynamic u = found;
                    string title = Str(() => u.Title);
                    if (!Flag(() => u.EulaAccepted))
                    {
                        results.Add(J.D("id", ids[i], "title", title, "state", "skipped", "message", "It has license terms to accept. Install it from Windows Update."));
                        continue;
                    }
                    bool needsReboot;
                    string error = InstallOne(session, found, i, ids.Count, title, out needsReboot);
                    reboot |= needsReboot;
                    results.Add(J.D("id", ids[i], "title", title, "state", error == null ? "installed" : "failed", "message", error));
                }
                return J.D("restore", restore, "results", results, "rebootRequired", reboot);
            }
            finally
            {
                Interlocked.Exchange(ref _installing, 0);
            }
        }

        static string InstallOne(object sessionObject, object update, int index, int total, string title, out bool reboot)
        {
            reboot = false;
            try
            {
                dynamic session = sessionObject;
                dynamic coll = Activator.CreateInstance(Type.GetTypeFromProgID("Microsoft.Update.UpdateColl"));
                coll.Add((dynamic)update);

                Program.Emit("driverInstall", J.D("stage", "download", "index", index, "total", total, "title", title));
                dynamic downloader = session.CreateUpdateDownloader();
                downloader.Updates = coll;
                dynamic downloaded = downloader.Download();
                int code = Convert.ToInt32((object)downloaded.ResultCode);
                if (code != 2 && code != 3) return "The download failed.";

                Program.Emit("driverInstall", J.D("stage", "install", "index", index, "total", total, "title", title));
                dynamic installer = session.CreateUpdateInstaller();
                installer.Updates = coll;
                dynamic result = installer.Install();
                reboot = Convert.ToBoolean((object)result.RebootRequired);
                code = Convert.ToInt32((object)result.ResultCode);
                if (code == 2 || code == 3) return null;
                return Explain(Convert.ToInt32((object)result.HResult));
            }
            catch (Exception ex)
            {
                return Explain(ex.HResult);
            }
        }

        // ---- restore point ----
        static Dictionary<string, object> CreateRestorePoint()
        {
            try
            {
                int before = RestorePoints().Count;
                var cls = new ManagementClass(new ManagementScope(@"\\.\root\default"), new ManagementPath("SystemRestore"), null);
                ManagementBaseObject input = cls.GetMethodParameters("CreateRestorePoint");
                input["Description"] = "Before G Ultra driver update";
                input["RestorePointType"] = 10;  // DEVICE_DRIVER_INSTALL
                input["EventType"] = 100;        // BEGIN_SYSTEM_CHANGE
                ManagementBaseObject output = cls.InvokeMethod("CreateRestorePoint", input, null);
                uint code = Convert.ToUInt32(output["ReturnValue"]);

                List<DateTime> after = RestorePoints();
                if (code == 0 && after.Count > before)
                    return J.D("state", "created", "message", "Restore point created.");
                // Windows allows one automatic restore point every 24 hours.
                if (code == 0 && after.Any(t => DateTime.Now - t < TimeSpan.FromHours(24)))
                    return J.D("state", "recent", "message", "Using the restore point made in the last 24 hours.");
            }
            catch { }
            return J.D("state", "unavailable", "message", "Windows couldn't create a restore point. System Protection may be turned off.");
        }

        static List<DateTime> RestorePoints()
        {
            var list = new List<DateTime>();
            using (var s = new ManagementObjectSearcher(@"root\default", "SELECT CreationTime FROM SystemRestore"))
            using (ManagementObjectCollection found = s.Get())
                foreach (ManagementBaseObject o in found)
                    list.Add(ManagementDateTimeConverter.ToDateTime((string)o["CreationTime"]));
            return list;
        }

        // ---- installed drivers and problem devices ----
        static readonly Dictionary<string, string> Classes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "DISPLAY", "Graphics" },
            { "MEDIA", "Sound" },
            { "NET", "Network" },
            { "BLUETOOTH", "Bluetooth" },
            { "HDC", "Storage" },
            { "SCSIADAPTER", "Storage" },
            { "CAMERA", "Camera" },
            { "IMAGE", "Camera" },
            { "BIOMETRIC", "Biometric" },
            { "FIRMWARE", "Firmware" },
        };

        public static object Installed()
        {
            var drivers = new List<Dictionary<string, object>>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var s = new ManagementObjectSearcher("SELECT DeviceName, DeviceClass, DriverVersion, DriverDate, DriverProviderName FROM Win32_PnPSignedDriver"))
            using (ManagementObjectCollection found = s.Get())
            {
                foreach (ManagementBaseObject o in found)
                {
                    string name = o["DeviceName"] as string;
                    string cls = o["DeviceClass"] as string;
                    string version = o["DriverVersion"] as string;
                    string provider = o["DriverProviderName"] as string;
                    string group;
                    if (string.IsNullOrEmpty(name) || version == null || cls == null || !Classes.TryGetValue(cls, out group)) continue;
                    // Drivers built into Windows update with Windows itself, except a fallback display driver.
                    if (string.Equals(provider, "Microsoft", StringComparison.OrdinalIgnoreCase) && group != "Graphics") continue;
                    if (!seen.Add(name + "|" + version)) continue;
                    drivers.Add(J.D("name", name, "group", group, "version", version, "provider", provider, "date", CimDay(o["DriverDate"] as string)));
                }
            }

            var problems = new List<object>();
            using (var s = new ManagementObjectSearcher("SELECT Name, ConfigManagerErrorCode FROM Win32_PnPEntity WHERE ConfigManagerErrorCode <> 0"))
            using (ManagementObjectCollection found = s.Get())
            {
                foreach (ManagementBaseObject o in found)
                {
                    int code = Convert.ToInt32(o["ConfigManagerErrorCode"]);
                    // 22 means the user disabled it, 45 means it isn't plugged in. Neither is a fault.
                    if (code == 22 || code == 45) continue;
                    problems.Add(J.D("name", (o["Name"] as string) ?? "Unknown device", "code", code, "meaning", ProblemText(code)));
                }
            }

            return J.D("drivers", drivers.OrderBy(d => (string)d["group"]).ThenBy(d => (string)d["name"]).ToList(), "problems", problems);
        }

        static string CimDay(string cim)
        {
            if (cim == null || cim.Length < 8) return null;
            return cim.Substring(0, 4) + "-" + cim.Substring(4, 2) + "-" + cim.Substring(6, 2);
        }

        static string ProblemText(int code)
        {
            switch (code)
            {
                case 1: return "It isn't set up correctly.";
                case 10: return "It can't start.";
                case 28: return "It has no driver installed.";
                case 31: return "Windows can't load its driver.";
                case 39: return "Its driver is missing or damaged.";
                case 43: return "It stopped after reporting a problem.";
                default: return "Windows reports problem code " + code + ".";
            }
        }
    }
}
