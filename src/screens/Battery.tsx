import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BatteryCharging, BatteryFull, ChevronRight, Leaf, Lightbulb, Loader2, PlugZap, RotateCcw, Settings2, Sun, Zap } from 'lucide-react';
import type { Route } from '../App';
import { bridge } from '../lib/bridge';
import { clamp, dec1, duration, int } from '../lib/format';
import { loadData, useData, useLive, useSystem } from '../lib/store';
import { tasks } from '../lib/tasks';
import type { AndroidBatteryInfo, BatteryHealth, BatteryReport, WindowsBatteryInfo } from '../lib/types';
import { LineChart, type Series } from '../ui/charts';
import { Glass, PageHead, Ring, Segmented, Slider, Stat, Switch, toast } from '../ui/kit';
import { Liquid } from '../ui/Liquid';
import { PALETTE, ProcessRow } from './Home';

function batteryPalette(percent: number, charging: boolean): [string, string] {
  if (charging) return PALETTE.good;
  if (percent <= 15) return PALETTE.hot;
  if (percent <= 30) return PALETTE.warm;
  return PALETTE.good;
}

function chargeLimitGuide(maker: string, android: boolean): { title: string; text: string } {
  const m = maker.toLowerCase();
  if (android) {
    if (m.includes('samsung')) return { title: 'Turn on Battery protection', text: 'Settings > Battery > Battery protection, then choose Maximum (stops at 80%) or Adaptive.' };
    if (m.includes('google')) return { title: 'Turn on Charging optimization', text: 'Settings > Battery > Battery health > Charging optimization, then choose Limit to 80% or Adaptive.' };
    if (m.includes('oneplus') || m.includes('oppo') || m.includes('realme')) return { title: 'Turn on Optimized charging', text: 'Settings > Battery > Advanced settings > Optimized charging. Newer models also offer a limit of 80%.' };
    if (m.includes('xiaomi') || m.includes('redmi') || m.includes('poco')) return { title: 'Turn on Smart charging', text: 'Settings > Battery > Battery protection > Optimized charging. The name varies between models.' };
    if (m.includes('motorola')) return { title: 'Turn on Optimized charging', text: 'Settings > Battery > Charging settings, then turn on Optimized charging or the 80% limit.' };
    if (m.includes('huawei') || m.includes('honor')) return { title: 'Turn on Smart charge', text: 'Settings > Battery > More battery settings > Smart charge.' };
    if (m.includes('sony')) return { title: 'Turn on Battery Care', text: 'Settings > Battery > Battery Care.' };
    if (m.includes('asus')) return { title: 'Turn on Customized charging', text: 'Settings > Battery > Customized charging, then set a limit of 80%.' };
    return { title: 'Look for a charge limit', text: 'Search for "charging" in your phone\'s Settings. Most recent phones can stop at 80%.' };
  }
  if (m.includes('hp') || m.includes('hewlett')) return { title: 'Turn on the HP charge limit', text: 'Restart and press F10 to enter the BIOS. Look for Adaptive Battery Optimizer or Battery Health Manager and turn it on. Not every HP model has it.' };
  if (m.includes('lenovo')) return { title: 'Turn on Conservation Mode', text: 'Lenovo Vantage > Device > Power > Conservation Mode. It stops charging at around 60 to 80%.' };
  if (m.includes('asus')) return { title: 'Turn on Battery Care Mode', text: 'MyASUS > Customization > Battery Care Mode, then choose Maximum Lifespan (60%) or Balanced (80%).' };
  if (m.includes('dell')) return { title: 'Set the charge mode', text: 'Dell Power Manager or the BIOS > Battery Configuration, then choose Primarily AC Use or a custom limit.' };
  if (m.includes('acer')) return { title: 'Turn on the charge limit', text: 'Acer Care Center > Battery Charge Limit. It stops charging at 80%.' };
  if (m.includes('msi') || m.includes('micro-star')) return { title: 'Use Battery Master', text: 'MSI Center > Features > Battery Master, then choose Best for Battery.' };
  if (m.includes('samsung')) return { title: 'Turn on Battery Life Extender', text: 'Samsung Settings > Battery Life Extender. It stops charging at 80 to 85%.' };
  if (m.includes('microsoft')) return { title: 'Turn on Smart Charging', text: 'Surface app > Battery and charging, then turn on the charge limit.' };
  if (m.includes('razer')) return { title: 'Use Battery Health Optimizer', text: 'Razer Synapse > System > Performance > Battery Health Optimizer.' };
  if (m.includes('huawei') || m.includes('honor')) return { title: 'Turn on Battery protection', text: 'PC Manager > Settings > Battery > Battery protection.' };
  if (m.includes('gigabyte') || m.includes('aorus')) return { title: 'Set a charge limit', text: 'Gigabyte Control Center > Smart Charge.' };
  return { title: 'Look for a charge limit', text: "Check the BIOS and your laptop maker's control app. Many laptops can stop charging at 80%." };
}

function Tip({ icon: Icon, title, text, warn }: { icon: typeof Zap; title: string; text: string; warn?: boolean }) {
  return (
    <div className="list-row" style={{ alignItems: 'flex-start' }}>
      <div className="notice-icon" style={warn ? { background: 'rgba(255,159,10,.14)' } : undefined}>
        <Icon size={17} color={warn ? 'var(--warning)' : undefined} />
      </div>
      <div className="grow">
        <div className="row-title" style={{ whiteSpace: 'normal' }}>
          {title}
        </div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>
          {text}
        </div>
      </div>
    </div>
  );
}

function LifeCard({ health, percent, onAc, tempC, android, nav }: { health: BatteryHealth | null | undefined; percent: number | null; onAc: boolean; tempC: number | null; android: boolean; nav: (r: Route) => void }) {
  const system = useSystem();
  const guide = chargeLimitGuide(system?.manufacturer ?? '', android);
  const pct = health?.healthPct ?? null;
  return (
    <Glass className="card">
      <h2 className="section-title">Make the battery last for years</h2>
      <p className="section-sub">What wears a lithium-ion battery fastest is heat and sitting at a full charge.</p>
      <div className="list" style={{ marginTop: 6 }}>
        <Tip icon={BatteryCharging} title={guide.title} text={guide.text} />
        {onAc && percent != null && percent >= 95 ? (
          <Tip icon={PlugZap} warn title={`It's sitting at ${percent}% on the charger`} text="This is hard on the battery over months. If you mostly stay plugged in, a charge limit is the single most useful thing you can do." />
        ) : (
          <Tip icon={BatteryFull} title="Keep it between 20 and 80%" text="You don't need to be strict. Short top-ups are gentler than deep discharges, and charging to 100% is fine when you need the range." />
        )}
        {tempC != null && tempC >= 38 ? (
          <Tip icon={AlertTriangle} warn title={`The battery is warm: ${Math.round(tempC)}°C`} text={android ? 'Take the case off while charging, keep it out of the sun, and avoid gaming or navigation while it charges.' : 'Keep the vents clear and use it on a hard surface. Close heavy apps while it charges.'} />
        ) : (
          <Tip icon={Sun} title="Keep it cool" text={android ? "Don't leave it in the sun or in a hot car. Fast and wireless charging add heat, so use slow charging overnight when you can." : 'Use it on a hard surface so the vents can breathe, and clean them once in a while. Heat shortens battery life more than anything else.'} />
        )}
        <Tip icon={Leaf} title="Storing it for weeks?" text="Leave it at around 50% and turn it off. Stored flat or full, a battery loses capacity for good." />
        <Tip icon={Zap} title="Skip the full discharges" text="Modern batteries don't need them. Run it down to 0% only if the percentage starts jumping around, to recalibrate it." />
        {pct != null && pct < 80 && (
          <button className="list-row" onClick={() => nav('components')}>
            <div className="notice-icon" style={{ background: 'rgba(255,159,10,.14)' }}>
              <AlertTriangle size={17} color="var(--warning)" />
            </div>
            <div className="grow">
              <div className="row-title">At {Math.round(pct)}% health, a replacement is worth considering</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                The battery code and details are in Components.
              </div>
            </div>
            <ChevronRight size={16} className="row-chev" />
          </button>
        )}
      </div>
    </Glass>
  );
}

function HealthCard({ h, nav }: { h: BatteryHealth | null | undefined; nav: (r: Route) => void }) {
  const pct = h?.healthPct ?? null;
  const unit = h?.unit === 'mAh' ? 'mAh' : 'Wh';
  const fmt = (v: number | null | undefined) => (v == null ? '—' : unit === 'Wh' ? `${dec1(v / 1000)} Wh` : `${int(v)} mAh`);
  return (
    <Glass className="card">
      <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
        {pct != null && (
          <Ring value={pct} size={92} stroke={8} color={pct < 60 ? 'var(--critical)' : pct < 80 ? 'var(--warning)' : 'var(--good)'}>
            <div className="num" style={{ fontSize: 23, fontWeight: 640 }}>
              {Math.round(pct)}
              <span style={{ fontSize: 13 }}>%</span>
            </div>
            <div className="muted" style={{ fontSize: 10.5 }}>
              health
            </div>
          </Ring>
        )}
        <div className="grow">
          <h2 className="section-title">Battery health</h2>
          <div className="stat-grid" style={{ marginTop: 10 }}>
            {h?.fullCapacity != null && <Stat value={fmt(h.fullCapacity)} label="Capacity now" />}
            {h?.designCapacity != null && <Stat value={fmt(h.designCapacity)} label="When new" />}
            {h?.cycles != null && <Stat value={int(h.cycles)} label="Charge cycles" />}
            {h?.chemistry && <Stat value={h.chemistry} label="Type" />}
          </div>
          {h?.estimated && pct != null && <p className="section-sub">Estimated from the charge counter. Most accurate between 50 and 100% charge.</p>}
          {pct == null && <p className="section-sub">{h?.status ?? "This device doesn't report the battery's real capacity."}</p>}
        </div>
      </div>
      <button className="list-row" style={{ marginTop: 10 }} onClick={() => nav('components')}>
        <div className="grow row-title">Battery code and replacement</div>
        <ChevronRight size={16} className="row-chev" />
      </button>
    </Glass>
  );
}

function HistoryCard({ report }: { report: BatteryReport }) {
  const points = report.history;
  const series: Series[] = [{ id: 'capacity', name: 'Capacity', color: 'var(--s1)', values: points.map((p) => p.full / 1000) }];
  const ts = points.map((p) => new Date(p.date).getTime());
  const label = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return (
    <Glass className="card">
      <h2 className="section-title">Capacity over time</h2>
      {report.wearPerYear != null ? (
        <p className="section-sub">
          You're losing about {dec1(report.wearPerYear)}% of the original capacity per year.
          {report.yearsTo60 != null && ` At this rate it reaches 60%, where most people replace it, in about ${dec1(report.yearsTo60)} years.`}
        </p>
      ) : (
        <p className="section-sub">Recorded by Windows.</p>
      )}
      <div style={{ marginTop: 10 }}>
        <LineChart series={series} ts={ts} height={180} unit=" Wh" xStart={label(points[0].date)} xEnd={label(points[points.length - 1].date)} tipLabel={(i) => label(points[i].date)} />
      </div>
      {report.runtimeSec != null && (
        <p className="section-sub" style={{ marginTop: 8 }}>
          A full charge gives about {duration(report.runtimeSec)} of active use
          {report.designRuntimeSec != null ? `, compared with ${duration(report.designRuntimeSec)} when new` : ''}.
        </p>
      )}
    </Glass>
  );
}

// ---- Windows ----
const SCREEN_OFF = [
  { value: '60', label: '1 min' },
  { value: '120', label: '2 min' },
  { value: '300', label: '5 min' },
  { value: '600', label: '10 min' },
  { value: '0', label: 'Never' },
];
const SLEEP = [
  { value: '300', label: '5 min' },
  { value: '600', label: '10 min' },
  { value: '1800', label: '30 min' },
  { value: '3600', label: '1 hour' },
  { value: '0', label: 'Never' },
];
const SAVER = [
  { value: '0', label: 'Off' },
  { value: '20', label: '20%' },
  { value: '50', label: '50%' },
  { value: '100', label: 'Always' },
];
const CPU = [
  { value: '100', label: 'Full' },
  { value: '99', label: 'No turbo' },
  { value: '80', label: '80%' },
];
const MODES = [
  { value: 'efficiency', label: 'Efficiency' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'performance', label: 'Performance' },
];
const MODE_VALUE: Record<string, number> = { efficiency: 0, balanced: 1, performance: 2 };

const BACKUP_KEY = 'gultra.batteryBackup';

function readBackup(): Record<string, number> | null {
  try {
    return JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
  } catch {
    return null;
  }
}

function writeBackup(v: Record<string, number> | null) {
  try {
    if (v) localStorage.setItem(BACKUP_KEY, JSON.stringify(v));
    else localStorage.removeItem(BACKUP_KEY);
  } catch {
    /* the backup only lasts this session */
  }
}

function SettingRow({ title, text, children }: { title: string; text?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="grow">
        <div className="row-title" style={{ whiteSpace: 'normal' }}>
          {title}
        </div>
        {text && (
          <div className="row-sub" style={{ whiteSpace: 'normal' }}>
            {text}
          </div>
        )}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function WindowsBattery({ nav }: { nav: (r: Route) => void }) {
  const live = useLive();
  const info = useData<WindowsBatteryInfo>('batteryInfo', () => bridge.win!.batteryInfo(), 3000);
  const report = useData<BatteryReport | null>('batteryReport', () => bridge.win!.batteryReport(), 600000);
  const reload = () => loadData('batteryInfo', () => bridge.win!.batteryInfo());
  const [backup, setBackup] = useState(readBackup);
  const [applying, setApplying] = useState(false);
  const [brightness, setBrightness] = useState<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) void reload();
    }, 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const d = info.data;
  const health = d?.health ? { ...d.health, cycles: d.health.cycles ?? report.data?.cycles ?? null } : d?.health;
  const percent = live?.power?.percent ?? d?.percent ?? null;
  const charging = live?.power?.charging ?? d?.charging ?? false;
  const onAc = live?.power?.onAc ?? d?.onAc ?? false;
  const watts = live?.power?.watts ?? d?.watts ?? null;
  const batteryTemp = live?.sensors.find((s) => s.group === 'battery')?.celsius ?? null;

  const set = (key: string, value: number) => {
    bridge.win
      ?.batterySet(key, value)
      .then(reload)
      .catch((e: Error) => toast(e.message, 'warning'));
  };

  const runAll = async (settings: Record<string, number>) => {
    for (const [key, value] of Object.entries(settings)) {
      try {
        await bridge.win!.batterySet(key, value);
      } catch {
        /* a setting this PC doesn't support shouldn't stop the others */
      }
    }
    await reload();
  };

  const applyProfile = async () => {
    if (!d) return;
    setApplying(true);
    const saved: Record<string, number> = {};
    if (d.powerMode) saved.powerMode = MODE_VALUE[d.powerMode];
    if (d.saverThreshold != null) saved.saverThreshold = d.saverThreshold;
    if (d.screenOffSec != null) saved.screenOff = d.screenOffSec;
    if (d.sleepSec != null) saved.sleep = d.sleepSec;
    if (d.cpuMax != null) saved.cpuMax = d.cpuMax;
    if (d.brightness != null) saved.brightness = d.brightness;
    writeBackup(saved);
    setBackup(saved);
    const target: Record<string, number> = { powerMode: 0, saverThreshold: 50, screenOff: 120, sleep: 600, cpuMax: 99 };
    if (d.brightness != null && d.brightness > 40) target.brightness = 40;
    await tasks.run({ id: 'batteryProfile', label: 'Applying battery settings', route: 'battery' }, () => runAll(target));
    setApplying(false);
    toast('Battery saving profile applied. You can undo it at any time.');
  };

  const restore = async () => {
    if (!backup) return;
    setApplying(true);
    await tasks.run({ id: 'batteryProfile', label: 'Restoring your settings', route: 'battery' }, () => runAll(backup));
    writeBackup(null);
    setBackup(null);
    setApplying(false);
    toast('Your previous settings are back.');
  };

  const status = charging ? 'Charging' : onAc ? 'Plugged in, not charging' : d?.secondsLeft ? `About ${duration(d.secondsLeft)} left` : 'On battery';
  const shownBrightness = brightness ?? d?.brightness ?? 50;
  const consumers = [...(live?.processes ?? [])].filter((p) => !p.critical).sort((a, b) => b.cpu - a.cpu).slice(0, 5);
  const maxCpu = Math.max(5, ...consumers.map((p) => p.cpu));
  const refreshOptions = d?.refresh?.options ?? [];

  return (
    <div className="stack">
      <PageHead title="Battery" subtitle="Get more time out of each charge, and more years out of the battery." />

      <div className="grid-mem">
        <Glass className="tile" style={{ minHeight: 240 }}>
          <Liquid layers={[{ value: clamp((percent ?? 0) / 100), color: batteryPalette(percent ?? 100, charging) }]} energy={charging ? 0.5 : 0.15} bubbles={charging} />
          <div className="tile-shine" />
          <div className="tile-top">
            <span>{d?.saverOn ? 'Battery saver on' : 'Battery'}</span>
            {charging ? <BatteryCharging size={16} /> : <BatteryFull size={16} />}
          </div>
          <div className="tile-bottom">
            <div className="tile-value" style={{ fontSize: 68 }}>
              {percent ?? '—'}
              <small style={{ fontSize: 28 }}>%</small>
            </div>
            <div className="tile-sub" style={{ fontSize: 14 }}>
              {status}
              {watts != null && watts > 0 ? ` · ${watts.toLocaleString('en-US')} W` : ''}
            </div>
          </div>
        </Glass>
        <HealthCard h={health} nav={nav} />
      </div>

      <Glass className="clean-hero">
        <div>
          <h2 className="section-title">Longest battery life</h2>
          <p className="section-sub" style={{ maxWidth: '58ch' }}>
            One tap for efficient power mode, processor without turbo, a dimmer screen, and shorter screen and sleep timers. Most of these apply only on battery.
          </p>
        </div>
        {backup ? (
          <button className="btn lg" disabled={applying} onClick={restore}>
            {applying ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />} Undo
          </button>
        ) : (
          <button className="btn primary lg" disabled={applying || !d} onClick={applyProfile}>
            {applying ? <Loader2 size={17} className="spin" /> : <Leaf size={17} />} Apply
          </button>
        )}
      </Glass>

      <Glass className="card">
        <h2 className="section-title">Settings</h2>
        {!d && (
          <div className="row" style={{ marginTop: 10 }}>
            <Loader2 size={16} className="spin" /> Reading your settings…
          </div>
        )}
        {d && (
          <div style={{ marginTop: 4 }}>
            {d.powerMode && (
              <SettingRow title="Power mode" text="Efficiency saves the most. Performance runs hotter and drains faster.">
                <Segmented label="Power mode" value={d.powerMode} options={MODES} onChange={(v) => set('powerMode', MODE_VALUE[v])} />
              </SettingRow>
            )}
            {d.saverThreshold != null && (
              <SettingRow title="Battery saver turns on at" text="Dims the screen and limits background activity.">
                <Segmented label="Battery saver threshold" value={String(d.saverThreshold)} options={SAVER} onChange={(v) => set('saverThreshold', Number(v))} />
              </SettingRow>
            )}
            {d.brightness != null && (
              <SettingRow title="Screen brightness" text="The screen is usually the biggest drain.">
                <div className="row" style={{ gap: 10, width: 240 }}>
                  <Slider value={shownBrightness} min={0} max={100} onChange={setBrightness} onCommit={(v) => { set('brightness', v); setBrightness(null); }} label="Screen brightness" />
                  <span className="row-value" style={{ width: 40 }}>
                    {Math.round(shownBrightness)}%
                  </span>
                </div>
              </SettingRow>
            )}
            {refreshOptions.length > 1 && (
              <SettingRow title="Screen refresh rate" text="A lower rate saves power, and matters most on fast gaming screens.">
                <Segmented label="Screen refresh rate" value={String(d.refresh!.current)} options={refreshOptions.map((r) => ({ value: String(r), label: `${r} Hz` }))} onChange={(v) => set('refreshRate', Number(v))} />
              </SettingRow>
            )}
            {d.screenOffSec != null && (
              <SettingRow title="Turn off the screen after" text="On battery.">
                <Segmented label="Turn off the screen after" value={String(d.screenOffSec)} options={SCREEN_OFF} onChange={(v) => set('screenOff', Number(v))} />
              </SettingRow>
            )}
            {d.sleepSec != null && (
              <SettingRow title="Go to sleep after" text="On battery.">
                <Segmented label="Go to sleep after" value={String(d.sleepSec)} options={SLEEP} onChange={(v) => set('sleep', Number(v))} />
              </SettingRow>
            )}
            {d.cpuMax != null && (
              <SettingRow title="Processor limit" text="On battery. No turbo saves a lot and runs much cooler, with little difference in everyday work.">
                <Segmented label="Processor limit" value={String(d.cpuMax)} options={CPU} onChange={(v) => set('cpuMax', Number(v))} />
              </SettingRow>
            )}
            <button className="list-row" onClick={() => nav('memory')}>
              <div className="grow">
                <div className="row-title">Apps that start with Windows</div>
                <div className="row-sub">Turn off the ones you don't need, in Memory</div>
              </div>
              <ChevronRight size={16} className="row-chev" />
            </button>
          </div>
        )}
      </Glass>

      {consumers.length > 0 && (
        <Glass className="card">
          <h2 className="section-title">What's draining it now</h2>
          <p className="section-sub">Apps working the processor hardest. Closing the ones you aren't using helps right away.</p>
          <div className="list" style={{ marginTop: 6 }}>
            {consumers.map((p) => (
              <ProcessRow key={p.key} p={p} sort="cpu" max={maxCpu} />
            ))}
          </div>
        </Glass>
      )}

      {report.data && report.data.history.length > 1 && <HistoryCard report={report.data} />}
      <LifeCard health={health} percent={percent} onAc={onAc} tempC={batteryTemp} android={false} nav={nav} />
    </div>
  );
}

// ---- Android ----
const TIMEOUTS = [
  { value: '15', label: '15 s' },
  { value: '30', label: '30 s' },
  { value: '60', label: '1 min' },
  { value: '120', label: '2 min' },
  { value: '300', label: '5 min' },
];

const SCREENS: { screen: string; title: string; text: string }[] = [
  { screen: 'batteryUsage', title: 'Battery use by app', text: 'See what used the most since the last charge' },
  { screen: 'batteryOptimization', title: 'Background restrictions', text: 'Stop apps you rarely use from running in the background' },
  { screen: 'display', title: 'Display', text: 'Dark mode and refresh rate. On OLED screens, dark mode saves real power' },
  { screen: 'location', title: 'Location', text: 'Limit which apps can use GPS all the time' },
  { screen: 'wifi', title: 'Wi-Fi', text: 'Wi-Fi uses far less power than mobile data' },
  { screen: 'bluetooth', title: 'Bluetooth', text: 'Turn it off when nothing is connected' },
  { screen: 'dataSaver', title: 'Background data', text: 'Limit which apps sync over mobile data' },
];

function AndroidBattery({ nav }: { nav: (r: Route) => void }) {
  const live = useLive();
  const info = useData<AndroidBatteryInfo>('batteryInfo', () => bridge.android!.batteryInfo(), 3000);
  const reload = () => loadData('batteryInfo', () => bridge.android!.batteryInfo());
  const [brightness, setBrightness] = useState<number | null>(null);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // Coming back from a system screen, settings and permissions may have changed.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void reloadRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    const id = window.setInterval(onVisible, 15000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(id);
    };
  }, []);

  const d = info.data;
  const percent = d?.percent ?? live?.power?.percent ?? null;
  const charging = d?.charging ?? false;

  const set = (key: string, value: number) => {
    bridge.android
      ?.batterySet(key, value)
      .then(reload)
      .catch((e: Error) => toast(e.message, 'warning'));
  };
  const open = (screen: string) => void bridge.android?.openSystemScreen(screen);

  const pluggedLabel = d?.plugged === 'wireless' ? 'wireless' : d?.plugged === 'usb' ? 'USB' : d?.plugged === 'ac' ? 'charger' : null;
  const status = charging ? `Charging${pluggedLabel ? ` · ${pluggedLabel}` : ''}${d?.chargeTimeSec ? ` · full in ${duration(d.chargeTimeSec)}` : ''}` : pluggedLabel ? 'Plugged in' : 'On battery';
  const apps = live?.processes ?? [];
  const maxUse = Math.max(1, ...apps.map((a) => a.usageMs ?? 0));

  return (
    <div className="stack">
      <PageHead title="Battery" subtitle="Get more time out of each charge, and more years out of the battery." />

      <Glass className="tile" style={{ minHeight: 210 }}>
        <Liquid layers={[{ value: clamp((percent ?? 0) / 100), color: batteryPalette(percent ?? 100, charging) }]} energy={charging ? 0.5 : 0.15} bubbles={charging} />
        <div className="tile-shine" />
        <div className="tile-top">
          <span>{d?.powerSave ? 'Battery saver on' : 'Battery'}</span>
          {charging ? <BatteryCharging size={16} /> : <BatteryFull size={16} />}
        </div>
        <div className="tile-bottom">
          <div className="tile-value" style={{ fontSize: 60 }}>
            {percent ?? '—'}
            <small style={{ fontSize: 26 }}>%</small>
          </div>
          <div className="tile-sub" style={{ whiteSpace: 'normal' }}>
            {status}
            {d?.tempC != null ? ` · ${Math.round(d.tempC)}°C` : ''}
            {d?.watts != null && d.watts > 0 ? ` · ${d.watts.toLocaleString('en-US')} W` : ''}
          </div>
        </div>
      </Glass>

      <HealthCard h={d?.health} nav={nav} />

      <Glass className="card">
        <h2 className="section-title">Save battery now</h2>
        <div className="list" style={{ marginTop: 6 }}>
          <div className="list-row">
            <div className="grow">
              <div className="row-title">Battery saver</div>
              <div className="row-sub">{d?.powerSave ? 'On' : 'Off'}. Android only lets you change it in its own settings.</div>
            </div>
            <button className="btn sm" onClick={() => open('batterySaver')}>
              Open
            </button>
          </div>
        </div>

        {d && !d.canWrite && (
          <div className="row between" style={{ marginTop: 8 }}>
            <span className="section-sub" style={{ margin: 0 }}>
              To change brightness and the screen timeout from here, Android asks for one permission.
            </span>
            <button className="btn sm" style={{ flex: 'none' }} onClick={() => open('writeSettings')}>
              Grant
            </button>
          </div>
        )}
        {d && d.canWrite && (
          <>
            {d.brightness != null && (
              <div className="setting-stack">
                <div className="row between">
                  <div className="row-title">Brightness</div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="label">Automatic</span>
                    <Switch checked={d.adaptiveBrightness} onChange={(v) => set('adaptive', v ? 1 : 0)} label="Automatic brightness" />
                  </div>
                </div>
                <Slider value={brightness ?? d.brightness} min={0} max={100} onChange={setBrightness} onCommit={(v) => { set('brightness', v); setBrightness(null); }} label="Brightness" />
              </div>
            )}
            {d.screenTimeoutSec != null && (
              <div className="setting-stack">
                <div className="row-title">Screen timeout</div>
                <Segmented label="Screen timeout" value={String(d.screenTimeoutSec)} options={TIMEOUTS} onChange={(v) => set('screenTimeout', Number(v))} />
              </div>
            )}
          </>
        )}
        <div className="list" style={{ marginTop: 6 }}>
          {SCREENS.map((s) => (
            <button className="list-row" key={s.screen} onClick={() => open(s.screen)}>
              <Settings2 size={17} className="dim" style={{ flex: 'none' }} />
              <div className="grow">
                <div className="row-title">{s.title}</div>
                <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                  {s.text}
                </div>
              </div>
              <ChevronRight size={16} className="row-chev" />
            </button>
          ))}
        </div>
      </Glass>

      <Glass className="card">
        <h2 className="section-title">Used most recently</h2>
        <p className="section-sub">Screen time over the last 3 hours. Tap Details to force-stop an app or limit its battery use.</p>
        <div className="list" style={{ marginTop: 6 }}>
          {apps.slice(0, 6).map((p) => (
            <ProcessRow key={p.key} p={p} sort="cpu" max={maxUse} />
          ))}
          {apps.length === 0 && (
            <div className="empty-state" style={{ padding: '14px 0' }}>
              <button className="btn sm" onClick={() => bridge.android?.requestUsageAccess()}>
                Grant usage access
              </button>
            </div>
          )}
        </div>
      </Glass>

      <LifeCard health={d?.health} percent={percent} onAc={d?.plugged != null} tempC={d?.tempC ?? null} android nav={nav} />
      <Glass className="notice">
        <div className="notice-icon">
          <Lightbulb size={17} />
        </div>
        <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
          Don't bother closing every app by hand. Android manages memory well, and reopening apps often uses more battery than leaving them.
        </div>
      </Glass>
    </div>
  );
}

export function Battery({ nav }: { nav: (r: Route) => void }) {
  return bridge.platform === 'android' ? <AndroidBattery nav={nav} /> : <WindowsBattery nav={nav} />;
}
