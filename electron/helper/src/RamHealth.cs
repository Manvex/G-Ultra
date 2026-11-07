using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace GUltra
{
    // RAM has no wear counter the way an SSD does, so health comes from the evidence Windows
    // keeps: hardware errors, crashes that point at memory, and memory test results.
    static class RamHealth
    {
        const string Last90Days = "TimeCreated[timediff(@SystemTime) <= 7776000000]";
        static readonly Regex BugCheck = new Regex(@"0x([0-9a-fA-F]{8})");

        // Stop codes that usually mean bad or unstable memory.
        static readonly HashSet<int> MemoryStopCodes = new HashSet<int> { 0x1A, 0x50, 0x4E, 0x19, 0xC2, 0x12B, 0x7A, 0x77, 0xDA };

        static string TestPath { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "G Ultra", "ram-test.json"); } }

        static int? Count(string query)
        {
            try
            {
                int n = 0;
                using (var reader = new EventLogReader(new EventLogQuery("System", PathType.LogName, query)))
                {
                    EventRecord r;
                    while ((r = reader.ReadEvent()) != null && n < 1000)
                    {
                        r.Dispose();
                        n++;
                    }
                }
                return n;
            }
            catch { return null; }
        }

        static object Check(string id, string label, string status, string value, string detail)
        {
            return J.D("id", id, "label", label, "status", status, "value", value, "detail", detail);
        }

        static Dictionary<string, object> LastDiagnostic()
        {
            try
            {
                var q = new EventLogQuery("System", PathType.LogName, "*[System[Provider[@Name='Microsoft-Windows-MemoryDiagnostics-Results'] and (EventID=1101 or EventID=1102)]]") { ReverseDirection = true };
                using (var reader = new EventLogReader(q))
                using (var r = reader.ReadEvent())
                {
                    if (r == null || !r.TimeCreated.HasValue) return null;
                    return J.D("passed", r.Id == 1101, "date", r.TimeCreated.Value.ToString("yyyy-MM-dd"));
                }
            }
            catch { return null; }
        }

        static void CountCrashes(out int total, out int memory)
        {
            total = 0;
            memory = 0;
            try
            {
                string query = "*[System[Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'] and EventID=1001 and " + Last90Days + "]]";
                using (var reader = new EventLogReader(new EventLogQuery("System", PathType.LogName, query)))
                {
                    EventRecord r;
                    while ((r = reader.ReadEvent()) != null)
                    {
                        using (r)
                        {
                            total++;
                            string text = r.Properties.Count > 0 ? r.Properties[0].Value as string : null;
                            Match m = BugCheck.Match(text ?? "");
                            if (m.Success && MemoryStopCodes.Contains(Convert.ToInt32(m.Groups[1].Value, 16))) memory++;
                        }
                    }
                }
            }
            catch { }
        }

        public static object Get()
        {
            var checks = new List<object>();
            var mem = (Dictionary<string, object>)MemoryInfo.Get();
            var modules = (List<object>)mem["modules"];

            int? hardwareErrors = Count("*[System[Provider[@Name='Microsoft-Windows-WHEA-Logger'] and (EventID=46 or EventID=47) and " + Last90Days + "]]");
            if (hardwareErrors == null)
                checks.Add(Check("whea", "Hardware memory errors", "unknown", "Unknown", "The Windows log couldn't be read."));
            else if (hardwareErrors == 0)
                checks.Add(Check("whea", "Hardware memory errors", "good", "None", "No memory errors logged by Windows in the last 90 days."));
            else
                checks.Add(Check("whea", "Hardware memory errors", "bad", hardwareErrors + " logged", "Windows recorded memory errors in the last 90 days. This is the clearest sign of a failing module."));

            int crashes, memoryCrashes;
            CountCrashes(out crashes, out memoryCrashes);
            if (memoryCrashes > 0)
                checks.Add(Check("crashes", "Crashes pointing at memory", "warn", memoryCrashes + " of " + crashes, "These blue screens use stop codes often caused by bad RAM, though drivers can cause them too. Worth running a memory test."));
            else
                checks.Add(Check("crashes", "Crashes pointing at memory", "good", "None", crashes > 0 ? crashes + " blue screen" + (crashes == 1 ? "" : "s") + " in the last 90 days, none with a memory stop code." : "No blue screens in the last 90 days."));

            var diagnostic = LastDiagnostic();
            if (diagnostic == null)
                checks.Add(Check("diagnostic", "Windows Memory Diagnostic", "unknown", "Not run", "The most thorough test available here. It needs a restart and takes about 15 minutes."));
            else if ((bool)diagnostic["passed"])
                checks.Add(Check("diagnostic", "Windows Memory Diagnostic", "good", "Passed", "Last run on " + diagnostic["date"] + ". No errors found."));
            else
                checks.Add(Check("diagnostic", "Windows Memory Diagnostic", "bad", "Failed", "Last run on " + diagnostic["date"] + ". It found errors, so at least one module is probably faulty."));

            var test = ReadTest();
            if (test != null)
            {
                long errors = Convert.ToInt64(test["errors"]);
                double gb = Convert.ToInt64(test["testedBytes"]) / (double)(1L << 30);
                checks.Add(Check("quick", "Quick test", errors > 0 ? "bad" : "good", errors > 0 ? errors + " errors" : "Passed", "Last run on " + test["date"] + " on " + gb.ToString("0.#") + " GB of memory." + (errors > 0 ? " Run the Windows Memory Diagnostic to confirm." : "")));
            }

            // Modules running below their rated speed aren't failing, but it's worth knowing.
            var slower = modules.Cast<Dictionary<string, object>>().Where(m => Convert.ToInt32(m["configuredSpeed"]) > 0 && Convert.ToInt32(m["configuredSpeed"]) < Convert.ToInt32(m["speed"])).ToList();
            if (slower.Count > 0)
            {
                var m = slower[0];
                checks.Add(Check("speed", "Running speed", "info", m["configuredSpeed"] + " of " + m["speed"] + " MT/s", "Below the rated speed. This isn't a fault: the processor, the BIOS or a mix of modules can set a lower limit."));
            }
            else if (modules.Count > 0)
            {
                checks.Add(Check("speed", "Running speed", "good", "At rated speed", "Every module runs at the speed it's rated for."));
            }

            var different = modules.Cast<Dictionary<string, object>>().Select(m => m["partNumber"] + "|" + m["capacity"]).Distinct().Count();
            if (modules.Count > 1)
                checks.Add(different == 1
                    ? Check("match", "Matching modules", "good", "Identical", "All modules are the same model, the most stable setup.")
                    : Check("match", "Matching modules", "info", "Mixed", "Different modules can work fine, but they run at the slowest one's speed and are more likely to cause instability."));

            string verdict = checks.Cast<Dictionary<string, object>>().Any(c => (string)c["status"] == "bad") ? "bad"
                : checks.Cast<Dictionary<string, object>>().Any(c => (string)c["status"] == "warn") ? "watch" : "good";
            string title = verdict == "bad" ? "Signs of a memory problem" : verdict == "watch" ? "Worth checking" : "No signs of trouble";
            string summary = verdict == "bad" ? "Run the Windows Memory Diagnostic. If it fails, test one module at a time to find the faulty one."
                : verdict == "watch" ? "Nothing certain yet. A memory test will tell you whether RAM is really the cause."
                : "RAM doesn't wear out the way SSDs and batteries do. It either works or develops faults, and none have been recorded.";

            // Temperature per module, if the modules have a sensor and the driver can read it.
            var temps = new List<double>();
            try
            {
                var sample = LiveSampler.Recent(30);
                foreach (Dictionary<string, object> s in (List<object>)sample["sensors"])
                    if ((string)s["group"] == "memory" && s.ContainsKey("celsius") && s["celsius"] != null) temps.Add(Convert.ToDouble(s["celsius"]));
            }
            catch { }

            var rows = new List<object>();
            for (int i = 0; i < modules.Count; i++)
            {
                var m = (Dictionary<string, object>)modules[i];
                rows.Add(J.D(
                    "slot", m["slot"],
                    "manufacturer", m["manufacturer"],
                    "partNumber", m["partNumber"],
                    "capacity", m["capacity"],
                    "ratedSpeed", m["speed"],
                    "configuredSpeed", m["configuredSpeed"],
                    "tempC", temps.Count == modules.Count ? (object)temps[i] : null));
            }

            return J.D("platform", "windows", "verdict", verdict, "title", title, "summary", summary, "checks", checks, "modules", rows, "canAttribute", false);
        }

        // ---- quick test ----
        static volatile int _token;
        static volatile bool _running;

        static Dictionary<string, object> ReadTest()
        {
            try
            {
                if (!File.Exists(TestPath)) return null;
                return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(TestPath));
            }
            catch { return null; }
        }

        public static object TestStart()
        {
            if (_running) throw new Exception("A memory test is already running.");
            ulong available = Native.MemStatus().ullAvailPhys;
            // Half of what's free, at most 4 GB, so the rest of the system keeps working normally.
            long size = (long)Math.Min(available / 2, 4UL << 30);
            if (size < (256L << 20)) throw new Exception("Too little memory is free to test. Close a few apps and try again.");
            int token = ++_token;
            _running = true;
            var t = new Thread(() => RunTest(size, token));
            t.IsBackground = true;
            t.Priority = ThreadPriority.BelowNormal;
            t.Start();
            return J.D("started", true, "bytes", size);
        }

        public static object TestCancel()
        {
            _token++;
            return J.D("cancelled", true);
        }

        static void RunTest(long size, int token)
        {
            const int BlockLongs = 8 * 1024 * 1024; // 64 MB
            var blocks = new List<long[]>();
            long errors = 0;
            var clock = Stopwatch.StartNew();
            try
            {
                try
                {
                    for (long done = 0; done < size; done += BlockLongs * 8L) blocks.Add(new long[BlockLongs]);
                }
                catch (OutOfMemoryException) { }

                long[] patterns = { 0L, -1L, unchecked((long)0xAAAAAAAAAAAAAAAAUL), 0x5555555555555555L, unchecked((long)0xCCCCCCCCCCCCCCCCUL), 0x3333333333333333L };
                int passes = patterns.Length + 1;
                long totalSteps = (long)passes * blocks.Count * 2;
                long step = 0;
                var ticker = Stopwatch.StartNew();

                for (int pass = 0; pass < passes && token == _token; pass++)
                {
                    bool byAddress = pass == patterns.Length;
                    for (int b = 0; b < blocks.Count && token == _token; b++)
                    {
                        long[] block = blocks[b];
                        long pattern = byAddress ? 0 : patterns[pass];
                        for (int i = 0; i < block.Length; i++) block[i] = byAddress ? ((long)b << 32) ^ i : pattern;
                        step++;
                        if (ticker.ElapsedMilliseconds > 400)
                        {
                            ticker.Restart();
                            Program.Emit("ramTest", J.D("state", "running", "percent", step * 100 / totalSteps, "errors", errors));
                        }
                    }
                    for (int b = 0; b < blocks.Count && token == _token; b++)
                    {
                        long[] block = blocks[b];
                        long pattern = byAddress ? 0 : patterns[pass];
                        for (int i = 0; i < block.Length; i++)
                        {
                            long expected = byAddress ? ((long)b << 32) ^ i : pattern;
                            if (block[i] != expected) errors++;
                        }
                        step++;
                        if (ticker.ElapsedMilliseconds > 400)
                        {
                            ticker.Restart();
                            Program.Emit("ramTest", J.D("state", "running", "percent", step * 100 / totalSteps, "errors", errors));
                        }
                    }
                }

                bool cancelled = token != _token;
                long tested = blocks.Count * (BlockLongs * 8L);
                if (!cancelled)
                {
                    var result = J.D("errors", errors, "testedBytes", tested, "seconds", (long)clock.Elapsed.TotalSeconds, "date", DateTime.Now.ToString("yyyy-MM-dd"));
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(TestPath));
                        File.WriteAllText(TestPath, new JavaScriptSerializer().Serialize(result));
                    }
                    catch { }
                }
                Program.Emit("ramTest", J.D("state", cancelled ? "cancelled" : "done", "percent", 100, "errors", errors, "testedBytes", tested));
            }
            catch (Exception ex)
            {
                Program.Emit("ramTest", J.D("state", "failed", "message", ex.Message, "errors", errors));
            }
            finally
            {
                blocks.Clear();
                _running = false;
                GC.Collect();
            }
        }

        // The Windows tool asks whether to restart now or next time, so nothing happens without you.
        public static object OpenDiagnostic()
        {
            Process.Start(new ProcessStartInfo("mdsched.exe") { UseShellExecute = true });
            return J.D("ok", true);
        }
    }
}
