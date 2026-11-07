using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace GUltra
{
    // Cleanup: categories and paths are defined ONLY here. The UI sends nothing but ids,
    // so it can't ask for an arbitrary path to be deleted.
    static class Cleaner
    {
        class Target
        {
            public string Root; public int MinAgeHours; public string Mask;
            public Target(string root, int minAgeHours = 0, string mask = null) { Root = root; MinAgeHours = minAgeHours; Mask = mask; }
        }

        class Category
        {
            public string Id, Group, Name, Desc, Note;
            public bool Admin, Default, RecycleBin;
            public string[] Processes = new string[0];
            public List<Target> Targets = new List<Target>();
        }

        public class Stats { public long Bytes; public long Files; public long Skipped; public long Dirs; }

        static string Local { get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }
        static string Roaming { get { return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); } }
        static string ProgramData { get { return Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData); } }
        static string WinDir { get { return Environment.GetFolderPath(Environment.SpecialFolder.Windows); } }

        static List<Category> Definitions()
        {
            var list = new List<Category>();

            list.Add(new Category
            {
                Id = "temp-user", Group = "system", Name = "Temporary files", Default = true,
                Desc = "Leftovers from apps and installers in your Temp folder.",
                Note = "Only files older than 24 hours that aren't in use are deleted.",
                Targets = { new Target(Path.Combine(Local, "Temp"), 24) }
            });
            list.Add(new Category
            {
                Id = "temp-windows", Group = "system", Name = "Windows temporary files", Default = true, Admin = true,
                Desc = "The operating system's Temp folder.",
                Note = "Only files older than 24 hours.",
                Targets = { new Target(Path.Combine(WinDir, "Temp"), 24) }
            });
            list.Add(new Category
            {
                Id = "winupdate", Group = "system", Name = "Windows Update downloads", Default = true, Admin = true,
                Desc = "Update packages that are already installed.",
                Note = "Windows downloads them again only if it still needs them.",
                Targets = { new Target(Path.Combine(WinDir, @"SoftwareDistribution\Download"), 72) }
            });
            list.Add(new Category
            {
                Id = "delivery", Group = "system", Name = "Delivery Optimization", Default = true, Admin = true,
                Desc = "Cache used to share updates between PCs.",
                Targets = { new Target(Path.Combine(WinDir, @"ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache")) }
            });
            list.Add(new Category
            {
                Id = "crash", Group = "system", Name = "Error reports and crash dumps", Default = true,
                Desc = "Files created when an app closes unexpectedly.",
                Note = "Only useful if you are actively debugging a problem.",
                Targets =
                {
                    new Target(Path.Combine(Local, "CrashDumps")),
                    new Target(Path.Combine(Local, @"Microsoft\Windows\WER")),
                    new Target(Path.Combine(ProgramData, @"Microsoft\Windows\WER")),
                    new Target(Path.Combine(WinDir, "Minidump")),
                }
            });
            list.Add(new Category
            {
                Id = "thumbs", Group = "system", Name = "Explorer thumbnails", Default = false,
                Desc = "The small previews in File Explorer.",
                Note = "They rebuild on their own, but photo folders load slower the first time.",
                Processes = new[] { "explorer" },
                Targets = { new Target(Path.Combine(Local, @"Microsoft\Windows\Explorer"), 0, "thumbcache_") }
            });
            list.Add(new Category
            {
                Id = "shader", Group = "system", Name = "Graphics shader cache", Default = false,
                Desc = "Shaders compiled by DirectX and your graphics driver.",
                Note = "Games may stutter briefly on first launch while they recompile.",
                Targets =
                {
                    new Target(Path.Combine(Local, "D3DSCache")),
                    new Target(Path.Combine(Local, @"NVIDIA\DXCache")),
                    new Target(Path.Combine(Local, @"NVIDIA\GLCache")),
                    new Target(Path.Combine(Local, @"AMD\DxCache")),
                    new Target(Path.Combine(Local, @"AMD\GLCache")),
                }
            });
            list.Add(new Category
            {
                Id = "recycle", Group = "system", Name = "Recycle Bin", Default = false, RecycleBin = true,
                Desc = "Deleted files that can still be recovered.",
                Note = "Once emptied, these files can't be recovered.",
            });

            AddBrowser(list, "chrome", "Google Chrome", new[] { "chrome" }, Path.Combine(Local, @"Google\Chrome\User Data"));
            AddBrowser(list, "edge", "Microsoft Edge", new[] { "msedge" }, Path.Combine(Local, @"Microsoft\Edge\User Data"));
            AddBrowser(list, "brave", "Brave", new[] { "brave" }, Path.Combine(Local, @"BraveSoftware\Brave-Browser\User Data"));
            AddBrowser(list, "vivaldi", "Vivaldi", new[] { "vivaldi" }, Path.Combine(Local, @"Vivaldi\User Data"));
            AddSingleProfileBrowser(list, "opera", "Opera", new[] { "opera" }, Path.Combine(Local, @"Opera Software\Opera Stable"));
            AddSingleProfileBrowser(list, "operagx", "Opera GX", new[] { "opera" }, Path.Combine(Local, @"Opera Software\Opera GX Stable"));
            AddFirefox(list);

            AddApp(list, "discord", "Discord", new[] { "Discord" }, Path.Combine(Roaming, "discord"));
            AddApp(list, "teams", "Microsoft Teams", new[] { "ms-teams", "Teams" }, Path.Combine(Roaming, @"Microsoft\Teams"));
            AddApp(list, "vscode", "Visual Studio Code", new[] { "Code" }, Path.Combine(Roaming, "Code"));
            AddApp(list, "slack", "Slack", new[] { "slack" }, Path.Combine(Roaming, "Slack"));
            string spotify = Path.Combine(Local, @"Spotify\Data");
            if (Directory.Exists(spotify))
                list.Add(new Category
                {
                    Id = "spotify", Group = "apps", Name = "Spotify", Default = false, Processes = new[] { "Spotify" },
                    Desc = "Songs kept temporarily for playback.",
                    Note = "They download again when you play them. Music saved for offline use may be affected.",
                    Targets = { new Target(spotify) }
                });

            string npm = Path.Combine(Local, "npm-cache");
            if (Directory.Exists(npm))
                list.Add(new Category
                {
                    Id = "npm", Group = "dev", Name = "npm cache", Default = false,
                    Desc = "Downloaded Node.js packages.", Note = "Future installs will download the packages again.",
                    Targets = { new Target(npm) }
                });
            string pip = Path.Combine(Local, @"pip\Cache");
            if (Directory.Exists(pip))
                list.Add(new Category
                {
                    Id = "pip", Group = "dev", Name = "pip cache", Default = false,
                    Desc = "Downloaded Python packages.", Note = "Future installs will download the packages again.",
                    Targets = { new Target(pip) }
                });

            return list;
        }

        static void AddBrowser(List<Category> list, string id, string name, string[] procs, string userData)
        {
            if (!Directory.Exists(userData)) return;
            var cat = BrowserCategory(id, name, procs);
            foreach (string profile in SafeDirs(userData))
            {
                string leaf = Path.GetFileName(profile);
                if (leaf != "Default" && !leaf.StartsWith("Profile ") && leaf != "Guest Profile") continue;
                AddCacheDirs(cat, profile);
            }
            string[] globals = { "ShaderCache", "GrShaderCache", "GraphiteDawnCache" };
            foreach (string g in globals) cat.Targets.Add(new Target(Path.Combine(userData, g)));
            list.Add(cat);
        }

        static void AddSingleProfileBrowser(List<Category> list, string id, string name, string[] procs, string profile)
        {
            if (!Directory.Exists(profile)) return;
            var cat = BrowserCategory(id, name, procs);
            AddCacheDirs(cat, profile);
            list.Add(cat);
        }

        static Category BrowserCategory(string id, string name, string[] procs)
        {
            return new Category
            {
                Id = "browser-" + id, Group = "browsers", Name = name, Default = true, Processes = procs,
                Desc = "Pages and images kept temporarily.",
                Note = "Passwords, history, cookies and tabs stay untouched."
            };
        }

        static void AddCacheDirs(Category cat, string profile)
        {
            cat.Targets.Add(new Target(Path.Combine(profile, "Cache")));
            cat.Targets.Add(new Target(Path.Combine(profile, "Code Cache")));
            cat.Targets.Add(new Target(Path.Combine(profile, "GPUCache")));
            cat.Targets.Add(new Target(Path.Combine(profile, "DawnGraphiteCache")));
            cat.Targets.Add(new Target(Path.Combine(profile, "DawnWebGPUCache")));
        }

        static void AddFirefox(List<Category> list)
        {
            string profiles = Path.Combine(Local, @"Mozilla\Firefox\Profiles");
            if (!Directory.Exists(profiles)) return;
            var cat = BrowserCategory("firefox", "Mozilla Firefox", new[] { "firefox" });
            foreach (string p in SafeDirs(profiles))
            {
                cat.Targets.Add(new Target(Path.Combine(p, "cache2")));
                cat.Targets.Add(new Target(Path.Combine(p, "startupCache")));
            }
            list.Add(cat);
        }

        static void AddApp(List<Category> list, string id, string name, string[] procs, string root)
        {
            if (!Directory.Exists(root)) return;
            list.Add(new Category
            {
                Id = "app-" + id, Group = "apps", Name = name, Default = true, Processes = procs,
                Desc = "The app's cache.", Note = "Accounts and settings stay untouched.",
                Targets =
                {
                    new Target(Path.Combine(root, "Cache")),
                    new Target(Path.Combine(root, "Code Cache")),
                    new Target(Path.Combine(root, "GPUCache")),
                }
            });
        }

        static IEnumerable<string> SafeDirs(string dir)
        {
            try { return Directory.GetDirectories(dir); } catch { return new string[0]; }
        }

public static object Scan()
        {
            bool elevated = SystemInfo.IsElevated();
            var running = new HashSet<string>(ProcessList.Snapshot().Select(e => e.Name), StringComparer.OrdinalIgnoreCase);
            var defs = Definitions();

            // The list appears at once and sizes arrive one by one, so one huge cache can't hold up the rest.
            Func<Category, object, long, object> describe = (c, bytes, files) => J.D(
                "id", c.Id,
                "group", c.Group,
                "name", c.Name,
                "desc", c.Desc,
                "note", c.Note,
                "bytes", bytes,
                "files", files,
                "needsAdmin", c.Admin && !elevated,
                "defaultOn", c.Default,
                "busy", c.Processes.Any(running.Contains));
            Program.Emit("cleanList", defs.Select(c => describe(c, null, 0L)).ToList());

            var res = new object[defs.Count];
            var options = new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 4 };
            System.Threading.Tasks.Parallel.For(0, defs.Count, options, i =>
            {
                Native.SetThreadPriority(Native.GetCurrentThread(), Native.THREAD_PRIORITY_BELOW_NORMAL);
                try
                {
                    var c = defs[i];
                    var s = new Stats();
                    if (c.RecycleBin)
                    {
                        var info = new Native.SHQUERYRBINFO { cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Native.SHQUERYRBINFO)) };
                        if (Native.SHQueryRecycleBin(null, ref info) == 0) { s.Bytes = info.i64Size; s.Files = info.i64NumItems; }
                    }
                    else
                    {
                        foreach (var t in c.Targets) Walk(t, s, false);
                    }
                    res[i] = describe(c, s.Bytes, s.Files);
                    Program.Emit("cleanItem", res[i]);
                }
                finally { Native.SetThreadPriority(Native.GetCurrentThread(), 0); }
            });
            return J.D("platform", "windows", "categories", res.ToList(), "elevated", elevated);
        }

        static volatile bool _cancelRun;

        public static object Cancel()
        {
            _cancelRun = true;
            return J.D("cancelled", true);
        }

        public static object Run(List<string> ids)
        {
            _cancelRun = false;
            bool elevated = SystemInfo.IsElevated();
            var defs = Definitions().Where(c => ids.Contains(c.Id)).ToList();
            var results = new List<object>();
            long freed = 0, skipped = 0, files = 0;
            int index = 0;
            foreach (var c in defs)
            {
                if (_cancelRun) break;
                Program.Emit("cleanRun", J.D("index", index++, "total", defs.Count, "name", c.Name, "freed", freed));
                var s = new Stats();
                if (c.Admin && !elevated)
                {
                    results.Add(J.D("id", c.Id, "name", c.Name, "freed", 0L, "files", 0L, "skipped", 0L, "error", "admin"));
                    continue;
                }
                if (c.RecycleBin)
                {
                    var info = new Native.SHQUERYRBINFO { cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Native.SHQUERYRBINFO)) };
                    Native.SHQueryRecycleBin(null, ref info);
                    if (Native.SHEmptyRecycleBin(IntPtr.Zero, null, 7) == 0) { s.Bytes = info.i64Size; s.Files = info.i64NumItems; }
                }
                else
                {
                    foreach (var t in c.Targets) Walk(t, s, true);
                }
                freed += s.Bytes; skipped += s.Skipped; files += s.Files;
                results.Add(J.D("id", c.Id, "name", c.Name, "freed", s.Bytes, "files", s.Files, "skipped", s.Skipped));
            }
            return J.D("freed", freed, "files", files, "skipped", skipped, "results", results, "cancelled", _cancelRun);
        }

        static void Walk(Target t, Stats s, bool delete)
        {
            if (!IsSafeRoot(t.Root) || !Directory.Exists(t.Root)) return;
            DateTime cutoff = t.MinAgeHours > 0 ? DateTime.UtcNow.AddHours(-t.MinAgeHours) : DateTime.MaxValue;
            WalkDir(t.Root, cutoff, t.Mask, s, delete);
        }

        // Refuses any root that isn't clearly a cache folder deep in the tree.
        public static bool IsSafeRoot(string path)
        {
            try
            {
                string full = Path.GetFullPath(path).TrimEnd('\\');
                string[] forbidden =
                {
                    Path.GetPathRoot(full).TrimEnd('\\'), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    Local, Roaming, ProgramData, WinDir, Path.Combine(WinDir, "System32"),
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    Environment.GetFolderPath(Environment.SpecialFolder.Desktop),
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                };
                foreach (string f in forbidden)
                    if (string.Equals(full, f.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return false;
                return full.Split('\\').Length >= 3;
            }
            catch { return false; }
        }

        // Never enters symlinks or junctions: they can lead out of the folder being cleaned.
        public static void WalkDir(string dir, DateTime cutoff, string mask, Stats s, bool delete)
        {
            Native.WIN32_FIND_DATA d;
            IntPtr h = Native.FindFirstFileEx(@"\\?\" + dir + @"\*", 1, out d, 0, IntPtr.Zero, Native.FIND_FIRST_EX_LARGE_FETCH);
            if (h == Native.INVALID_HANDLE) return;
            try
            {
                do
                {
                    if (delete && _cancelRun) return;
                    string name = d.cFileName;
                    if (name == "." || name == "..") continue;
                    if ((d.dwFileAttributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0) continue;
                    string path = dir + @"\" + name;
                    DateTime written = DateTime.FromFileTimeUtc(d.ftLastWriteTime);
                    if ((d.dwFileAttributes & Native.FILE_ATTRIBUTE_DIRECTORY) != 0)
                    {
                        WalkDir(path, cutoff, mask, s, delete);
                        if (delete && cutoff == DateTime.MaxValue || delete && written < cutoff)
                            if (Native.RemoveDirectory(@"\\?\" + path)) s.Dirs++;
                        continue;
                    }
                    if (mask != null && !name.StartsWith(mask, StringComparison.OrdinalIgnoreCase)) continue;
                    DateTime created = DateTime.FromFileTimeUtc(d.ftCreationTime);
                    if (cutoff != DateTime.MaxValue && (written >= cutoff || created >= cutoff)) continue;

                    long size = ((long)d.nFileSizeHigh << 32) | d.nFileSizeLow;
                    if (!delete) { s.Bytes += size; s.Files++; continue; }
                    string longPath = @"\\?\" + path;
                    if ((d.dwFileAttributes & 1) != 0) Native.SetFileAttributes(longPath, 0x80);
                    if (Native.DeleteFile(longPath))
                    {
                        s.Bytes += size;
                        s.Files++;
                    }
                    else s.Skipped++;
                } while (Native.FindNextFile(h, out d));
            }
            finally { Native.FindClose(h); }
        }
    }

    // Space analysis: builds the folder tree on a low-priority thread.
    static class FolderScanner
    {
        class Node
        {
            public string Name; public long Size; public long Files; public long OwnBytes; public List<Node> Kids;
        }

        class Top { public string Path; public long Size; }

        static readonly object Lock = new object();
        static Node _root;
        static string _rootPath;
        static volatile int _token;
        static long _files, _dirs, _bytes, _denied;
        static string _current;
        static List<Top> _top = new List<Top>();
        const int TopCount = 60;

        public static object Start(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new Exception("No path given.");
            string norm = Path.GetFullPath(path);
            if (!norm.EndsWith("\\")) norm += "\\";
            if (!Directory.Exists(norm)) throw new Exception("That folder doesn't exist.");

            int token = ++_token;
            var t = new System.Threading.Thread(() => Run(norm, token), 16 * 1024 * 1024);
            t.IsBackground = true;
            t.Start();
            return J.D("started", true, "path", norm);
        }

        public static object Cancel()
        {
            _token++;
            return J.D("cancelled", true);
        }

        static void Run(string rootPath, int token)
        {
            Native.SetThreadPriority(Native.GetCurrentThread(), Native.THREAD_PRIORITY_BELOW_NORMAL);
            _files = _dirs = _bytes = _denied = 0;
            var top = new List<Top>();
            var root = new Node { Name = rootPath };
            var ticker = Stopwatch.StartNew();

            Emit("running", rootPath, token);
            Walk(rootPath.TrimEnd('\\'), root, top, token, ticker);

            if (token != _token) return;
            lock (Lock)
            {
                _root = root;
                _rootPath = rootPath;
                _top = top.OrderByDescending(x => x.Size).Take(TopCount).ToList();
            }
            Emit("done", rootPath, token);
        }

        static void Emit(string state, string path, int token)
        {
            if (token != _token) return;
            Program.Emit("scan", J.D("state", state, "path", path, "files", _files, "dirs", _dirs, "bytes", _bytes, "denied", _denied, "current", _current));
        }

        static void Walk(string dir, Node node, List<Top> top, int token, Stopwatch ticker)
        {
            if (token != _token) return;
            Native.WIN32_FIND_DATA d;
            IntPtr h = Native.FindFirstFileEx(@"\\?\" + dir + @"\*", 1, out d, 0, IntPtr.Zero, Native.FIND_FIRST_EX_LARGE_FETCH);
            if (h == Native.INVALID_HANDLE) { _denied++; return; }
            try
            {
                do
                {
                    string name = d.cFileName;
                    if (name == "." || name == "..") continue;
                    if ((d.dwFileAttributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0) continue;
                    if ((d.dwFileAttributes & Native.FILE_ATTRIBUTE_DIRECTORY) != 0)
                    {
                        var kid = new Node { Name = name };
                        if (node.Kids == null) node.Kids = new List<Node>();
                        node.Kids.Add(kid);
                        _dirs++;
                        _current = dir;
                        Walk(dir + @"\" + name, kid, top, token, ticker);
                        node.Size += kid.Size;
                        node.Files += kid.Files;
                        if (token != _token) return;
                    }
                    else
                    {
                        long size = ((long)d.nFileSizeHigh << 32) | d.nFileSizeLow;
                        node.Size += size;
                        node.OwnBytes += size;
                        node.Files++;
                        _files++;
                        _bytes += size;
                        if (size > 50L * 1024 * 1024)
                        {
                            top.Add(new Top { Path = dir + @"\" + name, Size = size });
                            if (top.Count > TopCount * 4)
                            {
                                top.Sort((a, b) => b.Size.CompareTo(a.Size));
                                top.RemoveRange(TopCount, top.Count - TopCount);
                            }
                        }
                    }
                    if (ticker.ElapsedMilliseconds > 180)
                    {
                        ticker.Restart();
                        Emit("running", null, token);
                    }
                } while (Native.FindNextFile(h, out d));
            }
            finally { Native.FindClose(h); }
        }

        public static object GetNode(string path)
        {
            lock (Lock)
            {
                if (_root == null) throw new Exception("No finished analysis yet.");
                string rootTrim = _rootPath.TrimEnd('\\');
                string target = string.IsNullOrEmpty(path) ? rootTrim : path.TrimEnd('\\');
                Node cur = _root;
                if (!string.Equals(target, rootTrim, StringComparison.OrdinalIgnoreCase))
                {
                    if (!target.StartsWith(rootTrim + "\\", StringComparison.OrdinalIgnoreCase)) throw new Exception("That path is outside the analysis.");
                    foreach (string seg in target.Substring(rootTrim.Length + 1).Split('\\'))
                    {
                        cur = cur.Kids == null ? null : cur.Kids.FirstOrDefault(k => string.Equals(k.Name, seg, StringComparison.OrdinalIgnoreCase));
                        if (cur == null) throw new Exception("That folder is no longer in the analysis.");
                    }
                }

                var folders = (cur.Kids ?? new List<Node>())
                    .OrderByDescending(k => k.Size).Take(120)
                    .Select(k => (object)J.D("name", k.Name, "path", target + "\\" + k.Name, "size", k.Size, "files", k.Files, "isDir", true))
                    .ToList();

                return J.D(
                    "path", target,
                    "name", target == rootTrim ? _rootPath : cur.Name,
                    "size", cur.Size,
                    "files", cur.Files,
                    "ownBytes", cur.OwnBytes,
                    "folders", folders,
                    "items", ListFiles(target),
                    "largest", target == rootTrim
                        ? _top.Select(x => (object)J.D("name", Path.GetFileName(x.Path), "path", x.Path, "size", x.Size)).ToList()
                        : null,
                    "denied", _denied,
                    "isRoot", target == rootTrim);
            }
        }

        // Files directly in a folder are read on demand, which keeps the tree small in memory.
        static List<object> ListFiles(string dir)
        {
            var files = new List<Top>();
            Native.WIN32_FIND_DATA d;
            IntPtr h = Native.FindFirstFileEx(@"\\?\" + dir + @"\*", 1, out d, 0, IntPtr.Zero, Native.FIND_FIRST_EX_LARGE_FETCH);
            if (h == Native.INVALID_HANDLE) return new List<object>();
            try
            {
                do
                {
                    if ((d.dwFileAttributes & Native.FILE_ATTRIBUTE_DIRECTORY) != 0) continue;
                    files.Add(new Top { Path = dir + @"\" + d.cFileName, Size = ((long)d.nFileSizeHigh << 32) | d.nFileSizeLow });
                } while (Native.FindNextFile(h, out d));
            }
            finally { Native.FindClose(h); }
            return files.OrderByDescending(f => f.Size).Take(40)
                .Select(f => (object)J.D("name", Path.GetFileName(f.Path), "path", f.Path, "size", f.Size)).ToList();
        }
    }

#if SELFTEST
    // A separate test build (/define:SELFTEST). It only touches its own temp folder, processes it
    // creates itself, and one registry value for a fake program that it removes again.
    class FakeFan : IFanControl
    {
        public float Last = -1;
        public bool Manual;
        public string Id { get { return "fake"; } }
        public string Name { get { return "Fan 1"; } }
        public string Hardware { get { return "Test board"; } }
        public string Group { get { return "board"; } }
        public double? Rpm { get { return 1000; } }
        public double? Percent { get { return Last; } }
        public bool CanControl { get { return true; } }
        public bool IsManual { get { return Manual; } }
        public float MinPercent { get { return 0; } }
        public float MaxPercent { get { return 100; } }
        public void Set(float percent) { Last = percent; Manual = true; }
        public void Auto() { Manual = false; }
    }

    static class SelfTest
    {
        public static int Run(string[] args)
        {
            string root = Path.Combine(args[0], "selftest-" + Guid.NewGuid().ToString("N"));
            string outside = root + "-outside";
            Directory.CreateDirectory(Path.Combine(root, @"cache\sub"));
            Directory.CreateDirectory(outside);

            File.WriteAllText(Path.Combine(root, @"cache\old.tmp"), new string('x', 1000));
            File.WriteAllText(Path.Combine(root, @"cache\sub\old2.tmp"), new string('x', 500));
            File.WriteAllText(Path.Combine(root, @"cache\new.tmp"), new string('x', 200));
            File.WriteAllText(Path.Combine(outside, "keep.txt"), "MUST NOT BE DELETED");
            File.SetLastWriteTimeUtc(Path.Combine(root, @"cache\old.tmp"), DateTime.UtcNow.AddDays(-3));
            File.SetCreationTimeUtc(Path.Combine(root, @"cache\old.tmp"), DateTime.UtcNow.AddDays(-3));
            File.SetLastWriteTimeUtc(Path.Combine(root, @"cache\sub\old2.tmp"), DateTime.UtcNow.AddDays(-3));
            File.SetCreationTimeUtc(Path.Combine(root, @"cache\sub\old2.tmp"), DateTime.UtcNow.AddDays(-3));
            Directory.SetLastWriteTimeUtc(Path.Combine(root, @"cache\sub"), DateTime.UtcNow.AddDays(-3));

            // A junction pointing outside: cleanup must not follow it.
            var mk = Process.Start(new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + Path.Combine(root, @"cache\link") + "\" \"" + outside + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true });
            mk.WaitForExit();

            int failed = 0;
            Action<string, bool> check = (label, ok) => { Console.WriteLine((ok ? "OK   " : "FAIL ") + label); if (!ok) failed++; };

            DateTime cutoff = DateTime.UtcNow.AddHours(-24);
            var scan = new Cleaner.Stats();
            Cleaner.WalkDir(Path.Combine(root, "cache"), cutoff, null, scan, false);
            check("scan counts only old files (1500 B)", scan.Bytes == 1500 && scan.Files == 2);
            check("scan deletes nothing", File.Exists(Path.Combine(root, @"cache\old.tmp")));

            var run = new Cleaner.Stats();
            Cleaner.WalkDir(Path.Combine(root, "cache"), cutoff, null, run, true);
            check("delete frees 1500 B", run.Bytes == 1500);
            check("old file is gone", !File.Exists(Path.Combine(root, @"cache\old.tmp")));
            check("recent file stays", File.Exists(Path.Combine(root, @"cache\new.tmp")));
            check("empty subfolder is removed", !Directory.Exists(Path.Combine(root, @"cache\sub")));
            check("file behind the junction stays", File.Exists(Path.Combine(outside, "keep.txt")));

            // A busy file must be skipped without stopping the run.
            string lockedPath = Path.Combine(root, @"cache\locked.tmp");
            using (var locked = new FileStream(lockedPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                locked.WriteByte(1);
                var r2 = new Cleaner.Stats();
                Cleaner.WalkDir(Path.Combine(root, "cache"), DateTime.MaxValue, null, r2, true);
                check("locked file is skipped", r2.Skipped == 1 && File.Exists(lockedPath));
            }

            // Cancelling stops the run before more files go.
            for (int i = 0; i < 50; i++) File.WriteAllText(Path.Combine(root, @"cache\c" + i + ".tmp"), "x");
            Cleaner.Cancel();
            var r3 = new Cleaner.Stats();
            Cleaner.WalkDir(Path.Combine(root, "cache"), DateTime.MaxValue, null, r3, true);
            check("a cancelled run deletes nothing more", r3.Files == 0 && File.Exists(Path.Combine(root, @"cache\c0.tmp")));

            check("refuses C:\\", !Cleaner.IsSafeRoot(@"C:\"));
            check("refuses the user profile", !Cleaner.IsSafeRoot(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
            check("refuses Windows", !Cleaner.IsSafeRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows)));
            check("refuses Desktop", !Cleaner.IsSafeRoot(Environment.GetFolderPath(Environment.SpecialFolder.Desktop)));
            check("accepts a cache folder", Cleaner.IsSafeRoot(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Temp")));

            // Freeing memory: on this process, with a block of touched memory.
            var block = new byte[200 * 1024 * 1024];
            for (int i = 0; i < block.Length; i += 4096) block[i] = 1;
            var self = Process.GetCurrentProcess();
            self.Refresh();
            long wsBefore = self.WorkingSet64;
            check("EmptyWorkingSet succeeds", Native.EmptyWorkingSet(self.Handle));
            self.Refresh();
            check("process memory drops by over 100 MB", wsBefore - self.WorkingSet64 > 100L * 1024 * 1024);
            GC.KeepAlive(block);

            // Ending a process: a child created by this test.
            var child = Process.Start(new ProcessStartInfo("ping.exe", "-n 60 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true });
            System.Threading.Thread.Sleep(300);
            var soft = (Dictionary<string, object>)ProcessList.End(new List<int> { child.Id }, false);
            check("a gentle close doesn't force a windowless process", !child.HasExited && (int)soft["remaining"] == 1);
            var hard = (Dictionary<string, object>)ProcessList.End(new List<int> { child.Id }, true);
            child.WaitForExit(3000);
            check("a forced stop ends it", child.HasExited && (int)hard["closed"] == 1);
            foreach (string name in new[] { "csrss", "lsass", "winlogon", "services", "svchost", "explorer", "dwm", "System" })
                check("protected process: " + name, ProcessList.Critical.Contains(name));

            // The process snapshot: the x64 layout has to yield plausible data.
            var snap = ProcessList.Snapshot();
            var me = snap.FirstOrDefault(e => e.Pid == self.Id);
            check("snapshot finds this process", me.Pid == self.Id && me.Name.IndexOf("SelfTest", StringComparison.OrdinalIgnoreCase) >= 0);
            check("snapshot has over 20 named processes", snap.Count > 20 && snap.All(e => !string.IsNullOrEmpty(e.Name)));
            check("memory figure is plausible", me.Ws > 0 && me.Ws < 2L * 1024 * 1024 * 1024);

            // Fan guard rails, on a fake fan.
            var fan = new FakeFan();
            var events = new List<string>();
            Fans.Notify = (n, d) => events.Add(n);
            Fans.Update(new List<IFanControl> { fan });
            Fans.Set("fake", 0);
            check("a fan can't go below the 30% floor", Math.Abs(fan.Last - Fans.FloorPercent) < 0.01 && fan.Manual);
            Fans.Set("fake", 150);
            check("a fan can't go above its maximum", Math.Abs(fan.Last - 100) < 0.01);
            Fans.Watchdog(70);
            check("watchdog leaves manual control alone at 70 degrees", fan.Manual && events.Count == 0);
            Fans.Watchdog(91);
            check("watchdog returns to automatic at 91 degrees", !fan.Manual && events.Contains("fanSafety"));
            bool refused = false;
            try { Fans.Set("fake", 50); } catch { refused = true; }
            check("manual control is refused while too hot", refused && !fan.Manual);
            Fans.Watchdog(85);
            refused = false;
            try { Fans.Set("fake", 50); } catch { refused = true; }
            check("still refused at 85 degrees", refused);
            Fans.Watchdog(75);
            Fans.Set("fake", 50);
            check("allowed again once below 80 degrees", fan.Manual && Math.Abs(fan.Last - 50) < 0.01);
            Fans.RestoreAll();
            check("closing the app returns fans to automatic", !fan.Manual);

            // Per-app GPU preference, on a fake program in the temp folder.
            string fakeExe = Path.Combine(root, "gultra-selftest.exe");
            File.WriteAllText(fakeExe, "not a real program");
            Func<int?> readPref = () =>
            {
                foreach (Dictionary<string, object> p in GpuSettings.Prefs())
                    if (string.Equals((string)p["path"], fakeExe, StringComparison.OrdinalIgnoreCase)) return (int)p["pref"];
                return null;
            };
            GpuSettings.SetPref(fakeExe, 2);
            check("GPU preference is saved", readPref() == 2);
            GpuSettings.SetPref(fakeExe, 0);
            check("Let Windows decide removes the entry", readPref() == null);
            refused = false;
            try { GpuSettings.SetPref(fakeExe + ".missing.exe", 2); } catch { refused = true; }
            check("a missing program is refused", refused);

            Directory.Delete(Path.Combine(root, @"cache\link"));
            Directory.Delete(root, true);
            Directory.Delete(outside, true);
            Console.WriteLine(failed == 0 ? "ALL TESTS PASSED" : failed + " TESTS FAILED");
            return failed == 0 ? 0 : 1;
        }
    }
#endif
}
