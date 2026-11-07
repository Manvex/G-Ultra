using System;
using System.Collections.Generic;
using System.Linq;

namespace GUltra
{
    // One lock for everything that talks to the hardware: sensor updates and fan writes
    // must never overlap on the same bus.
    static class Hw
    {
        public static readonly object Lock = new object();
    }

    interface IFanControl
    {
        string Id { get; }
        string Name { get; }
        string Hardware { get; }
        string Group { get; }
        double? Rpm { get; }
        double? Percent { get; }
        bool CanControl { get; }
        bool IsManual { get; }
        float MinPercent { get; }
        float MaxPercent { get; }
        void Set(float percent);
        void Auto();
    }

    // Manual fan control with guard rails: a fan can't be stopped from here, and control goes
    // back to the firmware when things get hot or when the app exits.
    static class Fans
    {
        public const float FloorPercent = 30f;
        public const double HotCelsius = 90.0;
        public const double ResumeCelsius = 80.0;

        static List<IFanControl> _fans = new List<IFanControl>();
        static bool _tooHot;

        public static Action<string, object> Notify = Program.Emit;

        public static void Update(List<IFanControl> fans)
        {
            lock (Hw.Lock) _fans = fans;
        }

        public static List<object> Snapshot()
        {
            lock (Hw.Lock)
            {
                return _fans.Select(f => (object)J.D(
                    "id", f.Id,
                    "name", f.Name,
                    "hardware", f.Hardware,
                    "group", f.Group,
                    "rpm", f.Rpm.HasValue ? (object)Math.Round(f.Rpm.Value) : null,
                    "percent", f.Percent.HasValue ? (object)Math.Round(f.Percent.Value) : null,
                    "canControl", f.CanControl,
                    "manual", f.CanControl && f.IsManual,
                    "minPercent", f.CanControl ? (double)LowestAllowed(f) : 0.0,
                    "maxPercent", f.CanControl ? (double)f.MaxPercent : 0.0)).ToList();
            }
        }

        static float LowestAllowed(IFanControl f)
        {
            return Math.Max(FloorPercent, f.MinPercent);
        }

        public static object Set(string id, double percent)
        {
            lock (Hw.Lock)
            {
                var fan = _fans.FirstOrDefault(f => f.Id == id);
                if (fan == null) throw new Exception("Fan not found.");
                if (!fan.CanControl) throw new Exception("This fan can't be controlled.");
                if (_tooHot) throw new Exception("The system is too hot for manual fan control right now.");
                float value = (float)Math.Min(fan.MaxPercent, Math.Max(LowestAllowed(fan), percent));
                fan.Set(value);
                return J.D("ok", true, "percent", (double)value);
            }
        }

        // For the fan rule. Returns how many fans took the new speed.
        public static int ApplyAll(double percent)
        {
            lock (Hw.Lock)
            {
                if (_tooHot) return 0;
                int done = 0;
                foreach (var f in _fans)
                {
                    if (!f.CanControl) continue;
                    try
                    {
                        f.Set((float)Math.Min(f.MaxPercent, Math.Max(LowestAllowed(f), percent)));
                        done++;
                    }
                    catch { }
                }
                return done;
            }
        }

        public static object Auto(string id)
        {
            lock (Hw.Lock)
            {
                var fan = _fans.FirstOrDefault(f => f.Id == id);
                if (fan == null) throw new Exception("Fan not found.");
                if (fan.CanControl) fan.Auto();
                return J.D("ok", true);
            }
        }

        public static object AutoAll()
        {
            RestoreAll();
            return J.D("ok", true);
        }

        public static void RestoreAll()
        {
            lock (Hw.Lock)
            {
                foreach (var f in _fans)
                {
                    if (!f.CanControl) continue;
                    try { f.Auto(); } catch { }
                }
            }
        }

        // Called with the hottest real CPU or GPU reading on every sample.
        public static void Watchdog(double? hottest)
        {
            if (!hottest.HasValue) return;
            lock (Hw.Lock)
            {
                if (_tooHot && hottest.Value < ResumeCelsius) _tooHot = false;
                if (hottest.Value < HotCelsius) return;
                _tooHot = true;
                var manual = _fans.Where(f => f.CanControl && f.IsManual).ToList();
                if (manual.Count == 0) return;
                foreach (var f in manual)
                {
                    try { f.Auto(); } catch { }
                }
                Notify("fanSafety", J.D("celsius", hottest.Value, "fans", manual.Count));
            }
        }
    }
}
