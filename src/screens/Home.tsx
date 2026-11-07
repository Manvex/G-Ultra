import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Cpu, HardDrive, Info, MemoryStick, Settings, Sparkles, Thermometer, Wand2 } from 'lucide-react';
import type { Route } from '../App';
import { bridge } from '../lib/bridge';
import { bytes, bytesParts, clamp, duration, ghz, minutesText, shortDevice, tempState } from '../lib/format';
import { cpuTemp, hottestReal, store, useData, useLive, useSystem } from '../lib/store';
import type { DisksInfo, HealthData, Live, ProcessItem } from '../lib/types';
import { AppIcon, Bar, Glass, Ring, Segmented, openSheet } from '../ui/kit';
import { Liquid } from '../ui/Liquid';
import { OptimizeSheet, SettingsSheet, confirmEndProcess } from './Sheets';

export const PALETTE = {
  cpu: ['rgba(82,170,255,.92)', 'rgba(16,62,178,.86)'] as [string, string],
  mem: ['rgba(164,126,255,.92)', 'rgba(70,38,178,.86)'] as [string, string],
  disk: ['rgba(64,214,200,.88)', 'rgba(6,96,120,.86)'] as [string, string],
  good: ['rgba(70,216,140,.88)', 'rgba(8,110,92,.86)'] as [string, string],
  warm: ['rgba(255,178,64,.92)', 'rgba(176,84,10,.88)'] as [string, string],
  hot: ['rgba(255,104,88,.94)', 'rgba(164,24,30,.9)'] as [string, string],
};

function stressColor(pct: number, normal: [string, string]): [string, string] {
  if (pct >= 92) return PALETTE.hot;
  if (pct >= 82) return PALETTE.warm;
  return normal;
}

interface Attention {
  id: string;
  title: string;
  chip: string;
  level: 'critical' | 'warning' | 'info';
  route: Route;
}

function buildAttention(live: Live | null, disks: DisksInfo | undefined, health: HealthData | undefined): Attention[] {
  const out: Attention[] = [];
  if (live) {
    const hot = cpuTemp(live.sensors);
    if (hot != null && hot >= 90) out.push({ id: 'hot', title: 'Your CPU is running hot.', chip: `CPU ${Math.round(hot)}°`, level: 'critical', route: 'thermal' });
    else if (hot != null && hot >= 80) out.push({ id: 'warm', title: 'Your CPU is warming up.', chip: `CPU ${Math.round(hot)}°`, level: 'warning', route: 'thermal' });
    if (live.throttling) out.push({ id: 'throttle', title: 'Your CPU is slowing down from heat.', chip: 'Thermal throttling', level: 'warning', route: 'thermal' });
    if (live.thermalStatus != null && live.thermalStatus >= 3) out.push({ id: 'th', title: 'Your phone is too hot.', chip: 'Thermal limit', level: 'critical', route: 'thermal' });
    if (live.mem.load >= 92) out.push({ id: 'mem', title: 'Memory is almost full.', chip: `RAM ${live.mem.load}%`, level: 'critical', route: 'memory' });
    else if (live.mem.load >= 82) out.push({ id: 'mem', title: 'Memory is filling up.', chip: `RAM ${live.mem.load}%`, level: 'warning', route: 'memory' });
  }
  for (const v of disks?.volumes ?? []) {
    if (v.removable) continue;
    const pctFree = (v.free / v.total) * 100;
    const name = v.letter || 'Storage';
    if (pctFree < 5) out.push({ id: `v${v.letter}`, title: `Drive ${name} is almost full.`.replace('Drive Storage', 'Storage'), chip: `${name} has ${bytes(v.free)} left`, level: 'critical', route: 'clean' });
    else if (pctFree < 12) out.push({ id: `v${v.letter}`, title: `Running low on space on ${name}.`, chip: `${name} has ${bytes(v.free)} left`, level: 'warning', route: 'clean' });
  }
  for (const d of health?.disks ?? []) {
    if (d.smart?.criticalWarning) out.push({ id: `d${d.index}`, title: 'Your SSD is reporting a problem.', chip: 'SSD warning', level: 'critical', route: 'health' });
    else if ((d.smart?.percentUsed ?? 0) >= 80) out.push({ id: `d${d.index}`, title: 'Your SSD is nearing the end of its life.', chip: `SSD ${d.smart!.percentUsed}% worn`, level: 'warning', route: 'health' });
  }
  const b = health?.battery;
  if (b?.healthPct != null && b.healthPct < 80) out.push({ id: 'bat', title: 'Your battery has lost capacity.', chip: `Battery ${Math.round(b.healthPct)}% health`, level: 'info', route: 'health' });
  return out;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function ProcessList({ live }: { live: Live }) {
  const [sort, setSort] = useState<'mem' | 'cpu'>('mem');
  const isAndroid = bridge.platform === 'android';
  const list = useMemo(() => {
    const items = [...live.processes];
    if (isAndroid) return items.sort((a, b) => (b.usageMs ?? 0) - (a.usageMs ?? 0)).slice(0, 5);
    return items.sort((a, b) => (sort === 'mem' ? b.mem - a.mem : b.cpu - a.cpu)).slice(0, 5);
  }, [live, sort, isAndroid]);
  const max = Math.max(1, ...list.map((p) => (isAndroid ? p.usageMs ?? 0 : sort === 'mem' ? p.mem : p.cpu)));

  return (
    <Glass className="card">
      <div className="row between">
        <div>
          <h2 className="section-title">{isAndroid ? 'Recently used' : 'Using the most right now'}</h2>
          {isAndroid && <p className="section-sub">Screen time over the last 3 hours</p>}
        </div>
        {!isAndroid && (
          <Segmented
            label="Sort by"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'mem', label: 'RAM' },
              { value: 'cpu', label: 'CPU' },
            ]}
          />
        )}
      </div>
      <div className="list" style={{ marginTop: 6 }}>
        {list.length === 0 && <AndroidUsagePrompt />}
        {list.map((p) => (
          <ProcessRow key={p.key} p={p} sort={sort} max={max} />
        ))}
      </div>
    </Glass>
  );
}

function AndroidUsagePrompt() {
  return (
    <div className="empty-state" style={{ padding: '18px 8px' }}>
      <p style={{ margin: '0 0 10px' }}>To see which apps you use most, G Ultra needs usage access.</p>
      <button className="btn sm" onClick={() => bridge.android?.requestUsageAccess()}>
        Grant access
      </button>
    </div>
  );
}

export function ProcessRow({ p, sort, max }: { p: ProcessItem; sort: 'mem' | 'cpu'; max: number }) {
  const isAndroid = bridge.platform === 'android';
  const metric = isAndroid ? p.usageMs ?? 0 : sort === 'mem' ? p.mem : p.cpu;
  const value = isAndroid ? minutesText(p.usageMs ?? 0) : sort === 'mem' ? bytes(p.mem) : `${p.cpu.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  return (
    <div className="list-row">
      <AppIcon title={p.title} path={p.path} icon={p.icon} />
      <div className="grow">
        <div className="row between" style={{ gap: 8 }}>
          <div className="row-title">{p.title}</div>
          <div className="row-value">{value}</div>
        </div>
        <Bar value={(metric / max) * 100} />
      </div>
      {isAndroid ? (
        <button className="btn sm" onClick={() => bridge.android?.openAppInfo(p.key)}>
          Details
        </button>
      ) : p.critical ? (
        <span className="badge" title="System process, protected">
          system
        </span>
      ) : (
        <button className="btn sm danger hover-action" onClick={() => confirmEndProcess(p)} aria-label={`Close ${p.title}`}>
          Close
        </button>
      )}
    </div>
  );
}

function hottestLabel(live: Live) {
  const real = live.sensors.filter((s) => !s.approximate && s.celsius != null);
  const s = real.reduce((a, b) => ((b.celsius ?? 0) > (a.celsius ?? 0) ? b : a), real[0]);
  if (!s) return 'No sensor';
  if (s.group === 'storage') return 'SSD';
  if (s.group === 'battery') return 'Battery';
  if (s.group === 'gpu') return 'Graphics';
  return s.name;
}

export function Home({ nav }: { nav: (r: Route) => void }) {
  const live = useLive();
  const system = useSystem();
  const disks = useData('disks', () => bridge.disks(), 30000);
  const health = useData('health', () => bridge.health(), 120000);
  const attention = buildAttention(live, disks.data, health.data);
  const top = attention[0];
  const isAndroid = bridge.platform === 'android';

  const sys = disks.data?.volumes.find((v) => v.system) ?? disks.data?.volumes[0];
  const sysUsed = sys ? ((sys.total - sys.free) / sys.total) * 100 : 0;
  const mem = live?.mem;
  const memParts = bytesParts(mem?.used);

  const cpuT = live ? cpuTemp(live.sensors) : null;
  const hottest = live ? hottestReal(live.sensors) : null;
  const shownTemp = cpuT ?? hottest;
  const tState = tempState(shownTemp);
  const tempPalette = tState.key === 'hot' ? PALETTE.hot : tState.key === 'warm' ? PALETTE.warm : PALETTE.good;
  const tempSource = cpuT != null ? 'CPU' : hottest != null ? hottestLabel(live!) : 'No sensor';
  const energy = store.energy;

  const ssd = health.data?.disks.find((d) => d.smart?.percentUsed != null);
  const ssdLife = ssd?.smart?.percentUsed != null ? 100 - ssd.smart.percentUsed : null;
  const battery = health.data?.battery;

  return (
    <div className="stack">
      <Glass className="hero">
        <div className="grow">
          <div className="kicker">{greeting()}</div>
          <h1 className="hero-title">{top ? top.title : 'Everything is running well.'}</h1>
          <div className="hero-meta">
            {system ? `${shortDevice(system.deviceName)} · ${system.osName}` : ' '}
            {system && !isAndroid && ` · up for ${duration(system.uptimeSec)}`}
          </div>
          {attention.length > 0 && (
            <div className="chips">
              {attention.map((a) => (
                <button key={a.id} className="chip" onClick={() => nav(a.route)}>
                  {a.level === 'info' ? <Info size={14} color="var(--info)" /> : <AlertTriangle size={14} color={a.level === 'critical' ? 'var(--critical)' : 'var(--warning)'} />}
                  {a.chip}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="row" style={{ flex: 'none' }}>
          {isAndroid && (
            <button className="btn icon lg" style={{ width: 46 }} onClick={() => openSheet((close) => <SettingsSheet close={close} />)} aria-label="Settings">
              <Settings size={18} />
            </button>
          )}
          <button className="btn primary lg" style={isAndroid ? { flex: 1 } : undefined} onClick={() => openSheet((close) => <OptimizeSheet close={close} />)}>
            <Wand2 size={17} />
            Optimize
          </button>
        </div>
      </Glass>

      <div className="grid-4">
        <Glass as="button" className="tile" onClick={() => nav('thermal')} aria-label="Processor, open Thermals">
          <Liquid layers={[{ value: (live?.cpu.usage ?? 0) / 100, color: stressColor(live?.cpu.usage ?? 0, PALETTE.cpu) }]} energy={energy} bubbles />
          <div className="tile-shine" />
          <div className="tile-top">
            <span>Processor</span>
            <Cpu size={16} />
          </div>
          <div className="tile-bottom">
            <div className="tile-value">
              {live?.cpu.usage != null ? Math.round(live.cpu.usage) : '—'}
              <small>%</small>
            </div>
            <div className="tile-sub">{live?.cpu.usageIsFrequency ? 'of top frequency' : live?.cpu.freqMHz ? ghz(live.cpu.freqMHz) : ' '}</div>
          </div>
        </Glass>

        <Glass as="button" className="tile" onClick={() => nav('memory')} aria-label="Memory, open screen">
          <Liquid layers={[{ value: (mem?.load ?? 0) / 100, color: stressColor(mem?.load ?? 0, PALETTE.mem) }]} energy={0.18} />
          <div className="tile-shine" />
          <div className="tile-top">
            <span>Memory</span>
            <MemoryStick size={16} />
          </div>
          <div className="tile-bottom">
            <div className="tile-value">
              {memParts.value}
              <small>{memParts.unit}</small>
            </div>
            <div className="tile-sub">{mem ? `of ${bytes(mem.total)} · ${mem.load}%` : ' '}</div>
          </div>
        </Glass>

        <Glass as="button" className="tile" onClick={() => nav('storage')} aria-label="Storage, open screen">
          <Liquid layers={[{ value: sysUsed / 100, color: stressColor(sysUsed, PALETTE.disk) }]} energy={0.1} />
          <div className="tile-shine" />
          <div className="tile-top">
            <span>Storage{sys?.letter ? ` ${sys.letter}` : ''}</span>
            <HardDrive size={16} />
          </div>
          <div className="tile-bottom">
            <div className="tile-value">
              {sys ? bytesParts(sys.free).value : '—'}
              <small>{sys ? bytesParts(sys.free).unit : ''}</small>
            </div>
            <div className="tile-sub">{sys ? `free of ${bytes(sys.total)}` : ' '}</div>
          </div>
        </Glass>

        <Glass as="button" className="tile" onClick={() => nav('thermal')} aria-label="Temperature, open Thermals">
          <Liquid layers={[{ value: shownTemp != null ? clamp((shownTemp - 15) / 85) : 0, color: tempPalette }]} energy={0.14} />
          <div className="tile-shine" />
          <div className="tile-top">
            <span>Temperature</span>
            <Thermometer size={16} />
          </div>
          <div className="tile-bottom">
            <div className="tile-value">
              {shownTemp != null ? Math.round(shownTemp) : '—'}
              <small>°C</small>
            </div>
            <div className="tile-sub">
              {tempSource}
              {shownTemp != null ? ` · ${tState.label}` : ''}
            </div>
          </div>
        </Glass>
      </div>

      <div className="grid-mem">
        {live && <ProcessList live={live} />}
        <Glass className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <h2 className="section-title">Wear</h2>
          <div className="list" style={{ marginTop: 6, flex: 1 }}>
            {ssdLife != null && (
              <button className="list-row" onClick={() => nav('health')}>
                <Ring value={ssdLife} size={52} stroke={5} color={ssdLife < 20 ? 'var(--critical)' : ssdLife < 50 ? 'var(--warning)' : 'var(--good)'}>
                  <span className="num" style={{ fontSize: 13, fontWeight: 620 }}>
                    {ssdLife}
                  </span>
                </Ring>
                <div className="grow">
                  <div className="row-title">SSD life left</div>
                  <div className="row-sub">{ssd!.model}</div>
                </div>
                <ChevronRight size={16} className="row-chev" />
              </button>
            )}
            {battery?.healthPct != null && (
              <button className="list-row" onClick={() => nav('health')}>
                <Ring value={battery.healthPct} size={52} stroke={5} color={battery.healthPct < 60 ? 'var(--critical)' : battery.healthPct < 80 ? 'var(--warning)' : 'var(--good)'}>
                  <span className="num" style={{ fontSize: 13, fontWeight: 620 }}>
                    {Math.round(battery.healthPct)}
                  </span>
                </Ring>
                <div className="grow">
                  <div className="row-title">Battery health</div>
                  <div className="row-sub">{battery.cycles != null ? `${battery.cycles} cycles` : battery.chemistry ?? ''}</div>
                </div>
                <ChevronRight size={16} className="row-chev" />
              </button>
            )}
            {ssdLife == null && battery?.healthPct == null && (
              <p className="dim" style={{ margin: '10px 0' }}>
                {health.loading ? 'Reading component status…' : "This device doesn't report wear data."}
              </p>
            )}
            <button className="list-row" onClick={() => nav('clean')}>
              <div className="ring" style={{ width: 52, height: 52 }}>
                <Sparkles size={22} color="var(--info)" />
              </div>
              <div className="grow">
                <div className="row-title">Cleanup</div>
                <div className="row-sub">See how much space you can recover</div>
              </div>
              <ChevronRight size={16} className="row-chev" />
            </button>
          </div>
        </Glass>
      </div>
    </div>
  );
}
