using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace GUltra
{
    // Restores what's still in the Recycle Bin. Paths come from Windows' own $I records,
    // and the UI only ever sends back the ids this class handed out.
    static class RecycleBin
    {
        sealed class Item
        {
            public string Id, Name, Original, Stored, Info;
            public long Size, DeletedMs;
            public bool IsDir;
        }

        static List<Item> Read()
        {
            var items = new List<Item>();
            string sid = WindowsIdentity.GetCurrent().User.Value;
            foreach (DriveInfo d in DriveInfo.GetDrives())
            {
                try
                {
                    if (!d.IsReady || (d.DriveType != DriveType.Fixed && d.DriveType != DriveType.Removable)) continue;
                    string dir = Path.Combine(d.RootDirectory.FullName, "$Recycle.Bin", sid);
                    if (!Directory.Exists(dir)) continue;
                    foreach (string info in Directory.GetFiles(dir, "$I*"))
                    {
                        Item item = Parse(info, d.Name);
                        if (item != null) items.Add(item);
                    }
                }
                catch { }
            }
            return items;
        }

        static Item Parse(string infoPath, string drive)
        {
            try
            {
                byte[] b = File.ReadAllBytes(infoPath);
                if (b.Length < 28) return null;
                long version = BitConverter.ToInt64(b, 0);
                string original;
                if (version == 2)
                {
                    int chars = BitConverter.ToInt32(b, 24);
                    if (chars <= 0 || 28 + chars * 2 > b.Length) return null;
                    original = Encoding.Unicode.GetString(b, 28, chars * 2);
                }
                else if (version == 1)
                {
                    original = Encoding.Unicode.GetString(b, 24, Math.Min(520, b.Length - 24));
                }
                else return null;
                original = original.TrimEnd('\0');
                if (!Path.IsPathRooted(original)) return null;

                string fileName = Path.GetFileName(infoPath);
                string stored = Path.Combine(Path.GetDirectoryName(infoPath), "$R" + fileName.Substring(2));
                bool isDir = Directory.Exists(stored);
                if (!isDir && !File.Exists(stored)) return null;

                long deleted = 0;
                try { deleted = (long)(DateTime.FromFileTimeUtc(BitConverter.ToInt64(b, 16)) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
                catch { }
                return new Item
                {
                    Id = drive + fileName,
                    Name = Path.GetFileName(original),
                    Original = original,
                    Stored = stored,
                    Info = infoPath,
                    Size = BitConverter.ToInt64(b, 8),
                    DeletedMs = deleted,
                    IsDir = isDir,
                };
            }
            catch { return null; }
        }

        public static object List()
        {
            return Read().OrderByDescending(i => i.DeletedMs).Select(i => (object)J.D(
                "id", i.Id, "name", i.Name, "original", i.Original, "size", i.Size, "deletedMs", i.DeletedMs, "isDir", i.IsDir)).ToList();
        }

        public static object Restore(List<string> ids)
        {
            Dictionary<string, Item> known = Read().ToDictionary(i => i.Id);
            var results = new List<object>();
            foreach (string id in ids)
            {
                Item item;
                if (!known.TryGetValue(id, out item))
                {
                    results.Add(J.D("id", id, "ok", false, "message", "It's no longer in the Recycle Bin."));
                    continue;
                }
                try
                {
                    string target = FreeName(item.Original);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    if (item.IsDir) Directory.Move(item.Stored, target);
                    else File.Move(item.Stored, target);
                    try { File.Delete(item.Info); } catch { }
                    results.Add(J.D("id", id, "ok", true, "message", target));
                }
                catch (Exception ex)
                {
                    results.Add(J.D("id", id, "ok", false, "message", ex.Message));
                }
            }
            return results;
        }

        // Never overwrites a file that has since taken the old name.
        public static string FreeName(string path)
        {
            if (!File.Exists(path) && !Directory.Exists(path)) return path;
            string dir = Path.GetDirectoryName(path), stem = Path.GetFileNameWithoutExtension(path), ext = Path.GetExtension(path);
            for (int i = 1; ; i++)
            {
                string next = Path.Combine(dir, stem + " (restored" + (i > 1 ? " " + i : "") + ")" + ext);
                if (!File.Exists(next) && !Directory.Exists(next)) return next;
            }
        }
    }

    // Reads an NTFS drive directly to find files whose records are marked deleted.
    // The drive is only ever opened for reading, and recovered files must go to a different drive,
    // because writing to the same one could overwrite what's being recovered.
    sealed class NtfsVolume : IDisposable
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetFilePointerEx(SafeFileHandle file, long distance, IntPtr newPosition, uint method);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadFile(SafeFileHandle file, byte[] buffer, int count, out int read, IntPtr overlapped);

        public struct Run
        {
            public long Lcn;   // -1 for a sparse run
            public long Length;
        }

        readonly SafeFileHandle _handle;
        public readonly int SectorSize, ClusterSize, RecordSize;
        public readonly long TotalClusters;
        public List<Run> MftRuns = new List<Run>();
        public long MftBytes;
        byte[] _bitmap;

        public NtfsVolume(char letter)
        {
            const uint GenericRead = 0x80000000, ShareAll = 7, OpenExisting = 3;
            _handle = CreateFileW(@"\\.\" + letter + ":", GenericRead, ShareAll, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (_handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                throw new Exception(error == 5 ? "Scanning a drive needs full mode." : "Couldn't open the drive (error " + error + ").");
            }

            byte[] boot = new byte[4096];
            ReadExact(0, boot, 4096);
            if (Encoding.ASCII.GetString(boot, 3, 4) != "NTFS") throw new Exception("Only NTFS drives can be scanned.");
            SectorSize = BitConverter.ToUInt16(boot, 0x0B);
            int spc = boot[0x0D];
            if (spc > 128) spc = 1 << (256 - spc);
            ClusterSize = SectorSize * spc;
            TotalClusters = BitConverter.ToInt64(boot, 0x28) / spc;
            long mftLcn = BitConverter.ToInt64(boot, 0x30);
            int perRecord = (sbyte)boot[0x40];
            RecordSize = perRecord > 0 ? perRecord * ClusterSize : 1 << -perRecord;
            if (SectorSize < 512 || ClusterSize <= 0 || RecordSize < 512 || RecordSize > 65536 || mftLcn <= 0) throw new Exception("This drive's layout couldn't be read.");

            LoadMftRuns(mftLcn);
        }

        public void Dispose()
        {
            _handle.Dispose();
        }

        void ReadExact(long offset, byte[] buffer, int count)
        {
            if (!SetFilePointerEx(_handle, offset, IntPtr.Zero, 0)) throw new IOException("Seek failed.");
            int read;
            if (!ReadFile(_handle, buffer, count, out read, IntPtr.Zero) || read != count) throw new IOException("Read failed.");
        }

        // Reads any byte range. Volume reads must start and end on sector boundaries.
        public void ReadBytes(long offset, byte[] buffer, int bufferOffset, int count)
        {
            long start = offset / SectorSize * SectorSize;
            int lead = (int)(offset - start);
            int total = (lead + count + SectorSize - 1) / SectorSize * SectorSize;
            byte[] temp = new byte[total];
            ReadExact(start, temp, total);
            Buffer.BlockCopy(temp, lead, buffer, bufferOffset, count);
        }

        void LoadMftRuns(long mftLcn)
        {
            byte[] record = new byte[RecordSize];
            ReadBytes(mftLcn * ClusterSize, record, 0, RecordSize);
            if (!ApplyFixups(record)) throw new Exception("The drive's file table couldn't be read.");
            long real;
            var segments = new List<KeyValuePair<long, List<Run>>>();
            real = CollectData(record, segments);
            MftBytes = real;
            foreach (var s in segments.OrderBy(x => x.Key)) MftRuns.AddRange(s.Value);

            // A very fragmented file table continues in other records, listed in its attribute list.
            long covered = MftRuns.Sum(r => r.Length) * ClusterSize;
            if (covered < MftBytes)
            {
                foreach (long extra in ListedRecords(record))
                {
                    byte[] ext = new byte[RecordSize];
                    if (!ReadMft(extra * RecordSize, ext, 0, RecordSize) || !ApplyFixups(ext)) continue;
                    segments.Clear();
                    CollectData(ext, segments);
                    foreach (var s in segments.OrderBy(x => x.Key)) MftRuns.AddRange(s.Value);
                }
            }
        }

        // Record numbers holding parts of the $DATA attribute, from an attribute list in this record.
        IEnumerable<long> ListedRecords(byte[] record)
        {
            var found = new SortedSet<long>();
            foreach (Attr a in Attributes(record))
            {
                if (a.Type != 0x20 || a.NonResident) continue;
                int p = a.ValueOffset, end = a.ValueOffset + a.ValueLength;
                while (p + 26 <= end)
                {
                    uint type = BitConverter.ToUInt32(record, p);
                    int len = BitConverter.ToUInt16(record, p + 4);
                    if (len == 0) break;
                    if (type == 0x80)
                    {
                        long reference = BitConverter.ToInt64(record, p + 16) & 0xFFFFFFFFFFFFL;
                        if (reference != 0) found.Add(reference);
                    }
                    p += len;
                }
            }
            return found;
        }

        public bool ReadMft(long byteOffset, byte[] buffer, int bufferOffset, int count)
        {
            long vcnStart = 0;
            foreach (Run r in MftRuns)
            {
                long runBytes = r.Length * ClusterSize;
                long runStart = vcnStart * ClusterSize;
                if (count > 0 && byteOffset < runStart + runBytes && r.Lcn >= 0)
                {
                    long within = byteOffset - runStart;
                    if (within >= 0)
                    {
                        int take = (int)Math.Min(count, runBytes - within);
                        ReadBytes(r.Lcn * ClusterSize + within, buffer, bufferOffset, take);
                        byteOffset += take;
                        bufferOffset += take;
                        count -= take;
                    }
                }
                vcnStart += r.Length;
            }
            return count == 0;
        }

        public bool ApplyFixups(byte[] b)
        {
            return ApplyFixups(b, 0);
        }

        public bool ApplyFixups(byte[] b, int at)
        {
            if (b[at] != 'F' || b[at + 1] != 'I' || b[at + 2] != 'L' || b[at + 3] != 'E') return false;
            int usaOffset = BitConverter.ToUInt16(b, at + 4), usaCount = BitConverter.ToUInt16(b, at + 6);
            if (usaOffset + usaCount * 2 > RecordSize || usaCount < 1) return false;
            byte lo = b[at + usaOffset], hi = b[at + usaOffset + 1];
            for (int i = 1; i < usaCount; i++)
            {
                int end = at + i * 512 - 2;
                if (end + 1 >= at + RecordSize) break;
                if (b[end] != lo || b[end + 1] != hi) return false;
                b[end] = b[at + usaOffset + i * 2];
                b[end + 1] = b[at + usaOffset + i * 2 + 1];
            }
            return true;
        }

        public struct Attr
        {
            public uint Type;
            public bool NonResident;
            public int NameLength, Flags, Start, Length;
            public int ValueOffset, ValueLength;
        }

        public IEnumerable<Attr> Attributes(byte[] b)
        {
            return Attributes(b, 0);
        }

        public IEnumerable<Attr> Attributes(byte[] b, int at)
        {
            int limit = at + RecordSize;
            int p = at + BitConverter.ToUInt16(b, at + 0x14);
            while (p + 16 <= limit)
            {
                uint type = BitConverter.ToUInt32(b, p);
                if (type == 0xFFFFFFFF) yield break;
                int len = BitConverter.ToInt32(b, p + 4);
                if (len < 16 || p + len > limit) yield break;
                var a = new Attr { Type = type, NonResident = b[p + 8] != 0, NameLength = b[p + 9], Flags = BitConverter.ToUInt16(b, p + 12), Start = p, Length = len };
                if (!a.NonResident && len >= 24)
                {
                    a.ValueLength = BitConverter.ToInt32(b, p + 16);
                    a.ValueOffset = p + BitConverter.ToUInt16(b, p + 20);
                    if (a.ValueLength < 0 || a.ValueOffset + a.ValueLength > p + len) yield break;
                }
                yield return a;
                p += len;
            }
        }

        public static List<Run> ParseRuns(byte[] b, int p, int end)
        {
            var runs = new List<Run>();
            long lcn = 0;
            while (p < end && b[p] != 0)
            {
                int lenSize = b[p] & 0xF, offSize = b[p] >> 4;
                p++;
                if (lenSize == 0 || lenSize > 8 || offSize > 8 || p + lenSize + offSize > end) break;
                long length = 0;
                for (int i = 0; i < lenSize; i++) length |= (long)b[p + i] << (8 * i);
                p += lenSize;
                long offset = 0;
                if (offSize > 0)
                {
                    for (int i = 0; i < offSize; i++) offset |= (long)b[p + i] << (8 * i);
                    if ((b[p + offSize - 1] & 0x80) != 0 && offSize < 8) offset |= -1L << (8 * offSize);
                    p += offSize;
                    lcn += offset;
                }
                if (length <= 0) break;
                runs.Add(new Run { Lcn = offSize == 0 ? -1 : lcn, Length = length });
            }
            return runs;
        }

        // The unnamed $DATA of a record, as runs keyed by starting VCN. Returns the real size if this record has it.
        public long CollectData(byte[] b, List<KeyValuePair<long, List<Run>>> segments)
        {
            long real = -1;
            foreach (Attr a in Attributes(b))
            {
                if (a.Type != 0x80 || a.NameLength != 0 || !a.NonResident || a.Length < 64) continue;
                long startVcn = BitConverter.ToInt64(b, a.Start + 16);
                int runOffset = BitConverter.ToUInt16(b, a.Start + 32);
                if (startVcn == 0) real = BitConverter.ToInt64(b, a.Start + 48);
                segments.Add(new KeyValuePair<long, List<Run>>(startVcn, ParseRuns(b, a.Start + runOffset, a.Start + a.Length)));
            }
            return real;
        }

        // ---- which clusters are in use, from the drive's own $Bitmap ----
        public void LoadBitmap()
        {
            if (TotalClusters / 8 > 512L * 1024 * 1024) return;
            byte[] record = new byte[RecordSize];
            if (!ReadMft(6L * RecordSize, record, 0, RecordSize) || !ApplyFixups(record)) return;
            var segments = new List<KeyValuePair<long, List<Run>>>();
            long real = CollectData(record, segments);
            if (real <= 0 || real > int.MaxValue) return;
            byte[] map = new byte[real];
            int at = 0;
            foreach (var s in segments.OrderBy(x => x.Key))
            {
                foreach (Run r in s.Value)
                {
                    long bytes = r.Length * ClusterSize;
                    for (long done = 0; done < bytes && at < map.Length; )
                    {
                        int take = (int)Math.Min(Math.Min(bytes - done, 16 * 1024 * 1024), map.Length - at);
                        if (r.Lcn >= 0) ReadBytes(r.Lcn * ClusterSize + done, map, at, take);
                        done += take;
                        at += take;
                    }
                }
            }
            _bitmap = map;
        }

        /// <summary>Share of these clusters since reused by other files, or -1 if unknown.</summary>
        public double ReusedShare(List<Run> runs)
        {
            if (_bitmap == null) return -1;
            long used = 0, total = 0;
            foreach (Run r in runs)
            {
                if (r.Lcn < 0) continue;
                for (long c = r.Lcn; c < r.Lcn + r.Length; c++)
                {
                    long i = c / 8;
                    if (i < 0 || i >= _bitmap.Length) { used++; total++; continue; }
                    if ((_bitmap[i] & (1 << (int)(c % 8))) != 0) used++;
                    total++;
                }
            }
            return total == 0 ? -1 : (double)used / total;
        }

        public void ReadCluster(long lcn, byte[] buffer)
        {
            ReadExact(lcn * ClusterSize, buffer, ClusterSize);
        }
    }

    static class DeepRecovery
    {
        sealed class Found
        {
            public long Record, Parent, Size, ModifiedMs;
            public string Name, Path, Category;
            public List<NtfsVolume.Run> Runs;
            public byte[] Resident;
            public bool Unreadable;   // compressed or encrypted: the raw clusters aren't the file
            public string Chance;     // good, partial, overwritten, erased, unknown
        }

        sealed class Folder
        {
            public long Parent;
            public string Name;
        }

        const int MaxResults = 500000;
        static readonly object Gate = new object();
        static List<Found> _found = new List<Found>();
        static Dictionary<long, Found> _byRecord = new Dictionary<long, Found>();
        static char _drive;
        static int _running, _cancel;

        static readonly Dictionary<string, string> Kinds = BuildKinds();

        static Dictionary<string, string> BuildKinds()
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            Action<string, string> add = (kind, list) => { foreach (string e in list.Split(' ')) map["." + e] = kind; };
            add("pictures", "jpg jpeg png gif bmp webp heic heif tif tiff raw cr2 cr3 nef arw dng psd svg");
            add("videos", "mp4 mkv mov avi wmv webm m4v mpg mpeg 3gp ts");
            add("documents", "pdf doc docx xls xlsx ppt pptx txt rtf odt ods odp csv md epub");
            add("music", "mp3 wav flac aac m4a ogg wma opus");
            add("archives", "zip rar 7z tar gz bz2 xz iso");
            return map;
        }

        public static object Drives()
        {
            var list = new List<object>();
            foreach (DriveInfo d in DriveInfo.GetDrives())
            {
                try
                {
                    if (!d.IsReady || (d.DriveType != DriveType.Fixed && d.DriveType != DriveType.Removable)) continue;
                    list.Add(J.D("letter", d.Name.Substring(0, 1), "label", d.VolumeLabel, "format", d.DriveFormat, "total", d.TotalSize, "free", d.AvailableFreeSpace, "ntfs", d.DriveFormat == "NTFS"));
                }
                catch { }
            }
            return J.D("drives", list, "elevated", SystemInfo.IsElevated());
        }

        public static object Start(string letter)
        {
            if (string.IsNullOrEmpty(letter) || !Regex.IsMatch(letter, "^[A-Za-z]$")) throw new Exception("Choose a drive.");
            if (!SystemInfo.IsElevated()) throw new Exception("Scanning a drive needs full mode.");
            if (Interlocked.CompareExchange(ref _running, 1, 0) != 0) throw new Exception("A scan is already running.");
            _cancel = 0;
            var thread = new Thread(() => Scan(char.ToUpperInvariant(letter[0])));
            thread.IsBackground = true;
            thread.Start();
            return J.D("ok", true);
        }

        public static object Cancel()
        {
            _cancel = 1;
            return J.D("ok", true);
        }

        static void Scan(char drive)
        {
            try
            {
                var found = new List<Found>();
                var byRecord = new Dictionary<long, Found>();
                var folders = new Dictionary<long, Folder>();
                var extensions = new Dictionary<long, List<KeyValuePair<long, List<NtfsVolume.Run>>>>();
                bool truncated = false;

                using (var v = new NtfsVolume(drive))
                {
                    v.LoadBitmap();
                    long records = v.MftBytes / v.RecordSize;
                    const int Batch = 1024;
                    byte[] buffer = new byte[Batch * v.RecordSize];
                    byte[] record = new byte[v.RecordSize];
                    long lastEmit = 0;

                    for (long i = 0; i < records && _cancel == 0; i += Batch)
                    {
                        int count = (int)Math.Min(Batch, records - i);
                        // One unreadable stretch shouldn't end the whole scan.
                        try { if (!v.ReadMft(i * v.RecordSize, buffer, 0, count * v.RecordSize)) continue; }
                        catch (IOException) { continue; }

                        for (int n = 0; n < count; n++)
                        {
                            Buffer.BlockCopy(buffer, n * v.RecordSize, record, 0, v.RecordSize);
                            if (!v.ApplyFixups(record)) continue;
                            ReadRecord(v, record, i + n, found, byRecord, folders, extensions, ref truncated);
                        }

                        if (i - lastEmit >= 50000)
                        {
                            lastEmit = i;
                            Program.Emit("recoverScan", J.D("state", "running", "percent", (int)(i * 100 / Math.Max(1, records)), "found", found.Count));
                        }
                    }

                    if (_cancel != 0)
                    {
                        Program.Emit("recoverScan", J.D("state", "cancelled"));
                        return;
                    }

                    // Fragmented files keep the rest of their cluster list in extension records.
                    foreach (var kv in extensions)
                    {
                        Found f;
                        if (!byRecord.TryGetValue(kv.Key, out f) || f.Runs == null) continue;
                        var all = new List<KeyValuePair<long, List<NtfsVolume.Run>>>(kv.Value);
                        all.Add(new KeyValuePair<long, List<NtfsVolume.Run>>(0, f.Runs));
                        f.Runs = all.OrderBy(x => x.Key).SelectMany(x => x.Value).ToList();
                    }

                    foreach (Found f in found)
                    {
                        f.Path = BuildPath(drive, f.Parent, folders);
                        if (f.Resident != null) f.Chance = "good";
                        else if (f.Unreadable) f.Chance = "overwritten";
                        else
                        {
                            double reused = v.ReusedShare(f.Runs);
                            f.Chance = reused < 0 ? "unknown" : reused >= 0.999 ? "overwritten" : reused > 0 ? "partial" : "unchecked";
                        }
                    }
                }

                lock (Gate)
                {
                    _found = found.OrderByDescending(f => f.ModifiedMs).ToList();
                    _byRecord = byRecord;
                    _drive = drive;
                }
                Program.Emit("recoverScan", J.D("state", "done", "found", found.Count, "truncated", truncated));
            }
            catch (Exception ex)
            {
                Program.Emit("recoverScan", J.D("state", "failed", "message", ex.Message));
            }
            finally
            {
                Interlocked.Exchange(ref _running, 0);
            }
        }

        static void ReadRecord(NtfsVolume v, byte[] b, long number, List<Found> found, Dictionary<long, Found> byRecord, Dictionary<long, Folder> folders, Dictionary<long, List<KeyValuePair<long, List<NtfsVolume.Run>>>> extensions, ref bool truncated)
        {
            int flags = BitConverter.ToUInt16(b, 0x16);
            bool inUse = (flags & 1) != 0, isDir = (flags & 2) != 0;
            long baseRecord = BitConverter.ToInt64(b, 0x20) & 0xFFFFFFFFFFFFL;

            if (baseRecord != 0)
            {
                if (inUse) return;
                var segments = new List<KeyValuePair<long, List<NtfsVolume.Run>>>();
                v.CollectData(b, segments);
                if (segments.Count == 0) return;
                List<KeyValuePair<long, List<NtfsVolume.Run>>> list;
                if (!extensions.TryGetValue(baseRecord, out list)) extensions[baseRecord] = list = new List<KeyValuePair<long, List<NtfsVolume.Run>>>();
                list.AddRange(segments);
                return;
            }
            if (inUse && !isDir) return;

            string name = null;
            int nameRank = -1;
            long parent = 5, modified = 0, size = -1;
            List<NtfsVolume.Run> runs = null;
            byte[] resident = null;
            bool unreadable = false, hasData = false;

            foreach (NtfsVolume.Attr a in v.Attributes(b))
            {
                if (a.Type == 0x10 && !a.NonResident && a.ValueLength >= 16)
                {
                    modified = FileTimeMs(BitConverter.ToInt64(b, a.ValueOffset + 8));
                }
                else if (a.Type == 0x30 && !a.NonResident && a.ValueLength >= 0x42)
                {
                    int chars = b[a.ValueOffset + 0x40], space = b[a.ValueOffset + 0x41];
                    if (a.ValueOffset + 0x42 + chars * 2 > a.ValueOffset + a.ValueLength) continue;
                    // Prefer the long name over the short 8.3 one.
                    int rank = space == 2 ? 0 : 1;
                    if (rank > nameRank)
                    {
                        nameRank = rank;
                        name = Encoding.Unicode.GetString(b, a.ValueOffset + 0x42, chars * 2);
                        parent = BitConverter.ToInt64(b, a.ValueOffset) & 0xFFFFFFFFFFFFL;
                    }
                }
                else if (a.Type == 0x80 && a.NameLength == 0 && !isDir)
                {
                    hasData = true;
                    if (a.NonResident)
                    {
                        if (a.Length < 64) continue;
                        // Compressed or encrypted. Sparse files are fine, their runs say where the gaps are.
                        if ((a.Flags & 0x40FF) != 0) unreadable = true;
                        long startVcn = BitConverter.ToInt64(b, a.Start + 16);
                        if (startVcn == 0) size = BitConverter.ToInt64(b, a.Start + 48);
                        runs = NtfsVolume.ParseRuns(b, a.Start + BitConverter.ToUInt16(b, a.Start + 32), a.Start + a.Length);
                    }
                    else
                    {
                        size = a.ValueLength;
                        resident = new byte[a.ValueLength];
                        Buffer.BlockCopy(b, a.ValueOffset, resident, 0, a.ValueLength);
                    }
                }
            }

            if (isDir)
            {
                if (name != null) folders[number] = new Folder { Parent = parent, Name = name };
                return;
            }
            if (name == null || !hasData || size <= 0 || name.StartsWith("$")) return;
            if (found.Count >= MaxResults)
            {
                truncated = true;
                return;
            }

            string kind;
            var item = new Found
            {
                Record = number,
                Parent = parent,
                Size = size,
                ModifiedMs = modified,
                Name = name,
                Category = Kinds.TryGetValue(Path.GetExtension(SafeName(name)), out kind) ? kind : "other",
                Runs = runs,
                Resident = resident,
                Unreadable = unreadable,
            };
            found.Add(item);
            byRecord[number] = item;
        }

        static long FileTimeMs(long fileTime)
        {
            try { return (long)(DateTime.FromFileTimeUtc(fileTime) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
            catch { return 0; }
        }

        static string BuildPath(char drive, long parent, Dictionary<long, Folder> folders)
        {
            var parts = new List<string>();
            long current = parent;
            for (int depth = 0; depth < 64 && current != 5; depth++)
            {
                Folder f;
                if (!folders.TryGetValue(current, out f))
                {
                    parts.Add("(unknown folder)");
                    break;
                }
                parts.Add(f.Name);
                current = f.Parent;
            }
            parts.Reverse();
            return drive + ":\\" + string.Join("\\", parts);
        }

        static string SafeName(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name.Trim().Length == 0 ? "recovered" : name;
        }

        // Newest first. Files not yet checked get a look at their first cluster: Windows tells
        // SSDs to erase freed space, so a zeroed cluster means the data is gone.
        public static object List(string category, string search, int limit)
        {
            lock (Gate)
            {
                IEnumerable<Found> query = _found.Where(f => f.Chance != "overwritten");
                if (!string.IsNullOrEmpty(category) && category != "all") query = query.Where(f => f.Category == category);
                if (!string.IsNullOrEmpty(search)) query = query.Where(f => f.Name.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0 || f.Path.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0);
                List<Found> matches = query.ToList();
                List<Found> page = matches.Take(Math.Max(1, Math.Min(limit, 300))).ToList();

                List<Found> unchecked_ = page.Where(f => f.Chance == "unchecked").ToList();
                if (unchecked_.Count > 0)
                {
                    try
                    {
                        using (var v = new NtfsVolume(_drive))
                        {
                            byte[] cluster = new byte[v.ClusterSize];
                            foreach (Found f in unchecked_)
                            {
                                try
                                {
                                    NtfsVolume.Run first = f.Runs.FirstOrDefault(r => r.Lcn >= 0);
                                    if (first.Length == 0) { f.Chance = "erased"; continue; }
                                    v.ReadCluster(first.Lcn, cluster);
                                    f.Chance = cluster.All(x => x == 0) ? "erased" : "good";
                                }
                                catch { f.Chance = "unknown"; }
                            }
                        }
                    }
                    catch { }
                }

                return J.D(
                    "total", matches.Count,
                    "drive", _drive == '\0' ? null : _drive.ToString(),
                    "items", page.Select(f => (object)J.D(
                        "id", f.Record, "name", f.Name, "path", f.Path, "size", f.Size, "modifiedMs", f.ModifiedMs, "category", f.Category, "chance", f.Chance)).ToList());
            }
        }

        public static object Recover(List<long> ids, string destination)
        {
            char drive;
            List<Found> items;
            lock (Gate)
            {
                drive = _drive;
                items = ids.Where(_byRecord.ContainsKey).Select(i => _byRecord[i]).ToList();
            }
            if (items.Count == 0) throw new Exception("Nothing selected.");
            if (string.IsNullOrEmpty(destination) || !Path.IsPathRooted(destination) || !Directory.Exists(destination)) throw new Exception("That folder wasn't found.");

            string root = Path.GetPathRoot(Path.GetFullPath(destination));
            if (root.Length < 2 || char.ToUpperInvariant(root[0]) == drive)
                throw new Exception("Choose a folder on a different drive, such as a USB stick. Saving to " + drive + ": could overwrite the files you're recovering.");

            long needed = items.Sum(f => f.Size);
            if (new DriveInfo(root).AvailableFreeSpace < needed) throw new Exception("There isn't enough free space on that drive.");

            string outDir = Path.Combine(destination, "G Ultra Recovered");
            Directory.CreateDirectory(outDir);
            var results = new List<object>();
            using (var v = new NtfsVolume(drive))
            {
                for (int i = 0; i < items.Count; i++)
                {
                    Found f = items[i];
                    Program.Emit("recoverCopy", J.D("index", i, "total", items.Count, "name", f.Name));
                    try
                    {
                        if (f.Unreadable) throw new Exception("It was compressed or encrypted, so it can't be rebuilt.");
                        string target = RecycleBin.FreeName(Path.Combine(outDir, SafeName(f.Name)));
                        Rebuild(v, f, target);
                        bool whole = f.Chance == "good";
                        results.Add(J.D("id", f.Record, "name", f.Name, "ok", true, "path", target, "whole", whole));
                    }
                    catch (Exception ex)
                    {
                        results.Add(J.D("id", f.Record, "name", f.Name, "ok", false, "message", ex.Message));
                    }
                }
            }
            return J.D("folder", outDir, "results", results);
        }

        static void Rebuild(NtfsVolume v, Found f, string target)
        {
            using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write))
            {
                if (f.Resident != null)
                {
                    output.Write(f.Resident, 0, f.Resident.Length);
                    return;
                }
                long remaining = f.Size;
                int chunk = Math.Max(1, 4 * 1024 * 1024 / v.ClusterSize) * v.ClusterSize;
                byte[] buffer = new byte[chunk];
                foreach (NtfsVolume.Run r in f.Runs)
                {
                    long runBytes = r.Length * v.ClusterSize;
                    for (long done = 0; done < runBytes && remaining > 0; )
                    {
                        int take = (int)Math.Min(chunk, runBytes - done);
                        if (r.Lcn >= 0) v.ReadBytes(r.Lcn * v.ClusterSize + done, buffer, 0, take);
                        else Array.Clear(buffer, 0, take);
                        int write = (int)Math.Min(take, remaining);
                        output.Write(buffer, 0, write);
                        remaining -= write;
                        done += take;
                    }
                }
                if (remaining > 0) throw new Exception("Only part of this file could be found.");
            }
        }
    }
}
