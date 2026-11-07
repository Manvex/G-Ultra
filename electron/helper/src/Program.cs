using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

namespace GUltra
{
    // Protocol: one JSON document per line on stdin/stdout.
    //   request:  {"id":1,"method":"live","params":{...}}
    //   response: {"id":1,"result":{...}}  or  {"id":1,"error":"message"}
    //   event:    {"event":"scan","data":{...}}
    // Every request runs on its own pool thread, so a long scan never holds up live data.
    static class Program
    {
        static readonly object OutLock = new object();
        static Stream _out;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 256 };

        static readonly Dictionary<string, Func<Dictionary<string, object>, object>> Methods =
            new Dictionary<string, Func<Dictionary<string, object>, object>>
            {
                { "system", p => SystemInfo.Get() },
                { "live", p => LiveSampler.Sample() },
                { "memory", p => MemoryInfo.Get() },
                { "freeRam", p => MemoryCleaner.Free(GetBool(p, "standby")) },
                { "endProcess", p => ProcessList.End(GetIntList(p, "pids"), GetBool(p, "force")) },
                { "disks", p => DiskInfo.Get() },
                { "health", p => HealthInfo.Get() },
                { "cleanScan", p => Cleaner.Scan() },
                { "cleanRun", p => Cleaner.Run(GetStrList(p, "ids")) },
                { "cleanCancel", p => Cleaner.Cancel() },
                { "scanStart", p => FolderScanner.Start(GetStr(p, "path")) },
                { "scanCancel", p => FolderScanner.Cancel() },
                { "scanNode", p => FolderScanner.GetNode(GetStr(p, "path")) },
                { "sensorsReload", p => Sensors.Reload() },
                { "fanSet", p => Fans.Set(GetStr(p, "id"), GetNum(p, "percent")) },
                { "fanAuto", p => Fans.Auto(GetStr(p, "id")) },
                { "fanAutoAll", p => Fans.AutoAll() },
                { "gpuInfo", p => GpuSettings.Info() },
                { "gpuPowerLimit", p => GpuSettings.PowerLimit((int)GetNum(p, "index"), GetNum(p, "watts")) },
                { "gpuClockLimit", p => GpuSettings.ClockLimit((int)GetNum(p, "index"), (int)GetNum(p, "maxMHz")) },
                { "gpuClockReset", p => GpuSettings.ClockReset((int)GetNum(p, "index")) },
                { "gpuPrefSet", p => GpuSettings.SetPref(GetStr(p, "path"), (int)GetNum(p, "pref")) },
                { "hagsSet", p => GpuSettings.SetHags(GetBool(p, "on")) },
                { "batteryInfo", p => BatteryService.Info() },
                { "batteryReport", p => BatteryService.Report() },
                { "batterySet", p => BatteryService.Set(GetStr(p, "key"), GetNum(p, "value")) },
                { "startupList", p => BatteryService.StartupList() },
                { "startupSet", p => BatteryService.StartupSet(GetStr(p, "id"), GetBool(p, "on")) },
                { "components", p => Components.Get() },
                { "monitorGet", p => Monitor.GetInfo() },
                { "monitorSet", p => Monitor.SetConfig(p.ContainsKey("config") ? p["config"] as Dictionary<string, object> : null) },
                { "monitorHistory", p => Monitor.GetHistory() },
                { "autostartSet", p => Autostart.Set(GetBool(p, "on")) },
                { "ramHealth", p => RamHealth.Get() },
                { "ramTestStart", p => RamHealth.TestStart() },
                { "ramTestCancel", p => RamHealth.TestCancel() },
                { "ramDiagnostic", p => RamHealth.OpenDiagnostic() },
                { "ping", p => "pong" },
            };

        static int Main(string[] args)
        {
            // LibreHardwareMonitor's dependencies live in lib\ next to the exe; requested versions are ignored.
            AppDomain.CurrentDomain.AssemblyResolve += ResolveFromLib;
            // Never leave a fan on a fixed speed because of a crash.
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                try { Fans.RestoreAll(); } catch { }
            };

            _out = Console.OpenStandardOutput();
#if SELFTEST
            return SelfTest.Run(args);
#else
            if (args.Length > 0 && args[0] == "--once")
            {
                // Diagnostics: --once method writes one result and exits.
                Handle("{\"id\":0,\"method\":\"" + args[1] + "\"}");
                Environment.Exit(0);
            }

            if (args.Length > 0 && args[0] == "--background")
            {
                int code = Background.Run();
                Environment.Exit(code);
            }

            // The app is open: this process takes over the rules from any background monitor.
            // On its own thread, so the app never waits for the handover. That thread stays
            // alive because a mutex belongs to the thread that took it.
            bool monitoring = false;
            var takeover = new Thread(() =>
            {
                if (Background.TakeOver() == null) return;
                Monitor.Start(false);
                monitoring = true;
                Thread.Sleep(Timeout.Infinite);
            });
            takeover.IsBackground = true;
            takeover.Start();

            var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                string captured = line;
                ThreadPool.QueueUserWorkItem(_ => Handle(captured));
            }

            // stdin closed: the app has exited. Hand the fans back, then leave no matter what;
            // libraries can hold foreground threads that would keep this process alive forever.
            var shutdown = new Thread(() =>
            {
                try { if (monitoring) Monitor.Stop(); } catch { }
                try { Fans.RestoreAll(); } catch { }
                try { Sensors.Shutdown(); } catch { }
            });
            shutdown.IsBackground = true;
            shutdown.Start();
            shutdown.Join(3000);
            Environment.Exit(0);
            return 0;
#endif
        }

        static Assembly ResolveFromLib(object sender, ResolveEventArgs e)
        {
            try
            {
                string name = new AssemblyName(e.Name).Name;
                string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                string path = Path.Combine(baseDir, "lib", name + ".dll");
                return File.Exists(path) ? Assembly.LoadFrom(path) : null;
            }
            catch { return null; }
        }

        static void Handle(string line)
        {
            object id = null;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                id = req.ContainsKey("id") ? req["id"] : null;
                string method = (string)req["method"];
                var ps = req.ContainsKey("params") ? req["params"] as Dictionary<string, object> : null;
                Func<Dictionary<string, object>, object> fn;
                if (!Methods.TryGetValue(method, out fn)) throw new Exception("Unknown method: " + method);
                object result = fn(ps ?? new Dictionary<string, object>());
                Write(new Dictionary<string, object> { { "id", id }, { "result", result } });
            }
            catch (Exception ex)
            {
                Write(new Dictionary<string, object> { { "id", id }, { "error", ex.Message } });
            }
        }

        public static void Emit(string name, object data)
        {
            Write(new Dictionary<string, object> { { "event", name }, { "data", data } });
        }

        static void Write(object o)
        {
            string s = Json.Serialize(o);
            byte[] bytes = new UTF8Encoding(false).GetBytes(s + "\n");
            lock (OutLock)
            {
                _out.Write(bytes, 0, bytes.Length);
                _out.Flush();
            }
        }

        static string GetStr(Dictionary<string, object> p, string k)
        {
            object v;
            return p.TryGetValue(k, out v) ? v as string : null;
        }

        static bool GetBool(Dictionary<string, object> p, string k)
        {
            object v;
            return p.TryGetValue(k, out v) && v is bool && (bool)v;
        }

        static double GetNum(Dictionary<string, object> p, string k)
        {
            object v;
            if (!p.TryGetValue(k, out v) || v == null) throw new Exception("Missing value: " + k);
            return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture);
        }

        static List<string> GetStrList(Dictionary<string, object> p, string k)
        {
            var list = new List<string>();
            object v;
            if (p.TryGetValue(k, out v) && v is System.Collections.IEnumerable && !(v is string))
                foreach (object o in (System.Collections.IEnumerable)v) if (o is string) list.Add((string)o);
            return list;
        }

        static List<int> GetIntList(Dictionary<string, object> p, string k)
        {
            var list = new List<int>();
            object v;
            if (p.TryGetValue(k, out v) && v is System.Collections.IEnumerable && !(v is string))
                foreach (object o in (System.Collections.IEnumerable)v) list.Add(Convert.ToInt32(o));
            return list;
        }
    }

    // Short constructor for JSON objects: D("a", 1, "b", 2)
    static class J
    {
        public static Dictionary<string, object> D(params object[] kv)
        {
            var d = new Dictionary<string, object>(kv.Length / 2);
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = Clean(kv[i + 1]);
            return d;
        }

        static object Clean(object v)
        {
            if (v is double && (double.IsNaN((double)v) || double.IsInfinity((double)v))) return null;
            if (v is float && (float.IsNaN((float)v) || float.IsInfinity((float)v))) return null;
            return v;
        }

        public static double R(double v, int digits)
        {
            return Math.Round(v, digits);
        }
    }
}
