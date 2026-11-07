import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Gauge, Layers, Sparkles, Zap } from 'lucide-react';
import type { Route } from '../App';
import { bridge } from '../lib/bridge';
import { clamp, ghz, int } from '../lib/format';
import { loadData, useData, useLive, useSystem } from '../lib/store';
import type { GpuInfo, GpuSample, NvidiaGpu } from '../lib/types';
import { AppIcon, Bar, Glass, PageHead, Segmented, Slider, Stat, Switch, toast } from '../ui/kit';
import { Liquid } from '../ui/Liquid';
import { GpuApps, GpuCooling, GpuDiagnosis } from './Cooling';
import { FanPanel } from './Fans';
import { PALETTE } from './Home';
import { requestElevation } from './Sheets';

const VENDOR = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };

function GpuCard({ gpu }: { gpu: GpuSample }) {
  const load = gpu.load ?? 0;
  const palette = load >= 92 ? PALETTE.hot : load >= 82 ? PALETTE.warm : PALETTE.cpu;
  const vramPct = gpu.vramUsedMB != null && gpu.vramTotalMB ? (gpu.vramUsedMB / gpu.vramTotalMB) * 100 : null;
  return (
    <Glass className="card gpu-card">
      <Glass className="tile gpu-tile">
        <Liquid layers={[{ value: clamp(load / 100), color: palette }]} energy={load / 100} bubbles />
        <div className="tile-shine" />
        <div className="tile-top">
          <span>Load</span>
          <Gauge size={16} />
        </div>
        <div className="tile-bottom">
          <div className="tile-value">
            {gpu.load != null ? Math.round(gpu.load) : '—'}
            <small>%</small>
          </div>
        </div>
      </Glass>
      <div className="grow">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <h2 className="section-title">{gpu.name}</h2>
          <span className="badge">{VENDOR[gpu.vendor]}</span>
        </div>
        <div className="stat-grid" style={{ marginTop: 14 }}>
          {gpu.tempC != null && <Stat value={`${Math.round(gpu.tempC)}°C`} label="Temperature" />}
          {gpu.hotspotC != null && <Stat value={`${Math.round(gpu.hotspotC)}°C`} label="Hot spot" />}
          {gpu.coreMHz != null && <Stat value={gpu.coreMHz >= 1000 ? ghz(gpu.coreMHz) : `${int(gpu.coreMHz)} MHz`} label="Core clock" />}
          {gpu.memMHz != null && <Stat value={gpu.memMHz >= 1000 ? ghz(gpu.memMHz) : `${int(gpu.memMHz)} MHz`} label="Memory clock" />}
          {gpu.watts != null && <Stat value={`${gpu.watts.toLocaleString('en-US', { maximumFractionDigits: 1 })} W`} label="Power draw" />}
        </div>
        {gpu.vramUsedMB != null && (
          <div style={{ marginTop: 14 }}>
            <div className="row between small">
              <span className="dim">Video memory</span>
              <span className="num" style={{ fontWeight: 560 }}>
                {gpu.vramUsedMB >= 1024 ? `${(gpu.vramUsedMB / 1024).toFixed(1)} GB` : `${int(gpu.vramUsedMB)} MB`}
                {gpu.vramTotalMB ? ` of ${(gpu.vramTotalMB / 1024).toFixed(gpu.vramTotalMB % 1024 ? 1 : 0)} GB` : ''}
              </span>
            </div>
            {vramPct != null && <Bar value={vramPct} />}
          </div>
        )}
      </div>
    </Glass>
  );
}

function NvidiaTuning({ gpu, elevated, onChanged }: { gpu: NvidiaGpu; elevated: boolean; onChanged: () => void }) {
  const [power, setPower] = useState(gpu.powerW ?? 0);
  const [clock, setClock] = useState(gpu.maxClockMHz ?? 0);
  const [busy, setBusy] = useState(false);
  const canPower = gpu.minW != null && gpu.maxW != null && gpu.powerW != null && gpu.maxW > gpu.minW;
  const canClock = gpu.maxClockMHz != null && gpu.maxClockMHz > 300;

  useEffect(() => {
    if (gpu.powerW != null) setPower(gpu.powerW);
  }, [gpu.powerW]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'warning');
    }
    setBusy(false);
  };

  return (
    <Glass className="card">
      <div className="row" style={{ gap: 10 }}>
        <Zap size={17} className="dim" />
        <div>
          <h2 className="section-title">{gpu.name} limits</h2>
          <p className="section-sub">Lower limits mean less heat and noise, at some cost to performance. Windows resets them on restart.</p>
        </div>
      </div>
      {!elevated && (
        <div className="row between" style={{ marginTop: 10 }}>
          <span className="section-sub">Changing limits needs full mode.</span>
          <button className="btn sm" onClick={() => requestElevation()}>
            Full mode
          </button>
        </div>
      )}
      {canPower ? (
        <div className="tune">
          <div className="row between small">
            <span className="row-title">Power limit</span>
            <span className="num" style={{ fontWeight: 560 }}>
              {Math.round(power)} W <span className="muted">of {Math.round(gpu.maxW!)} W max</span>
            </span>
          </div>
          <Slider value={power} min={gpu.minW!} max={gpu.maxW!} onChange={setPower} disabled={!elevated || busy} label="Power limit" />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            {gpu.defaultW != null && (
              <button className="btn sm" disabled={!elevated || busy} onClick={() => act(() => bridge.win!.gpuPowerLimit(gpu.index, gpu.defaultW!), 'Power limit back to default.')}>
                Default ({Math.round(gpu.defaultW)} W)
              </button>
            )}
            <button className="btn sm primary" disabled={!elevated || busy || power === gpu.powerW} onClick={() => act(() => bridge.win!.gpuPowerLimit(gpu.index, power), `Power limit set to ${Math.round(power)} W.`)}>
              Apply
            </button>
          </div>
        </div>
      ) : (
        <p className="section-sub" style={{ marginTop: 12 }}>
          This card or its driver doesn't allow changing the power limit. That's common on laptops.
        </p>
      )}
      {canClock && (
        <div className="tune">
          <div className="row between small">
            <span className="row-title">Maximum core clock</span>
            <span className="num" style={{ fontWeight: 560 }}>
              {int(clock)} MHz
            </span>
          </div>
          <Slider value={clock} min={300} max={gpu.maxClockMHz!} step={15} onChange={setClock} disabled={!elevated || busy} label="Maximum core clock" />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn sm" disabled={!elevated || busy} onClick={() => act(() => bridge.win!.gpuClockReset(gpu.index), 'Clock limit removed.')}>
              Remove limit
            </button>
            <button className="btn sm primary" disabled={!elevated || busy} onClick={() => act(() => bridge.win!.gpuClockLimit(gpu.index, clock), `Core clock limited to ${int(clock)} MHz.`)}>
              Apply
            </button>
          </div>
        </div>
      )}
    </Glass>
  );
}

const PREF_OPTIONS = [
  { value: '0', label: 'Auto' },
  { value: '1', label: 'Power saving' },
  { value: '2', label: 'Performance' },
];

function AppPreferences({ info }: { info: GpuInfo }) {
  const live = useLive();
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const refresh = () => void loadData('gpuInfo', () => bridge.win!.gpuInfo());

  // Saved preferences first, then whatever is running from outside the Windows folder.
  const rows = useMemo(() => {
    const out: { path: string; title: string; pref: number }[] = info.prefs.filter((p) => p.exists).map((p) => ({ path: p.path, title: p.name, pref: p.pref }));
    const seen = new Set(out.map((r) => r.path.toLowerCase()));
    for (const p of [...(live?.processes ?? [])].sort((a, b) => b.mem - a.mem)) {
      if (!p.path || p.critical || /\\windows\\/i.test(p.path) || seen.has(p.path.toLowerCase())) continue;
      seen.add(p.path.toLowerCase());
      out.push({ path: p.path, title: p.title, pref: 0 });
      if (out.length >= 10) break;
    }
    return out;
    // The list stays put while the user is choosing; it refreshes when the saved prefs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.prefs, !!live]);

  const choose = (path: string, pref: number) => {
    setOverrides((o) => ({ ...o, [path]: pref }));
    bridge.win
      ?.gpuPrefSet(path, pref)
      .then(refresh)
      .catch((e: Error) => {
        toast(e.message, 'warning');
        setOverrides((o) => {
          const next = { ...o };
          delete next[path];
          return next;
        });
      });
  };

  return (
    <Glass className="card">
      <div className="row" style={{ gap: 10 }}>
        <Layers size={17} className="dim" />
        <div>
          <h2 className="section-title">Which graphics chip each app uses</h2>
          <p className="section-sub">Matters on PCs with two graphics chips. Takes effect the next time the app starts.</p>
        </div>
      </div>
      <div className="list" style={{ marginTop: 6 }}>
        {rows.map((r) => (
          <div className="list-row" key={r.path}>
            <AppIcon title={r.title} path={r.path} />
            <div className="grow row-title" title={r.path}>
              {r.title}
            </div>
            <Segmented label={`Graphics preference for ${r.title}`} value={String(overrides[r.path] ?? r.pref)} options={PREF_OPTIONS} onChange={(v) => choose(r.path, Number(v))} />
          </div>
        ))}
        {rows.length === 0 && <p className="section-sub">Open an app and it will appear here.</p>}
      </div>
    </Glass>
  );
}

export function Graphics({ nav }: { nav: (r: Route) => void }) {
  const live = useLive();
  const system = useSystem();
  const info = useData<GpuInfo>('gpuInfo', () => bridge.win!.gpuInfo(), 8000);
  const reload = () => void loadData('gpuInfo', () => bridge.win!.gpuInfo());
  const gpus = live?.gpus ?? [];
  const elevated = info.data?.elevated ?? false;
  const nvidia = info.data?.nvidia ?? [];
  const hags = info.data?.hags;
  const hasAmd = gpus.some((g) => g.vendor === 'amd');
  const onlyIntel = gpus.length > 0 && gpus.every((g) => g.vendor === 'intel');

  const toggleHags = (on: boolean) => {
    bridge.win
      ?.hagsSet(on)
      .then(() => {
        toast('Saved. It takes effect after you restart Windows.', 'info');
        reload();
      })
      .catch((e: Error) => toast(e.message, 'warning'));
  };

  return (
    <div className="stack">
      <PageHead title="Graphics" subtitle="Live data and settings for your graphics hardware." />

      {gpus.map((g) => (
        <GpuCard key={g.id} gpu={g} />
      ))}
      {gpus.length === 0 && (
        <Glass className="card">
          <h2 className="section-title">{system?.gpus.join(', ') || 'Graphics'}</h2>
          <p className="section-sub">Reading the sensors…</p>
        </Glass>
      )}

      {gpus.map((g) => (
        <GpuDiagnosis key={g.id} gpu={g} />
      ))}
      {nvidia.map((g) => (
        <GpuCooling key={g.index} gpu={g} elevated={elevated} onChanged={reload} />
      ))}

      <FanPanel group="gpu" />
      <GpuApps />

      {nvidia.map((g) => (
        <NvidiaTuning key={g.index} gpu={g} elevated={elevated} onChanged={reload} />
      ))}
      {hasAmd && nvidia.length === 0 && (
        <Glass className="notice">
          <div className="notice-icon">
            <Zap size={17} />
          </div>
          <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
            Power and clock limits on AMD cards are set through AMD Software: Adrenalin Edition, the only tool AMD provides for them. G Ultra shows the live data and controls the fans.
          </div>
        </Glass>
      )}
      {onlyIntel && (
        <Glass className="notice">
          <div className="notice-icon">
            <Zap size={17} />
          </div>
          <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
            Intel integrated graphics share power and cooling with the processor, so they have no separate power limit or fans to set.
          </div>
        </Glass>
      )}

      {info.data && <AppPreferences info={info.data} />}

      <Glass className="card">
        <h2 className="section-title">Windows graphics settings</h2>
        <div className="list" style={{ marginTop: 6 }}>
          {hags && (
            <div className="list-row">
              <div className="grow">
                <div className="row-title">Hardware-accelerated GPU scheduling</div>
                <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                  Lets the graphics card manage its own memory, which can reduce latency. Needs a supported card and a restart.
                  {!elevated ? ' Changing it needs full mode.' : ''}
                </div>
              </div>
              <Switch checked={hags.state === 'on'} disabled={!hags.canSet} onChange={toggleHags} label="Hardware-accelerated GPU scheduling" />
            </div>
          )}
          <button className="list-row" onClick={() => nav('clean')}>
            <Sparkles size={18} className="dim" style={{ flex: 'none' }} />
            <div className="grow">
              <div className="row-title">Clear the shader cache</div>
              <div className="row-sub">It's listed in Cleanup, under Windows</div>
            </div>
            <ChevronRight size={16} className="row-chev" />
          </button>
        </div>
      </Glass>
    </div>
  );
}
