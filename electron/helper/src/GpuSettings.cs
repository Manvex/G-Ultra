using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace GUltra
{
    // Graphics card settings. Each one goes through a tool or setting the vendor or Windows
    // already supports; nothing writes to the card directly.
    static class GpuSettings
    {
        const string PrefsKey = @"Software\Microsoft\DirectX\UserGpuPreferences";
        const string GraphicsKey = @"SYSTEM\CurrentControlSet\Control\GraphicsDrivers";

        public static object Info()
        {
            return J.D(
                "nvidia", NvidiaList(),
                "hags", Hags(),
                "prefs", Prefs(),
                "elevated", SystemInfo.IsElevated());
        }

        // ---- NVIDIA: nvidia-smi ships with the driver ----
        static string SmiPath()
        {
            string[] candidates =
            {
                Path.Combine(Environment.SystemDirectory, "nvidia-smi.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"NVIDIA Corporation\NVSMI\nvidia-smi.exe"),
            };
            return candidates.FirstOrDefault(File.Exists);
        }

        static string RunSmi(string args, out int exitCode)
        {
            string smi = SmiPath();
            if (smi == null) throw new Exception("nvidia-smi was not found. Update the NVIDIA driver.");
            var psi = new ProcessStartInfo(smi, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (var p = Process.Start(psi))
            {
                var errTask = p.StandardError.ReadToEndAsync();
                string output = p.StandardOutput.ReadToEnd();
                if (!p.WaitForExit(10000))
                {
                    try { p.Kill(); } catch { }
                    throw new Exception("nvidia-smi did not respond.");
                }
                exitCode = p.ExitCode;
                return (output + " " + errTask.Result).Trim();
            }
        }

        static object Number(string s)
        {
            double v;
            return double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? (object)v : null;
        }

        static List<object> NvidiaList()
        {
            var list = new List<object>();
            if (SmiPath() == null) return list;
            try
            {
                int code;
                string output = RunSmi("--query-gpu=index,name,power.limit,power.min_limit,power.max_limit,power.default_limit,clocks.max.graphics --format=csv,noheader,nounits", out code);
                if (code != 0) return list;
                foreach (string line in output.Split('\n'))
                {
                    string[] f = line.Split(',');
                    if (f.Length < 7) continue;
                    list.Add(J.D(
                        "index", Convert.ToInt32(f[0].Trim(), CultureInfo.InvariantCulture),
                        "name", f[1].Trim(),
                        "powerW", Number(f[2]),
                        "minW", Number(f[3]),
                        "maxW", Number(f[4]),
                        "defaultW", Number(f[5]),
                        "maxClockMHz", Number(f[6])));
                }
            }
            catch { }
            return list;
        }

        static object SmiResult(string args)
        {
            if (!SystemInfo.IsElevated()) throw new Exception("This setting needs full mode.");
            int code;
            string output = RunSmi(args, out code);
            if (code != 0) throw new Exception(FirstLine(output));
            return J.D("ok", true);
        }

        static string FirstLine(string s)
        {
            string line = (s ?? "").Split('\n')[0].Trim();
            return line.Length > 0 ? line : "The driver rejected this setting.";
        }

        public static object PowerLimit(int index, double watts)
        {
            if (index < 0) throw new Exception("Invalid GPU.");
            if (watts <= 0 || watts > 2000) throw new Exception("Invalid power limit.");
            return SmiResult("-i " + index + " -pl " + watts.ToString("0.##", CultureInfo.InvariantCulture));
        }

        public static object ClockLimit(int index, int maxMHz)
        {
            if (index < 0) throw new Exception("Invalid GPU.");
            if (maxMHz < 100 || maxMHz > 6000) throw new Exception("Invalid clock limit.");
            return SmiResult("-i " + index + " -lgc 0," + maxMHz);
        }

        public static object ClockReset(int index)
        {
            if (index < 0) throw new Exception("Invalid GPU.");
            return SmiResult("-i " + index + " -rgc");
        }

        // ---- Windows: which GPU each app runs on ----
        static readonly Regex PrefPattern = new Regex(@"GpuPreference=(\d);?", RegexOptions.IgnoreCase);

        public static List<object> Prefs()
        {
            var list = new List<object>();
            using (var key = Registry.CurrentUser.OpenSubKey(PrefsKey))
            {
                if (key == null) return list;
                foreach (string name in key.GetValueNames())
                {
                    if (!name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
                    var m = PrefPattern.Match(key.GetValue(name) as string ?? "");
                    if (!m.Success) continue;
                    list.Add(J.D("path", name, "name", Path.GetFileNameWithoutExtension(name), "pref", int.Parse(m.Groups[1].Value), "exists", File.Exists(name)));
                }
            }
            return list;
        }

        // pref: 0 = let Windows decide, 1 = power saving, 2 = high performance.
        public static object SetPref(string path, int pref)
        {
            if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path) || !path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
                throw new Exception("That program wasn't found.");
            if (pref < 0 || pref > 2) throw new Exception("Invalid preference.");

            using (var key = Registry.CurrentUser.CreateSubKey(PrefsKey))
            {
                // The same value also holds other Windows graphics options, which must survive.
                string current = key.GetValue(path) as string ?? "";
                string others = PrefPattern.Replace(current, "");
                if (pref == 0 && others.Length == 0) key.DeleteValue(path, false);
                else key.SetValue(path, "GpuPreference=" + pref + ";" + others, RegistryValueKind.String);
            }
            return J.D("ok", true);
        }

        // ---- Windows: hardware-accelerated GPU scheduling ----
        static object Hags()
        {
            string state = "default";
            try
            {
                using (var key = Registry.LocalMachine.OpenSubKey(GraphicsKey))
                {
                    object v = key == null ? null : key.GetValue("HwSchMode");
                    if (v is int) state = (int)v == 2 ? "on" : (int)v == 1 ? "off" : "default";
                }
            }
            catch { }
            return J.D("state", state, "canSet", SystemInfo.IsElevated());
        }

        public static object SetHags(bool on)
        {
            if (!SystemInfo.IsElevated()) throw new Exception("This setting needs full mode.");
            using (var key = Registry.LocalMachine.CreateSubKey(GraphicsKey))
                key.SetValue("HwSchMode", on ? 2 : 1, RegistryValueKind.DWord);
            return J.D("ok", true, "needsRestart", true);
        }
    }
}
