import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, Bell, CheckCircle2, Fan, HardDrive, Layers, MemoryStick, Thermometer, Timer, BatteryCharging, Loader2 } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes } from '../lib/format';
import { loadData, useData, useLive, useSystem } from '../lib/store';
import type { HistoryPoint, MonitorConfig, MonitorInfo } from '../lib/types';
import { LineChart, ChartLegend, type Series } from '../ui/charts';
import { AppIcon, Glass, PageHead, Segmented, Slider, Switch, toast } from '../ui/kit';

function Rule({ icon: Icon, title, text, on, onToggle, children }: { icon: typeof Bell; title: string; text: string; on: boolean; onToggle: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className="rule">
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="notice-icon">
          <Icon size={17} />
        </div>
        <div className="grow">
          <div className="row-title" style={{ whiteSpace: 'normal' }}>
            {title}
          </div>
          <div className="row-sub" style={{ whiteSpace: 'normal' }}>
            {text}
          </div>
        </div>
        <Switch checked={on} onChange={onToggle} label={title} />
      </div>
      {on && children && <div className="rule-body">{children}</div>}
    </div>
  );
}

function Level({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div className="rule-field">
      <div className="row between small">
        <span className="dim">{label}</span>
        <span className="num" style={{ fontWeight: 580 }}>
          {value}
          {unit}
        </span>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} label={label} />
    </div>
  );
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="rule-field">
      <div className="small dim" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <Segmented label={label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

function Check({ label, text, on, onChange }: { label: string; text?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row between rule-field" style={{ gap: 12 }}>
      <div className="grow">
        <div style={{ fontSize: 13, fontWeight: 520 }}>{label}</div>
        {text && (
          <div className="row-sub" style={{ whiteSpace: 'normal' }}>
            {text}
          </div>
        )}
      </div>
      <Switch checked={on} onChange={onChange} label={label} />
    </div>
  );
}

const when = (ts: number) => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const hour = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function HistoryCharts({ points }: { points: HistoryPoint[] }) {
  const ts = points.map((p) => p.t);
  const hasCpu = points.some((p) => p.cpu != null);
  const load: Series[] = [
    ...(hasCpu ? [{ id: 'cpu', name: 'Processor', color: 'var(--s1)', values: points.map((p) => p.cpu) }] : []),
    { id: 'mem', name: 'Memory', color: 'var(--s2)', values: points.map((p) => p.mem) },
  ];
  const temps: Series[] = points.some((p) => p.temp != null) ? [{ id: 'temp', name: 'Temperature', color: 'var(--s3)', values: points.map((p) => p.temp) }] : [];
  const tip = (i: number) => when(ts[i]);
  return (
    <>
      <div className="row between wrap" style={{ marginTop: 10 }}>
        <span className="label">Load</span>
        <ChartLegend series={load} />
      </div>
      <div style={{ marginTop: 6 }}>
        <LineChart series={load} ts={ts} height={140} unit="%" yMin={0} yMax={100} xStart={hour(ts[0])} xEnd={hour(ts[ts.length - 1])} tipLabel={tip} />
      </div>
      {temps.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 14 }}>
            Temperature
          </div>
          <div style={{ marginTop: 6 }}>
            <LineChart series={temps} ts={ts} height={130} xStart={hour(ts[0])} xEnd={hour(ts[ts.length - 1])} tipLabel={tip} />
          </div>
        </>
      )}
    </>
  );
}

export function Monitor() {
  const isAndroid = bridge.platform === 'android';
  const live = useLive();
  const system = useSystem();
  const info = useData<MonitorInfo>('monitor', () => bridge.monitorGet(), 3000);
  const history = useData<HistoryPoint[]>('monitorHistory', () => bridge.monitorHistory(), 30000);
  const [draft, setDraft] = useState<MonitorConfig | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const timer = useRef(0);
  const cfg = draft ?? info.data?.config;

  // Keeps the activity log and history current, and notices permissions granted in system screens.
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return;
      void loadData('monitor', () => bridge.monitorGet());
      void loadData('monitorHistory', () => bridge.monitorHistory());
    };
    const id = window.setInterval(refresh, 20000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const commit = (next: MonitorConfig) => {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      bridge.monitorSet(next).catch((e: Error) => toast(e.message, 'warning'));
    }, 350);
  };

  const set = <K extends keyof MonitorConfig>(key: K, value: MonitorConfig[K]) => cfg && commit({ ...cfg, [key]: value });
  const section = <K extends 'ram' | 'ramTimer' | 'temp' | 'fan' | 'clean' | 'battery'>(key: K, patch: Partial<MonitorConfig[K]>) => cfg && commit({ ...cfg, [key]: { ...cfg[key], ...patch } });

  const canCloseApps = !isAndroid || info.data?.canCloseApps === true;
  const fans = (live?.fans ?? []).filter((f) => f.canControl);
  const hasBattery = isAndroid || !!system?.hasBattery;

  const closeList = useMemo(() => new Set((cfg?.closeApps ?? []).map((n) => n.toLowerCase())), [cfg?.closeApps]);
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: { name: string; title: string; path?: string | null; mem: number }[] = [];
    for (const p of [...(live?.processes ?? [])].sort((a, b) => b.mem - a.mem || (b.usageMs ?? 0) - (a.usageMs ?? 0))) {
      if (p.critical || seen.has(p.name.toLowerCase())) continue;
      if (!isAndroid && (!p.path || /\\windows\\/i.test(p.path))) continue;
      seen.add(p.name.toLowerCase());
      out.push({ name: p.name, title: p.title, path: p.path, mem: p.mem });
      if (out.length >= 24) break;
    }
    // Apps you chose stay on the list even when they aren't running.
    for (const n of cfg?.closeApps ?? []) {
      if (!seen.has(n.toLowerCase())) out.push({ name: n, title: n, mem: 0 });
    }
    return out;
    // Refreshing this on every sample would make the list jump while you're using it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!live, cfg?.closeApps]);

  const toggleApp = (name: string, on: boolean) => {
    if (!cfg) return;
    const rest = cfg.closeApps.filter((n) => n.toLowerCase() !== name.toLowerCase());
    set('closeApps', on ? [...rest, name] : rest);
  };

  if (!cfg) {
    return (
      <div className="stack">
        <PageHead title="Monitor" subtitle="Watches your system in the background and acts on your rules." />
        <Glass className="card row">
          <Loader2 size={17} className="spin" /> Loading your settings…
        </Glass>
      </div>
    );
  }

  const modes = isAndroid
    ? [
        { value: 'economy', label: 'Economy · 15 min' },
        { value: 'balanced', label: 'Balanced · 5 min' },
        { value: 'realtime', label: 'Frequent · 1 min' },
      ]
    : [
        { value: 'economy', label: 'Economy · 1 min' },
        { value: 'balanced', label: 'Balanced · 15 s' },
        { value: 'realtime', label: 'Real time · 5 s' },
      ];
  const shownAutostart = autostart ?? info.data?.autostart ?? false;
  const points = history.data ?? [];
  const events = info.data?.events ?? [];

  return (
    <div className="stack">
      <PageHead title="Monitor" subtitle="Watches your system in the background and acts on your rules." />

      <Glass className="card">
        <div className="list">
          <div className="list-row">
            <div className="grow">
              <div className="row-title">Background monitoring</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                {isAndroid
                  ? 'Keeps running after you close the app. Android requires a small notification while it does.'
                  : 'When you close the window, only a small process stays, with an icon next to the clock. Right-click it to open the app or pause the rules.'}
              </div>
            </div>
            <Switch checked={cfg.enabled} onChange={(v) => set('enabled', v)} label="Background monitoring" />
          </div>
          <div className="list-row">
            <div className="grow">
              <div className="row-title">{isAndroid ? 'Start with the phone' : 'Start with Windows'}</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                {isAndroid ? 'Some phones also ask you to allow this in their battery settings.' : 'Starts when you sign in, with no prompt from Windows.'}
              </div>
            </div>
            <Switch
              checked={shownAutostart}
              onChange={(v) => {
                setAutostart(v);
                bridge.setAutostart(v).catch((e: Error) => {
                  setAutostart(null);
                  toast(e.message, 'warning');
                });
              }}
              label="Start with the system"
            />
          </div>
          <div className="list-row">
            <div className="grow">
              <div className="row-title">Show alerts</div>
              <div className="row-sub">Notifications when a rule acts</div>
            </div>
            <Switch checked={cfg.notifications} onChange={(v) => set('notifications', v)} label="Show alerts" />
          </div>
          {isAndroid && info.data?.notificationsAllowed === false && (
            <div className="list-row">
              <div className="grow">
                <div className="row-title">Notifications are blocked</div>
                <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                  Without them you won't see the live status or your alerts.
                </div>
              </div>
              <button className="btn sm" onClick={() => bridge.android?.requestNotifications()}>
                Allow
              </button>
            </div>
          )}
        </div>
        <div className="rule-field" style={{ marginTop: 10 }}>
          <div className="small dim" style={{ marginBottom: 6 }}>
            How often it checks
          </div>
          <Segmented label="How often it checks" value={cfg.mode} options={modes} onChange={(v) => set('mode', v as MonitorConfig['mode'])} />
          <p className="section-sub" style={{ marginTop: 8 }}>
            {isAndroid ? 'Longer intervals use less battery. Android may delay checks while the phone sleeps.' : cfg.mode === 'economy' ? 'Lightest on memory and battery. Sensors only load if a rule needs them.' : 'Checks twice as rarely on battery, except in real time mode.'}
          </p>
        </div>
      </Glass>

      <Glass className="card">
        <h2 className="section-title">Last 24 hours</h2>
        {points.length > 1 ? <HistoryCharts points={points} /> : <p className="section-sub">Collecting data. A new point is added as the monitor runs.</p>}
      </Glass>

      <Glass className="card">
        <h2 className="section-title">Rules</h2>
        <p className="section-sub">{isAndroid ? 'They run in the background.' : "They run in the background, and pause during full-screen games and presentations."}</p>
        <div style={{ marginTop: 6 }}>
          <Rule
            icon={MemoryStick}
            title="When memory gets full"
            text={isAndroid ? "Android 14+ doesn't let apps free other apps' memory, so there this is an alert." : 'Frees memory automatically when it goes over your limit.'}
            on={cfg.ram.enabled}
            onToggle={(enabled) => section('ram', { enabled })}
          >
            <Level label="Act above" value={cfg.ram.threshold} min={50} max={98} unit="%" onChange={(threshold) => section('ram', { threshold })} />
            <Choice
              label="Wait at least this long between runs"
              value={String(cfg.ram.cooldownMin)}
              options={[
                { value: '5', label: '5 min' },
                { value: '10', label: '10 min' },
                { value: '30', label: '30 min' },
                { value: '60', label: '1 hour' },
              ]}
              onChange={(v) => section('ram', { cooldownMin: Number(v) })}
            />
            {!isAndroid && <Check label="Also clear the standby cache" text="Frees the most, but files are read from the SSD again. Needs full mode." on={cfg.ram.standby} onChange={(standby) => section('ram', { standby })} />}
            {canCloseApps && <Check label="Also close the apps you picked" on={cfg.ram.closeApps} onChange={(closeApps) => section('ram', { closeApps })} />}
          </Rule>

          {canCloseApps && (
            <Rule icon={Timer} title="Clean up on a schedule" text={isAndroid ? 'Stops the apps you picked at regular intervals.' : 'Frees memory at regular intervals, whatever the level.'} on={cfg.ramTimer.enabled} onToggle={(enabled) => section('ramTimer', { enabled })}>
              <Choice
                label="Every"
                value={String(cfg.ramTimer.everyMin)}
                options={[
                  { value: '5', label: '5 min' },
                  { value: '15', label: '15 min' },
                  { value: '30', label: '30 min' },
                  { value: '60', label: '1 hour' },
                ]}
                onChange={(v) => section('ramTimer', { everyMin: Number(v) })}
              />
              {!isAndroid && <Check label="Also close the apps you picked" on={cfg.ramTimer.closeApps} onChange={(closeApps) => section('ramTimer', { closeApps })} />}
            </Rule>
          )}

          <Rule
            icon={Thermometer}
            title={isAndroid ? 'When the phone gets hot' : 'When the processor gets hot'}
            text={isAndroid ? 'Alerts you when the battery goes over your limit or the system reports overheating.' : 'Alerts you, and can slow the processor until it cools down. This works on laptops whose fans can\'t be controlled. Needs the sensor driver.'}
            on={cfg.temp.enabled}
            onToggle={(enabled) => section('temp', { enabled })}
          >
            {isAndroid ? (
              <Level label="Battery temperature limit" value={cfg.temp.threshold} min={35} max={50} unit="°C" onChange={(threshold) => section('temp', { threshold })} />
            ) : (
              <>
                <Level label="Act above" value={cfg.temp.threshold} min={60} max={98} unit="°C" onChange={(threshold) => section('temp', { threshold })} />
                <Check label="Slow the processor to cool it down" text="Back to normal once it's 8°C below your limit." on={cfg.temp.limitCpu} onChange={(limitCpu) => section('temp', { limitCpu })} />
                {cfg.temp.limitCpu && <Level label="Limit the processor to" value={cfg.temp.limitPercent} min={50} max={95} step={5} unit="%" onChange={(limitPercent) => section('temp', { limitPercent })} />}
              </>
            )}
            {info.data?.cpuLimited && (
              <div className="row small" style={{ gap: 6, marginTop: 8, color: 'var(--warning)' }}>
                <Activity size={14} /> The processor is limited right now.
              </div>
            )}
          </Rule>

          {!isAndroid && (
            <div className="rule">
              <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                <div className="notice-icon">
                  <Fan size={17} />
                </div>
                <div className="grow">
                  <div className="row-title">Fan speed</div>
                  <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                    {fans.length > 0
                      ? 'Hold a set level, or follow the temperature. Never below 30%, and back to automatic at 90°C or if G Ultra stops.'
                      : system?.isLaptop
                        ? "This laptop's firmware controls its fans, so this rule can't change them. Slowing the processor, above, is the way to keep it cooler."
                        : 'No controllable fans found. Some motherboards hide this until Smart Fan is set to manual in the BIOS.'}
                  </div>
                </div>
              </div>
              {fans.length > 0 && (
                <div className="rule-body">
                  <Choice
                    label="Mode"
                    value={cfg.fan.mode}
                    options={[
                      { value: 'auto', label: 'Automatic' },
                      { value: 'fixed', label: 'Fixed level' },
                      { value: 'curve', label: 'By temperature' },
                    ]}
                    onChange={(v) => section('fan', { mode: v as MonitorConfig['fan']['mode'] })}
                  />
                  {cfg.fan.mode === 'fixed' && <Level label="Keep fans at" value={cfg.fan.percent} min={30} max={100} unit="%" onChange={(percent) => section('fan', { percent })} />}
                  {cfg.fan.mode === 'curve' && (
                    <>
                      <Level label="Quiet up to" value={cfg.fan.lowTemp} min={30} max={70} unit="°C" onChange={(lowTemp) => section('fan', { lowTemp })} />
                      <Level label="Speed when quiet" value={cfg.fan.lowPercent} min={30} max={100} unit="%" onChange={(lowPercent) => section('fan', { lowPercent })} />
                      <Level label="Maximum speed from" value={cfg.fan.highTemp} min={50} max={90} unit="°C" onChange={(highTemp) => section('fan', { highTemp })} />
                      <Level label="Maximum speed" value={cfg.fan.highPercent} min={30} max={100} unit="%" onChange={(highPercent) => section('fan', { highPercent })} />
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <Rule icon={HardDrive} title="When storage runs low" text={isAndroid ? 'Alerts you, at most once a day.' : 'Cleans temporary files, Windows Update leftovers and crash reports, at most once a day. Never your files or browser data.'} on={cfg.clean.enabled} onToggle={(enabled) => section('clean', { enabled })}>
            <Choice
              label="When free space drops below"
              value={String(cfg.clean.freeGb)}
              options={[
                { value: '5', label: '5 GB' },
                { value: '10', label: '10 GB' },
                { value: '20', label: '20 GB' },
                { value: '50', label: '50 GB' },
              ]}
              onChange={(v) => section('clean', { freeGb: Number(v) })}
            />
          </Rule>

          {hasBattery && (
            <>
              <Rule icon={BatteryCharging} title="Charge limit alert" text="Tells you when to unplug. Stopping at around 80% helps the battery last for years." on={cfg.battery.alert} onToggle={(alert) => section('battery', { alert })}>
                <Level label="Alert at" value={cfg.battery.alertPercent} min={50} max={100} step={5} unit="%" onChange={(alertPercent) => section('battery', { alertPercent })} />
              </Rule>
              <Rule icon={Bell} title="When the battery runs low" text={isAndroid ? 'Reminds you to turn on Battery saver, which Android only lets you do yourself.' : 'Switches to the efficient power mode, and back once you plug in.'} on={cfg.battery.efficiency} onToggle={(efficiency) => section('battery', { efficiency })}>
                <Level label="At" value={cfg.battery.lowPercent} min={5} max={50} step={5} unit="%" onChange={(lowPercent) => section('battery', { lowPercent })} />
              </Rule>
            </>
          )}
        </div>
      </Glass>

      {canCloseApps ? (
        <Glass className="card">
          <div className="row" style={{ gap: 10 }}>
            <Layers size={17} className="dim" />
            <h2 className="section-title">Apps G Ultra may close</h2>
          </div>
          <p className="section-sub">
            {isAndroid
              ? 'Everything else keeps running. Only used by the rules above.'
              : "Everything else keeps running. Only used by the rules above. System processes and the app you're using are never closed, and an app waiting on unsaved work stays open."}
          </p>
          <div className="list" style={{ marginTop: 6 }}>
            {candidates.map((a) => (
              <div className="list-row" key={a.name}>
                <AppIcon title={a.title} path={a.path} />
                <div className="grow">
                  <div className="row-title">{a.title}</div>
                  {a.mem > 0 && <div className="row-sub">{bytes(a.mem)} of RAM</div>}
                </div>
                <Switch checked={closeList.has(a.name.toLowerCase())} onChange={(v) => toggleApp(a.name, v)} label={`Let G Ultra close ${a.title}`} />
              </div>
            ))}
            {candidates.length === 0 && <p className="section-sub">{isAndroid ? 'Grant usage access to see your apps here.' : 'Reading your apps…'}</p>}
          </div>
        </Glass>
      ) : (
        <Glass className="notice">
          <div className="notice-icon">
            <Layers size={17} />
          </div>
          <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
            Since Android 14, apps can't close other apps, so choosing which ones stay in the background isn't possible from here. To limit an app, open it from Battery, then Background restrictions.
          </div>
        </Glass>
      )}

      <Glass className="card">
        <h2 className="section-title">Activity</h2>
        <div className="list" style={{ marginTop: 6 }}>
          {events.map((e, i) => (
            <div className="list-row" key={`${e.ts}-${i}`}>
              <CheckCircle2 size={16} className="dim" style={{ flex: 'none' }} />
              <div className="grow row-sub" style={{ whiteSpace: 'normal', color: 'var(--ink)' }}>
                {e.text}
              </div>
              <div className="small muted" style={{ flex: 'none' }}>
                {when(e.ts)}
              </div>
            </div>
          ))}
          {events.length === 0 && <p className="section-sub">Nothing yet. Whatever your rules do will show up here.</p>}
        </div>
      </Glass>
    </div>
  );
}
