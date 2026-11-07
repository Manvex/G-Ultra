import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Gauge, Info, Leaf, Rocket, Smartphone, Snowflake, Sun, Zap } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { cpuTemp, loadData, store, useData, useLive, useSystem } from '../lib/store';
import type { CpuTuningInfo, GpuAppUse, GpuSample, NvidiaGpu, ProcessItem } from '../lib/types';
import { AppIcon, Glass, Segmented, Slider, Switch, toast } from '../ui/kit';
import { requestElevation } from './Sheets';

type Verdict = { level: 'good' | 'info' | 'warning'; title: string; text: string };

function VerdictNotice({ v }: { v: Verdict }) {
  const color = v.level === 'good' ? 'var(--good)' : v.level === 'warning' ? 'var(--warning)' : 'var(--info)';
  return (
    <Glass className="notice">
      <div className="notice-icon">{v.level === 'good' ? <Check size={17} color={color} /> : v.level === 'warning' ? <AlertTriangle size={17} color={color} /> : <Info size={17} color={color} />}</div>
      <div className="grow">
        <div className="row-title">{v.title}</div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>
          {v.text}
        </div>
      </div>
    </Glass>
  );
}

// ---- processor ----
const average = (values: (number | null)[]) => {
  const list = values.slice(-30).filter((v): v is number => v != null);
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
};

/** These are rules of thumb from what the sensors show, so the wording stays "may". */
export function CpuDiagnosis() {
  const live = useLive();
  if (!live) return null;
  const temp = cpuTemp((live.sensors ?? []).filter((s) => s.celsius != null));
  if (temp == null) return null;
  const load = average(store.history.cpu) ?? live.cpu.usage ?? 0;
  const heavy = [...live.processes].sort((a, b) => b.cpu - a.cpu)[0];
  const t = Math.round(temp);

  let v: Verdict;
  if (live.throttling) {
    v = { level: 'warning', title: 'The processor is slowing itself down', text: `It's at ${t}°C and is reducing its speed to protect itself. Try Cool mode, make sure the vents are clear, and raise the fan speed.` };
  } else if (load < 15 && temp >= 65) {
    v = { level: 'warning', title: `Hot for how little it's doing`, text: `${t}°C at ${Math.round(load)}% load. Dust in the fans or old thermal paste may be the cause, especially if this PC is a few years old.` };
  } else if (temp >= 85) {
    v = {
      level: 'warning',
      title: 'Running hot',
      text: heavy && heavy.cpu >= 25 ? `${t}°C, and ${heavy.title} is using ${Math.round(heavy.cpu)}% of the processor. Close it or put it in efficiency mode, or try Cool mode.` : `${t}°C under load. Cool mode should bring this down.`,
    };
  } else if (heavy && heavy.cpu >= 40) {
    v = { level: 'info', title: `${heavy.title} is the main source of heat`, text: `It's using ${Math.round(heavy.cpu)}% of the processor, and the temperature is ${t}°C.` };
  } else {
    v = { level: 'good', title: 'Temperature looks normal', text: `${t}°C at ${Math.round(load)}% load.` };
  }
  return <VerdictNotice v={v} />;
}

const MODE_TEXT: Record<string, string> = {
  cool: 'Turbo Boost is off and speed is limited. Runs cooler and quieter, and heavy apps run slower.',
  balanced: 'Your usual Windows settings.',
  performance: "Removes the limits Windows sets and keeps the processor at high speed when plugged in. It isn't overclocking. Runs hotter and louder and uses more power.",
  custom: 'Your own settings, set below. Choose Balanced to go back to what you had.',
};

export function CpuCooling() {
  const system = useSystem();
  const data = useData<CpuTuningInfo>('cpuTuning', () => bridge.win!.cpuTuning(), 15000);
  const info = data.data;
  const [maxAc, setMaxAc] = useState(100);
  const [maxDc, setMaxDc] = useState(100);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (info?.maxAc != null) setMaxAc(info.maxAc);
    if (info?.maxDc != null) setMaxDc(info.maxDc);
  }, [info?.maxAc, info?.maxDc]);

  const apply = async (job: () => Promise<CpuTuningInfo>, done?: string) => {
    setBusy(true);
    try {
      await job();
      await loadData('cpuTuning', () => bridge.win!.cpuTuning());
      if (done) toast(done);
    } catch (e) {
      toast((e as Error).message, 'warning');
    }
    setBusy(false);
  };

  if (!info) return null;

  return (
    <Glass className="card">
      <div className="row between wrap" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10 }}>
          <Snowflake size={17} className="dim" />
          <h2 className="section-title">CPU cooling</h2>
        </div>
        <Segmented
          label="CPU mode"
          disabled={busy}
          value={info.mode}
          options={[
            { value: 'cool', label: 'Cool' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'performance', label: 'Maximum performance' },
          ]}
          onChange={(mode) => void apply(() => bridge.win!.cpuTuningMode(mode), mode === 'balanced' ? 'Back to your usual settings.' : mode === 'cool' ? 'Cool mode is on.' : 'Maximum performance is on.')}
        />
      </div>
      <p className="section-sub" style={{ marginTop: 8 }}>
        {MODE_TEXT[info.mode]} It stays on until you change it, and some laptops and BIOS settings can override it.
      </p>

      <div className="list" style={{ marginTop: 6 }}>
        {info.boost != null && (
          <div className="list-row">
            <div className="grow">
              <div className="row-title">Turbo Boost</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                Lets the processor go above its base speed. Turning it off usually lowers temperatures the most.
              </div>
            </div>
            <Switch checked={info.boost} disabled={busy} onChange={(on) => void apply(() => bridge.win!.cpuTuningSet('boost', on ? 1 : 0))} label="Turbo Boost" />
          </div>
        )}
        {info.maxAc != null && (
          <div className="tune">
            <div className="row between small">
              <span className="row-title">{system?.hasBattery ? 'Speed limit when plugged in' : 'Speed limit'}</span>
              <span className="num" style={{ fontWeight: 560 }}>
                {maxAc}%
              </span>
            </div>
            <Slider value={maxAc} min={50} max={100} step={5} disabled={busy} onChange={setMaxAc} onCommit={(v) => void apply(() => bridge.win!.cpuTuningSet('maxAc', v))} label="Speed limit when plugged in" />
          </div>
        )}
        {system?.hasBattery && info.maxDc != null && (
          <div className="tune">
            <div className="row between small">
              <span className="row-title">Speed limit on battery</span>
              <span className="num" style={{ fontWeight: 560 }}>
                {maxDc}%
              </span>
            </div>
            <Slider value={maxDc} min={50} max={100} step={5} disabled={busy} onChange={setMaxDc} onCommit={(v) => void apply(() => bridge.win!.cpuTuningSet('maxDc', v))} label="Speed limit on battery" />
          </div>
        )}
        {info.coolingActive != null && (
          <div className="list-row">
            <div className="grow">
              <div className="row-title">When it gets hot</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                Fans first keeps speed but is louder. Slow down first is quieter.
              </div>
            </div>
            <Segmented
              label="When it gets hot"
              disabled={busy}
              value={info.coolingActive ? 'active' : 'passive'}
              options={[
                { value: 'active', label: 'Fans first' },
                { value: 'passive', label: 'Slow down first' },
              ]}
              onChange={(v) => void apply(() => bridge.win!.cpuTuningSet('cooling', v === 'active' ? 1 : 0))}
            />
          </div>
        )}
      </div>
    </Glass>
  );
}

// The same modes, in the Monitor's list of rules. They stay on in the background.
export function CpuModeRule() {
  const data = useData<CpuTuningInfo>('cpuTuning', () => bridge.win!.cpuTuning(), 15000);
  const [busy, setBusy] = useState(false);
  const info = data.data;
  if (!info) return null;
  const choose = async (mode: string) => {
    setBusy(true);
    try {
      await bridge.win!.cpuTuningMode(mode);
      await loadData('cpuTuning', () => bridge.win!.cpuTuning());
    } catch (e) {
      toast((e as Error).message, 'warning');
    }
    setBusy(false);
  };
  return (
    <div className="rule">
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="notice-icon">
          <Snowflake size={17} />
        </div>
        <div className="grow">
          <div className="row-title">CPU mode</div>
          <div className="row-sub" style={{ whiteSpace: 'normal' }}>
            {MODE_TEXT[info.mode]} Thermals has the detailed settings.
          </div>
        </div>
      </div>
      <div className="rule-body">
        <Segmented
          label="CPU mode"
          disabled={busy}
          value={info.mode}
          options={[
            { value: 'cool', label: 'Cool' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'performance', label: 'Maximum performance' },
          ]}
          onChange={(mode) => void choose(mode)}
        />
      </div>
    </div>
  );
}

export function OverclockCard() {
  const data = useData<CpuTuningInfo>('cpuTuning', () => bridge.win!.cpuTuning(), 15000);
  const oc = data.data?.overclock;
  if (!oc) return null;

  const text = {
    unlocked: `Your ${oc.cpu} can be overclocked.`,
    maybe: `Your ${oc.cpu} supports overclocking, but many laptops block it in the BIOS.`,
    locked: `Your ${oc.cpu} is locked by its maker, so it can't be overclocked. Maximum performance above is the most it can do.`,
    unknown: `G Ultra couldn't tell whether your ${oc.cpu} can be overclocked.`,
  }[oc.status];

  const open = () => {
    if (oc.installed) void bridge.win!.overclockToolOpen().catch((e: Error) => toast(e.message, 'warning'));
    else if (oc.url) bridge.openLink(oc.url);
  };

  return (
    <Glass className="card">
      <div className="row" style={{ gap: 10 }}>
        <Rocket size={17} className="dim" />
        <h2 className="section-title">Overclocking</h2>
      </div>
      <p className="section-sub">{text}</p>
      {oc.status !== 'locked' && oc.tool && (
        <>
          <p className="section-sub" style={{ marginTop: 8 }}>
            Overclocking is done in {oc.tool}, the maker's own tool, because it knows the safe limits of your processor. It makes the processor hotter, can make your PC unstable, and may affect your warranty.
          </p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn sm" onClick={open}>
              {oc.installed ? `Open ${oc.tool}` : `Get ${oc.tool}`}
              <ChevronRight size={14} />
            </button>
          </div>
        </>
      )}
    </Glass>
  );
}

// Efficiency mode for the apps working the processor hardest.
export function AppEfficiency({ processes }: { processes: ProcessItem[] }) {
  const list = useMemo(() => processes.filter((p) => !p.critical && p.cpu >= 1).slice(0, 5), [processes]);
  const pids = useRef<number[]>([]);
  pids.current = list.flatMap((p) => p.pids);
  const [on, setOn] = useState<Set<number>>(new Set());

  const refresh = () => {
    if (pids.current.length) void bridge.win!.appEfficiencyState(pids.current).then((r) => setOn(new Set(r)), () => {});
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, []);

  if (list.length === 0) return null;

  const toggle = (p: ProcessItem, value: boolean) => {
    void bridge
      .win!.appEfficiencySet(p.pids, value)
      .then((r) => {
        if (r.changed === 0) toast(`${p.title} can't be changed from here. It may need full mode.`, 'warning');
        refresh();
      })
      .catch((e: Error) => toast(e.message, 'warning'));
  };

  return (
    <Glass className="card">
      <div className="row" style={{ gap: 10 }}>
        <Leaf size={17} className="dim" />
        <h2 className="section-title">Efficiency mode</h2>
      </div>
      <p className="section-sub">Gives an app less of the processor without closing it, so it may run slower. It lasts until the app closes.</p>
      <div className="list" style={{ marginTop: 6 }}>
        {list.map((p) => (
          <div className="list-row" key={p.key}>
            <AppIcon title={p.title} path={p.path} icon={p.icon} />
            <div className="grow row-title">{p.title}</div>
            <span className="small dim num">{Math.round(p.cpu)}%</span>
            <Switch checked={p.pids.some((id) => on.has(id))} onChange={(v) => toggle(p, v)} label={`Efficiency mode for ${p.title}`} />
          </div>
        ))}
      </div>
    </Glass>
  );
}

// ---- phone ----
const PHONE_STATUS: Record<number, Verdict> = {
  0: { level: 'good', title: 'Your phone is at a normal temperature', text: 'Android reports no heat limits right now.' },
  1: { level: 'info', title: 'Your phone is slightly warm', text: 'This is normal during heavy use or charging.' },
  2: { level: 'warning', title: 'Your phone is warm', text: 'Android may start slowing it down. Close heavy apps and give it a break.' },
  3: { level: 'warning', title: 'Your phone is hot', text: 'Android is slowing it down. Stop charging, close games and video, and take it out of its case.' },
  4: { level: 'warning', title: 'Your phone is very hot', text: 'Stop using it for a while, unplug it, and keep it out of the sun.' },
  5: { level: 'warning', title: 'Your phone is overheating', text: 'Stop using it, unplug it, and let it cool down in the shade.' },
  6: { level: 'warning', title: 'Your phone is overheating', text: 'Android is about to shut it down to protect it. Let it cool down.' },
};

export function PhoneCooling() {
  const live = useLive();
  const open = (screen: string) => void bridge.android?.openSystemScreen(screen);
  const status = live?.thermalStatus != null ? PHONE_STATUS[live.thermalStatus] : null;
  const shortcuts = [
    { icon: Zap, title: 'Battery saver', sub: 'Limits background work and speed', screen: 'batterySaver' },
    { icon: Gauge, title: 'Battery use by app', sub: "Find what's been working hardest", screen: 'batteryUsage' },
    { icon: Sun, title: 'Display', sub: 'Lower the brightness or refresh rate', screen: 'display' },
  ];
  return (
    <>
      {status && <VerdictNotice v={status} />}
      <Glass className="card">
        <div className="row" style={{ gap: 10 }}>
          <Smartphone size={17} className="dim" />
          <h2 className="section-title">Cool your phone</h2>
        </div>
        <p className="section-sub">Android doesn't let apps control the processor, so these are the settings that help most.</p>
        <div className="list" style={{ marginTop: 6 }}>
          {shortcuts.map((s) => (
            <button className="list-row" key={s.screen} onClick={() => open(s.screen)}>
              <s.icon size={18} className="dim" style={{ flex: 'none' }} />
              <div className="grow">
                <div className="row-title">{s.title}</div>
                <div className="row-sub">{s.sub}</div>
              </div>
              <ChevronRight size={16} className="row-chev" />
            </button>
          ))}
        </div>
        <ul className="bullets" style={{ marginTop: 12 }}>
          <li>Avoid gaming or video calls while charging.</li>
          <li>Take off a thick case when the phone feels hot.</li>
          <li>Keep it out of direct sun and off soft surfaces like beds.</li>
        </ul>
      </Glass>
    </>
  );
}

// ---- graphics card ----
export function GpuDiagnosis({ gpu }: { gpu: GpuSample }) {
  const t = gpu.tempC;
  if (t == null) return null;
  const load = gpu.load ?? 0;
  const gap = gpu.hotspotC != null ? gpu.hotspotC - t : 0;
  const name = gpu.name;
  let v: Verdict;
  if (t >= 85) {
    v = { level: 'warning', title: `${name} is running hot`, text: `${Math.round(t)}°C at ${Math.round(load)}% load. Try Cool mode, cap the frame rate in your game, or raise the fan speed.` };
  } else if (gap >= 25) {
    v = { level: 'warning', title: 'Large gap between the hot spot and the average', text: `The hot spot is ${Math.round(gap)}°C above the average. Under load, this may mean the thermal paste is drying out.` };
  } else if (load < 15 && t >= 65) {
    v = { level: 'warning', title: `Hot for how little it's doing`, text: `${Math.round(t)}°C at ${Math.round(load)}% load. Dust in the fans may be the cause.` };
  } else {
    v = { level: 'good', title: `${name} temperature looks normal`, text: `${Math.round(t)}°C at ${Math.round(load)}% load.` };
  }
  return <VerdictNotice v={v} />;
}

// Without a power limit to read back, the chosen mode is only remembered while the app is open.
const clockModes = new Map<number, string>();

export function GpuCooling({ gpu, elevated, onChanged }: { gpu: NvidiaGpu; elevated: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [, redraw] = useState(0);
  const canPower = gpu.minW != null && gpu.maxW != null && gpu.defaultW != null && gpu.powerW != null && gpu.maxW > gpu.minW;
  const coolW = canPower ? Math.max(gpu.minW!, Math.round(gpu.defaultW! * 0.75)) : 0;
  const near = (a: number, b: number) => Math.abs(a - b) < 1;
  const mode = canPower ? (near(gpu.powerW!, gpu.defaultW!) ? 'balanced' : near(gpu.powerW!, coolW) ? 'cool' : near(gpu.powerW!, gpu.maxW!) ? 'performance' : 'custom') : (clockModes.get(gpu.index) ?? 'balanced');
  const canClock = gpu.maxClockMHz != null && gpu.maxClockMHz > 300;
  if (!canPower && !canClock) return null;

  const choose = async (next: string) => {
    setBusy(true);
    try {
      const win = bridge.win!;
      if (canPower) {
        await win.gpuPowerLimit(gpu.index, next === 'cool' ? coolW : next === 'performance' ? gpu.maxW! : gpu.defaultW!);
      } else if (next === 'cool') {
        await win.gpuClockLimit(gpu.index, Math.round(gpu.maxClockMHz! * 0.8));
      } else {
        await win.gpuClockReset(gpu.index);
      }
      clockModes.set(gpu.index, next);
      redraw((x) => x + 1);
      toast(next === 'cool' ? 'Cool mode is on.' : next === 'performance' ? 'Maximum performance is on.' : 'Back to default limits.');
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'warning');
    }
    setBusy(false);
  };

  return (
    <Glass className="card">
      <div className="row between wrap" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10 }}>
          <Snowflake size={17} className="dim" />
          <h2 className="section-title">{gpu.name} cooling</h2>
        </div>
        <Segmented
          label={`${gpu.name} mode`}
          disabled={busy || !elevated}
          value={mode}
          options={[
            { value: 'cool', label: 'Cool' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'performance', label: 'Maximum performance' },
          ]}
          onChange={(v) => void choose(v)}
        />
      </div>
      <p className="section-sub" style={{ marginTop: 8 }}>
        {canPower
          ? `Cool limits the card to ${coolW} W, for less heat and noise at some cost to frame rate. Maximum performance allows the ${Math.round(gpu.maxW!)} W this card supports, which is hotter and louder. It isn't overclocking. Windows resets this when you restart.`
          : "This card's power limit can't be changed, so Cool lowers its top speed instead. Windows resets this when you restart."}
      </p>
      {!elevated && (
        <div className="row between" style={{ marginTop: 10 }}>
          <span className="section-sub">Changing this needs full mode.</span>
          <button className="btn sm" onClick={() => requestElevation()}>
            Full mode
          </button>
        </div>
      )}
    </Glass>
  );
}

export function GpuApps() {
  const live = useLive();
  const [apps, setApps] = useState<GpuAppUse[]>([]);

  useEffect(() => {
    let gone = false;
    const read = () => {
      if (document.hidden) return;
      void bridge.win!.gpuApps().then((r) => {
        if (!gone) setApps(r);
      }, () => {});
    };
    read();
    const timer = window.setInterval(read, 6000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, []);

  const rows = apps.map((a) => {
    const p = live?.processes.find((x) => x.pids.includes(a.pid));
    return { ...a, title: p?.title ?? a.name, path: p?.path, icon: p?.icon };
  });

  return (
    <Glass className="card">
      <h2 className="section-title">What's heating the graphics card</h2>
      <p className="section-sub">{rows[0] && rows[0].percent >= 15 ? `${rows[0].title} is using ${Math.round(rows[0].percent)}% of the graphics card right now.` : 'Nothing is working the graphics card hard right now.'}</p>
      {rows.length > 0 && (
        <div className="list" style={{ marginTop: 6 }}>
          {rows.map((r) => (
            <div className="list-row" key={r.pid}>
              <AppIcon title={r.title} path={r.path} icon={r.icon} />
              <div className="grow row-title">{r.title}</div>
              <span className="small dim num">{Math.round(r.percent)}%</span>
            </div>
          ))}
        </div>
      )}
    </Glass>
  );
}
