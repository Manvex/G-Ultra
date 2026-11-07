import { useMemo, useState } from 'react';
import { Check, Download, Flame, Info, Loader2, ShieldCheck, Thermometer } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { clamp, ghz, tempState } from '../lib/format';
import { cpuTemp, hottestReal, store, useLive, useSystem } from '../lib/store';
import { tasks } from '../lib/tasks';
import type { Sensor, SensorGroup } from '../lib/types';
import { ChartLegend, LineChart, Sparkline, type Series } from '../ui/charts';
import { Glass, PageHead, toast } from '../ui/kit';
import { Liquid } from '../ui/Liquid';
import { AppEfficiency, CpuCooling, CpuDiagnosis, OverclockCard, PhoneCooling } from './Cooling';
import { FanPanel } from './Fans';
import { PALETTE, ProcessRow } from './Home';
import { requestElevation } from './Sheets';

const GROUP_LABEL: Record<SensorGroup, string> = {
  cpu: 'Processor',
  gpu: 'Graphics',
  memory: 'RAM',
  storage: 'Storage',
  battery: 'Battery',
  skin: 'Body',
  board: 'Motherboard',
  other: 'Other sensors',
  fan: 'Fans',
};
const GROUP_ORDER: SensorGroup[] = ['cpu', 'gpu', 'memory', 'storage', 'battery', 'skin', 'board', 'other'];
const GROUP_COLOR: Partial<Record<SensorGroup, string>> = { cpu: 'var(--s1)', gpu: 'var(--s2)', storage: 'var(--s3)', battery: 'var(--s4)' };

const THERMAL_STATUS = ['Normal', 'Slightly warm', 'Moderate', 'Severe', 'Critical', 'Emergency', 'Shutting down'];

// The installer sets this up. It only shows if the driver was removed or the app has no admin rights.
function SensorSetup({ hasCpuSensors }: { hasCpuSensors: boolean }) {
  const system = useSystem();
  const [installing, setInstalling] = useState(false);
  const driver = system?.sensorDriver;
  if (!driver || bridge.platform !== 'windows' || hasCpuSensors) return null;
  const needsDriver = !driver.installed;
  const needsAdmin = !driver.elevated;

  const install = async () => {
    setInstalling(true);
    const r = await tasks.run({ id: 'driver', label: 'Installing the sensor driver', route: 'thermal' }, () => bridge.win!.installDriver());
    if (r.ok) {
      await bridge.win!.reloadSensors();
      toast('Sensor driver installed.');
    } else {
      toast("The driver wasn't installed. You can try again.", 'warning');
    }
    await store.refreshSystem();
    setInstalling(false);
  };

  return (
    <Glass className="card">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="notice-icon" style={{ background: 'rgba(100,210,255,.14)' }}>
          <Thermometer size={18} color="var(--info)" />
        </div>
        <div className="grow">
          <h2 className="section-title">Turn on the real CPU temperature</h2>
          <p className="section-sub" style={{ maxWidth: '64ch' }}>
            Windows doesn't give apps this value: the sensor can only be read through a driver. G Ultra uses PawnIO, a signed open-source driver, which also enables fan control.
          </p>
        </div>
      </div>
      <div className="list" style={{ marginTop: 10 }}>
        <div className="list-row">
          {driver.installed ? <Check size={18} color="var(--good)" /> : <Download size={18} />}
          <div className="grow">
            <div className="row-title">PawnIO driver</div>
            <div className="row-sub">{driver.installed ? 'Installed' : 'Included with G Ultra. Windows will ask you to confirm.'}</div>
          </div>
          {!driver.installed && (
            <button className="btn sm" onClick={install} disabled={installing}>
              {installing && <Loader2 size={13} className="spin" />}
              {installing ? 'Installing…' : 'Install'}
            </button>
          )}
        </div>
        <div className="list-row">
          {driver.elevated ? <Check size={18} color="var(--good)" /> : <ShieldCheck size={18} />}
          <div className="grow">
            <div className="row-title">Full mode</div>
            <div className="row-sub">{driver.elevated ? 'On' : 'The driver only works with administrator rights'}</div>
          </div>
          {!driver.elevated && (
            <button className="btn sm" onClick={() => requestElevation()} disabled={needsDriver}>
              Restart
            </button>
          )}
        </div>
        {!needsDriver && !needsAdmin && (
          <div className="list-row">
            <Loader2 size={18} className="spin" />
            <div className="grow">
              <div className="row-title">Looking for sensors</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                {driver.error ? `Error: ${driver.error}` : "If they don't appear in a few seconds, restart G Ultra: the driver loads at startup."}
              </div>
            </div>
          </div>
        )}
      </div>
    </Glass>
  );
}

function SensorRow({ s }: { s: Sensor }) {
  const history = store.history.temps.get(s.id) ?? [];
  const st = tempState(s.celsius);
  return (
    <div className="sensor-row">
      <div style={{ minWidth: 0 }}>
        <div className="row-title">{s.name}</div>
        {s.approximate && <div className="row-sub">Approximate, not the CPU sensor</div>}
      </div>
      <Sparkline values={history} width={70} height={24} />
      <div className="sensor-temp" style={s.approximate ? { color: 'var(--ink-2)' } : undefined}>
        {!s.approximate && <i className="dot" style={{ display: 'inline-block', width: 7, height: 7, margin: '0 6px 2px 0', background: st.color }} aria-label={st.label} />}
        {Math.round(s.celsius!)}°
      </div>
    </div>
  );
}

export function Thermal() {
  const live = useLive();
  const isAndroid = bridge.platform === 'android';
  const temps = (live?.sensors ?? []).filter((s) => s.celsius != null);

  const cpu = cpuTemp(temps);
  const hottest = hottestReal(temps);
  const main = cpu ?? hottest;
  const mainSensor = cpu != null ? null : temps.filter((s) => !s.approximate).sort((a, b) => (b.celsius ?? 0) - (a.celsius ?? 0))[0];
  const st = tempState(main);
  const palette = st.key === 'hot' ? PALETTE.hot : st.key === 'warm' ? PALETTE.warm : PALETTE.good;

  const groups = useMemo(() => {
    const map = new Map<SensorGroup, Sensor[]>();
    for (const s of temps) {
      if (!map.has(s.group)) map.set(s.group, []);
      map.get(s.group)!.push(s);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, list: map.get(g)! }));
    // Recomputed on every new sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.ts]);

  const h = store.history;
  // On the chart: one representative sensor per group, each with a fixed color.
  const series: Series[] = useMemo(() => {
    const out: Series[] = [];
    for (const g of ['cpu', 'gpu', 'storage', 'battery'] as SensorGroup[]) {
      const list = temps.filter((s) => s.group === g && !s.approximate);
      if (!list.length) continue;
      const pick = list.find((s) => /package|hottest core/i.test(s.name)) ?? list[0];
      const values = h.temps.get(pick.id);
      if (values) out.push({ id: pick.id, name: GROUP_LABEL[g], color: GROUP_COLOR[g]!, values: [...values] });
    }
    return out;
    // Recomputed on every new sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.ts]);

  const cpuSeries: Series[] = [{ id: 'cpu', name: 'Load', color: 'var(--s1)', values: [...h.cpu] }];
  const topCpu = useMemo(() => [...(live?.processes ?? [])].sort((a, b) => b.cpu - a.cpu).slice(0, 7), [live]);
  const maxCpu = Math.max(5, ...topCpu.map((p) => p.cpu));
  const heavy = topCpu[0];
  const perCore = live?.cpu.perCore ?? [];

  return (
    <div className="stack">
      <PageHead title="Thermals" subtitle={isAndroid ? 'The sensors your phone exposes and how they change over time.' : 'Every sensor available, your fans, and what is heating up the processor.'} />

      <div className="grid-mem">
        <Glass className="tile" style={{ minHeight: 280 }}>
          <Liquid layers={[{ value: main != null ? clamp((main - 15) / 85) : 0, color: palette }]} energy={store.energy} bubbles />
          <div className="tile-shine" />
          <div className="tile-top">
            <span>{cpu != null ? 'Processor' : mainSensor ? mainSensor.name : 'Temperature'}</span>
            <Flame size={16} />
          </div>
          <div className="tile-bottom">
            <div className="tile-value" style={{ fontSize: 76 }}>
              {main != null ? Math.round(main) : '—'}
              <small style={{ fontSize: 30 }}>°C</small>
            </div>
            <div className="tile-sub" style={{ fontSize: 14, whiteSpace: 'normal' }}>
              {main != null ? st.label : 'No sensor available'}
              {cpu == null && main != null && !isAndroid && ' · CPU temperature is not on yet'}
              {live?.throttling ? ' · the processor is thermally limited' : ''}
              {isAndroid && live?.thermalStatus != null ? ` · system status: ${THERMAL_STATUS[live.thermalStatus] ?? '—'}` : ''}
            </div>
          </div>
        </Glass>

        <Glass className="card">
          <div className="row between wrap">
            <div>
              <h2 className="section-title">Temperature over time</h2>
              <p className="section-sub">Since the app was opened</p>
            </div>
            <ChartLegend series={series} />
          </div>
          <div style={{ marginTop: 10 }}>{series.length > 0 && h.ts.length > 1 ? <LineChart series={series} ts={[...h.ts]} height={206} /> : <div className="empty-state">Collecting data…</div>}</div>
        </Glass>
      </div>

      {!isAndroid && <SensorSetup hasCpuSensors={cpu != null} />}
      {!isAndroid && <CpuDiagnosis />}
      {!isAndroid && <CpuCooling />}
      {!isAndroid && <OverclockCard />}
      {!isAndroid && <FanPanel />}
      {isAndroid && <PhoneCooling />}

      {isAndroid && temps.filter((s) => s.group !== 'battery').length === 0 && (
        <Glass className="notice">
          <div className="notice-icon">
            <Info size={18} />
          </div>
          <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
            Your phone doesn't let apps read the processor sensors (an Android security restriction). You can see the battery and the thermal status reported by the system.
          </div>
        </Glass>
      )}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Glass className="card">
          <h2 className="section-title">All sensors</h2>
          {groups.length === 0 && <p className="dim">No sensors available right now.</p>}
          {groups.map((g) => (
            <div key={g.group} style={{ marginTop: 14 }}>
              <div className="label" style={{ marginBottom: 2 }}>
                {GROUP_LABEL[g.group]}
              </div>
              {g.list.map((s) => (
                <SensorRow key={s.id} s={s} />
              ))}
            </div>
          ))}
          {isAndroid && live?.thermalHeadroom != null && (
            <p className="section-sub" style={{ marginTop: 12 }}>
              Thermal headroom before throttling: {Math.round(Math.max(0, 1 - live.thermalHeadroom) * 100)}%
            </p>
          )}
        </Glass>

        <div className="stack">
          {!isAndroid && (
            <Glass className="card">
              <h2 className="section-title">Processor load</h2>
              <div style={{ marginTop: 10 }}>{h.ts.length > 1 ? <LineChart series={cpuSeries} ts={[...h.ts]} height={130} unit="%" yMin={0} yMax={100} area /> : <div className="empty-state">Collecting data…</div>}</div>
              {perCore.length > 0 && (
                <>
                  <div className="core-strip" role="img" aria-label={`Load per core: ${perCore.map((v) => Math.round(v)).join(', ')} percent`}>
                    {perCore.map((v, i) => (
                      <div key={i} title={`Logical core ${i + 1}: ${Math.round(v)}%`}>
                        <i style={{ height: `${Math.max(2, v)}%`, background: v > 90 ? 'var(--warning)' : 'var(--s1)' }} />
                      </div>
                    ))}
                  </div>
                  <p className="section-sub" style={{ marginTop: 6 }}>
                    {perCore.length} logical cores
                    {live?.cpu.freqMHz ? ` · ${ghz(live.cpu.freqMHz)} now` : ''}
                  </p>
                </>
              )}
            </Glass>
          )}

          {isAndroid ? (
            <Glass className="card">
              <h2 className="section-title">Recently active</h2>
              <p className="section-sub">Android doesn't show CPU use per app. The apps you use most are the likeliest source of heat.</p>
              <div className="list" style={{ marginTop: 6 }}>
                {(live?.processes ?? []).slice(0, 6).map((p) => (
                  <ProcessRow key={p.key} p={p} sort="cpu" max={Math.max(1, ...(live?.processes ?? []).map((x) => x.usageMs ?? 0))} />
                ))}
                {(live?.processes ?? []).length === 0 && (
                  <div className="empty-state" style={{ padding: '14px 0' }}>
                    <button className="btn sm" onClick={() => bridge.android?.requestUsageAccess()}>
                      Grant usage access
                    </button>
                  </div>
                )}
              </div>
              {live?.power?.watts != null && <p className="section-sub">Power draw now: {live.power.watts.toLocaleString('en-US')} W</p>}
            </Glass>
          ) : (
            <Glass className="card">
              <h2 className="section-title">What's heating the processor</h2>
              <p className="section-sub">{heavy && heavy.cpu >= 15 ? `${heavy.title} is using ${Math.round(heavy.cpu)}% of the processor right now.` : 'Nothing is working the processor hard right now.'}</p>
              <div className="list" style={{ marginTop: 6 }}>
                {topCpu.map((p) => (
                  <ProcessRow key={p.key} p={p} sort="cpu" max={maxCpu} />
                ))}
              </div>
            </Glass>
          )}
          {!isAndroid && <AppEfficiency processes={topCpu} />}
        </div>
      </div>
    </div>
  );
}
