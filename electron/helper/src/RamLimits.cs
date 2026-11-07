using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace GUltra
{
    // The BIOS table often reports a figure the hardware can't reach, so the real maximum is the
    // lowest of three limits: the processor, the BIOS, and the largest modules that fit the slots.
    static class RamLimits
    {
        public class Result
        {
            public long MaxBytes;
            public long PerSlotBytes;
            public int SocketSlots;
            public string LimitedBy;
            public int? CpuGb;
        }

        // Module sizes actually sold, largest first.
        static readonly int[] ModuleSizes = { 64, 48, 32, 24, 16, 12, 8, 4, 2, 1 };

        public static int? ModuleMaxGb(string type)
        {
            switch (type)
            {
                case "DDR5": return 64;
                case "DDR4": return 32;
                case "DDR3": return 8;
                case "DDR2": return 2;
                case "DDR": return 1;
            }
            return null;
        }

        static readonly Regex IntelCore = new Regex(@"\bi[3579]-(\d{4,5})([A-Za-z0-9]*)", RegexOptions.IgnoreCase);
        static readonly Regex IntelUltra = new Regex(@"Ultra\s*[3579]\s+(\d)\d{2}([A-Za-z]*)", RegexOptions.IgnoreCase);
        static readonly Regex IntelCoreNew = new Regex(@"Core(?:\(TM\))?\s+[357]\s+(\d)\d{2}([A-Za-z]*)", RegexOptions.IgnoreCase);
        static readonly Regex IntelN = new Regex(@"\bN(\d{2,3})\b");
        static readonly Regex Ryzen = new Regex(@"Ryzen\s+(?:PRO\s+)?[3579]\s+(?:PRO\s+)?(\d)\d{3}([A-Za-z0-9]*)", RegexOptions.IgnoreCase);

        // Published maximums by processor family. Returns null when the model isn't recognized,
        // in which case the other two limits decide.
        public static int? CpuMaxGb(string cpu)
        {
            if (string.IsNullOrEmpty(cpu)) return null;

            Match m = IntelCore.Match(cpu);
            if (m.Success)
            {
                string digits = m.Groups[1].Value;
                int gen = digits.Length == 5 ? int.Parse(digits.Substring(0, 2)) : int.Parse(digits.Substring(0, 1));
                string s = m.Groups[2].Value.ToUpperInvariant();
                bool low = s.StartsWith("U") || s.StartsWith("Y") || s.StartsWith("G") || s.StartsWith("P");
                bool hx = s.StartsWith("HX");
                bool mobileH = !hx && (s.StartsWith("H") || s.StartsWith("M"));
                switch (gen)
                {
                    case 2:
                    case 3: return low ? 16 : mobileH ? 32 : 32;
                    case 4:
                    case 5: return low ? 16 : 32;
                    case 6:
                    case 7: return low ? 32 : 64;
                    case 8: return low ? (digits[3] == '0' ? 32 : 64) : 64;
                    case 9: return low ? 64 : mobileH ? 64 : 128;
                    case 10: return low ? 64 : 128;
                    case 11: return low || mobileH ? 64 : 128;
                    case 12: return low || mobileH ? 64 : 128;
                    case 13: return low || mobileH ? 64 : hx ? 128 : 192;
                    case 14: return low || mobileH ? 64 : 192;
                }
                return null;
            }

            m = IntelUltra.Match(cpu);
            if (m.Success)
            {
                string s = m.Groups[2].Value.ToUpperInvariant();
                if (s.StartsWith("V")) return null; // memory built into the processor package
                return s.StartsWith("U") || (s.StartsWith("H") && !s.StartsWith("HX")) ? 96 : 192;
            }

            m = IntelCoreNew.Match(cpu);
            if (m.Success)
            {
                string s = m.Groups[2].Value.ToUpperInvariant();
                return s.StartsWith("U") || (s.StartsWith("H") && !s.StartsWith("HX")) ? 64 : 192;
            }

            if (IntelN.IsMatch(cpu) && cpu.IndexOf("Intel", StringComparison.OrdinalIgnoreCase) >= 0) return 16;

            m = Ryzen.Match(cpu);
            if (m.Success)
            {
                int gen = int.Parse(m.Groups[1].Value);
                string s = m.Groups[2].Value.ToUpperInvariant();
                bool mobile = s.StartsWith("U") || s.StartsWith("H") || s.StartsWith("C") || s.StartsWith("M");
                if (mobile)
                {
                    if (gen <= 3) return 32;
                    if (gen <= 6) return 64;
                    return 256;
                }
                if (gen <= 2) return 64;
                if (gen <= 5) return 128;
                return 192;
            }
            return null;
        }

        public static Result Compute(string cpu, string type, int slots, int solderedCount, long solderedBytes, long biosBytes, long installed)
        {
            const long GB = 1L << 30;
            var r = new Result { SocketSlots = Math.Max(0, slots - solderedCount), CpuGb = CpuMaxGb(cpu) };

            var limits = new List<KeyValuePair<string, long>>();
            int? moduleGb = ModuleMaxGb(type);
            if (moduleGb.HasValue && r.SocketSlots > 0) limits.Add(new KeyValuePair<string, long>("modules", solderedBytes + r.SocketSlots * moduleGb.Value * GB));
            if (r.CpuGb.HasValue) limits.Add(new KeyValuePair<string, long>("processor", r.CpuGb.Value * GB));
            // A BIOS figure below what's already installed is plainly wrong, so it doesn't count.
            if (biosBytes >= installed && biosBytes > 0) limits.Add(new KeyValuePair<string, long>("bios", biosBytes));
            if (limits.Count == 0) return r;

            var lowest = limits.OrderBy(l => l.Value).First();
            r.LimitedBy = lowest.Key;
            if (r.SocketSlots == 0)
            {
                r.MaxBytes = installed;
                return r;
            }

            // The limit has to split into module sizes that exist.
            long perSlot = (lowest.Value - solderedBytes) / r.SocketSlots;
            int size = ModuleSizes.FirstOrDefault(s => s * GB <= perSlot);
            if (size == 0) return r;
            r.PerSlotBytes = size * GB;
            r.MaxBytes = solderedBytes + r.SocketSlots * r.PerSlotBytes;
            return r;
        }
    }
}
