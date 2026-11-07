using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace GUltra
{
    // Background mode: only this small process runs, with an icon next to the clock.
    // Opening the app hands over to it, and closing the app hands back.
    static class Background
    {
        public const string MutexName = @"Local\GUltraMonitor";
        public const string StopEventName = @"Local\GUltraMonitorStop";

        // Called by the helper the app starts: asks a running background monitor to step aside.
        public static Mutex TakeOver()
        {
            try
            {
                EventWaitHandle stop;
                if (EventWaitHandle.TryOpenExisting(StopEventName, out stop))
                {
                    stop.Set();
                    stop.Dispose();
                }
            }
            catch { }
            var mutex = new Mutex(false, MutexName);
            try
            {
                return mutex.WaitOne(5000) ? mutex : null;
            }
            catch (AbandonedMutexException)
            {
                return mutex;
            }
        }

        public static int Run()
        {
            var mutex = new Mutex(false, MutexName);
            bool got;
            try { got = mutex.WaitOne(8000); }
            catch (AbandonedMutexException) { got = true; }
            // Another copy, or the open app, is already monitoring.
            if (!got) return 0;

            var stop = new EventWaitHandle(false, EventResetMode.ManualReset, StopEventName);
            stop.Reset();

            int code = 0;
            var ui = new Thread(() =>
            {
                try { TrayHost.Run(stop); }
                catch { code = 1; }
            });
            ui.SetApartmentState(ApartmentState.STA);
            ui.Start();
            TrayHost.Ready.WaitOne(5000);

            Fans.Notify = (name, data) =>
            {
                if (name == "fanSafety") TrayHost.Notify("G Ultra", "Fans are back on automatic: the system got too hot.");
            };
            Monitor.Notifier = TrayHost.Notify;
            Monitor.StatusChanged = TrayHost.SetStatus;
            Monitor.Start(true);

            ui.Join();
            Monitor.Stop();
            try { Fans.RestoreAll(); } catch { }
            var shutdown = new Thread(() =>
            {
                try { Sensors.Shutdown(); } catch { }
            });
            shutdown.IsBackground = true;
            shutdown.Start();
            shutdown.Join(3000);
            try { mutex.ReleaseMutex(); } catch { }
            return code;
        }
    }

    static class TrayHost
    {
        public static readonly ManualResetEvent Ready = new ManualResetEvent(false);
        static NotifyIcon _icon;
        static Control _marshal;
        static ToolStripMenuItem _status;

        static string BaseDir { get { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); } }

        static Icon LoadIcon()
        {
            try { return new Icon(Path.Combine(BaseDir, "icon.ico"), SystemInformation.SmallIconSize); }
            catch { return SystemIcons.Application; }
        }

        static void OpenApp()
        {
            try
            {
                // Installed layout: resources\helper\GUltraHelper.exe next to ..\..\G Ultra.exe
                string exe = Path.GetFullPath(Path.Combine(BaseDir, "..", "..", "G Ultra.exe"));
                Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(exe) });
            }
            catch (Exception ex)
            {
                Notify("G Ultra", "The app couldn't be opened: " + ex.Message);
            }
        }

        public static void Run(EventWaitHandle stop)
        {
            Application.EnableVisualStyles();
            _marshal = new Control();
            _marshal.CreateControl();
            GC.KeepAlive(_marshal.Handle);

            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open G Ultra", null, (s, e) => OpenApp());
            open.Font = new Font(open.Font, FontStyle.Bold);
            _status = new ToolStripMenuItem("Starting…") { Enabled = false };
            var pause = new ToolStripMenuItem("Pause rules") { CheckOnClick = true };
            pause.CheckedChanged += (s, e) => { Monitor.Paused = pause.Checked; };
            var quit = new ToolStripMenuItem("Stop until next restart", null, (s, e) => Application.Exit());
            menu.Items.Add(open);
            menu.Items.Add(_status);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(pause);
            menu.Items.Add(quit);

            _icon = new NotifyIcon { Icon = LoadIcon(), Text = "G Ultra", Visible = true, ContextMenuStrip = menu };
            _icon.DoubleClick += (s, e) => OpenApp();

            // When the app opens, this monitor steps aside.
            var waiter = new Thread(() =>
            {
                stop.WaitOne();
                try { _marshal.BeginInvoke((Action)Application.Exit); } catch { }
            });
            waiter.IsBackground = true;
            waiter.Start();

            Ready.Set();
            Application.Run();
            _icon.Visible = false;
            _icon.Dispose();
        }

        public static void SetStatus(string text)
        {
            if (_marshal == null || !_marshal.IsHandleCreated) return;
            try
            {
                _marshal.BeginInvoke((Action)(() =>
                {
                    // The tooltip has a 63 character limit.
                    _icon.Text = text.Length > 63 ? text.Substring(0, 63) : text;
                    _status.Text = text.Replace("G Ultra · ", "");
                }));
            }
            catch { }
        }

        public static void Notify(string title, string text)
        {
            if (_marshal == null || !_marshal.IsHandleCreated) return;
            try
            {
                _marshal.BeginInvoke((Action)(() => _icon.ShowBalloonTip(6000, title, text, ToolTipIcon.Info)));
            }
            catch { }
        }
    }
}
