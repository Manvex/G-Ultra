import { AlertTriangle, BatteryFull, CheckCircle2, Cpu, HardDrive, Loader2, MemoryStick, ShieldAlert } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes, dec1, hoursText, int, terabytes } from '../lib/format';
import { useData, useLive, useSystem } from '../lib/store';
import type { BatteryHealth, DiskHealth, HealthData } from '../lib/types';
import { Glass, PageHead, Ring, Stat } from '../ui/kit';
import { requestElevation } from './Sheets';

function wearColor(life: number) {
  if (life < 20) return 'var(--critical)';
  if (life < 50) return 'var(--warning)';
  return 'var(--good)';
}

function lifeSentence(life: number) {
  if (life >= 90) return 'Practically new.';
  if (life >= 70) return 'In very good shape.';
  if (life >= 40) return 'Normal wear for its age.';
  if (life >= 15) return 'Advanced wear. Back up regularly.';
  return 'Near the end of its life. Back up now.';
}

function DiskCard({ d }: { d: DiskHealth }) {
  const s = d.smart;
  const life = s?.percentUsed != null ? Math.max(0, 100 - s.percentUsed) : null;
  const problems: string[] = [];
  if (s?.criticalWarning) problems.push('The drive is reporting a critical warning.');
  if (s?.mediaErrors) problems.push(`${int(s.mediaErrors)} data read errors. Back up your files.`);
  if (d.status === 'warning' || d.status === 'bad') problems.push('Windows marks this drive as unhealthy.');

  return (
    <Glass className="card">
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        {life != null ? (
          <Ring value={life} size={104} stroke={9} color={wearColor(life)}>
            <div className="num" style={{ fontSize: 26, fontWeight: 640, letterSpacing: '-0.04em' }}>
              {life}
              <span style={{ fontSize: 14 }}>%</span>
            </div>
            <div className="muted" style={{ fontSize: 10.5 }}>
              life left
            </div>
          </Ring>
        ) : (
          <div className="ring" style={{ width: 104, height: 104 }}>
            <HardDrive size={36} className="dim" />
          </div>
        )}
        <div className="grow">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <h2 className="section-title" style={{ overflowWrap: 'anywhere' }}>
              {d.model}
            </h2>
            {d.letters.length > 0 && <span className="badge">{d.letters.join(' ')}</span>}
          </div>
          <p className="section-sub">{[d.media, d.bus, bytes(d.size)].filter(Boolean).join(' · ')}</p>
          {life != null && <p style={{ margin: '8px 0 0', fontSize: 13.5 }}>{lifeSentence(life)}</p>}
          {problems.map((p) => (
            <p key={p} style={{ margin: '8px 0 0', fontSize: 13, color: '#ff8a82' }}>
              <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
              {p}
            </p>
          ))}
          {!s && d.smartReason === 'admin' && (
            <div style={{ marginTop: 10 }}>
              <p className="section-sub" style={{ marginBottom: 8 }}>
                Wear data for this drive needs full mode.
              </p>
              <button className="btn sm" onClick={() => requestElevation()}>
                <ShieldAlert size={13} /> Full mode
              </button>
            </div>
          )}
          {!s && d.smartReason === 'unsupported' && (
            <p className="section-sub" style={{ marginTop: 8 }}>
              This device doesn't report wear data (SD cards and USB sticks have no SMART).
            </p>
          )}
          {!s && d.smartReason === 'os' && (
            <p className="section-sub" style={{ marginTop: 8 }}>
              Android doesn't let apps read internal storage wear.
            </p>
          )}
        </div>
      </div>
      {s && (
        <div className="stat-grid" style={{ marginTop: 18 }}>
          {s.dataWritten != null && <Stat value={terabytes(s.dataWritten)} label="Total data written" />}
          {s.dataRead != null && <Stat value={terabytes(s.dataRead)} label="Total data read" />}
          {s.powerOnHours != null && s.powerOnHours > 0 && <Stat value={`${int(s.powerOnHours)} hours`} label={`Powered on (${hoursText(s.powerOnHours)})`} />}
          {s.powerCycles != null && s.powerCycles > 0 && <Stat value={int(s.powerCycles)} label="Power cycles" />}
          {s.tempC != null && <Stat value={`${Math.round(s.tempC)}°C`} label="Temperature" />}
          {s.availableSpare != null && <Stat value={`${s.availableSpare}%`} label={`Spare (minimum ${s.spareThreshold ?? '—'}%)`} />}
          {s.unsafeShutdowns != null && <Stat value={int(s.unsafeShutdowns)} label="Unsafe shutdowns" />}
          {s.mediaErrors != null && <Stat value={int(s.mediaErrors)} label="Data errors" />}
        </div>
      )}
    </Glass>
  );
}

function BatteryCard({ b, live }: { b: BatteryHealth; live: ReturnType<typeof useLive> }) {
  const health = b.healthPct;
  const wear = health != null ? Math.max(0, 100 - health) : null;
  const unit = b.unit === 'mAh' ? 'mAh' : 'Wh';
  const fmt = (v: number | null) => (v == null ? '—' : unit === 'Wh' ? `${dec1(v / 1000)} Wh` : `${int(v)} mAh`);
  const statusLine =
    health == null
      ? b.status ?? "This device doesn't report the battery's real capacity."
      : health >= 90
        ? 'Battery in very good shape.'
        : health >= 80
          ? 'Normal wear.'
          : health >= 60
            ? 'Battery life is noticeably shorter than when new.'
            : 'Worth replacing once battery life becomes a problem.';

  return (
    <Glass className="card">
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        {health != null ? (
          <Ring value={health} size={104} stroke={9} color={health < 60 ? 'var(--critical)' : health < 80 ? 'var(--warning)' : 'var(--good)'}>
            <div className="num" style={{ fontSize: 26, fontWeight: 640, letterSpacing: '-0.04em' }}>
              {Math.round(health)}
              <span style={{ fontSize: 14 }}>%</span>
            </div>
            <div className="muted" style={{ fontSize: 10.5 }}>
              health
            </div>
          </Ring>
        ) : (
          <div className="ring" style={{ width: 104, height: 104 }}>
            <BatteryFull size={36} className="dim" />
          </div>
        )}
        <div className="grow">
          <h2 className="section-title">Battery</h2>
          <p className="section-sub">{[b.manufacturer, b.chemistry].filter(Boolean).join(' · ') || 'Internal battery'}</p>
          <p style={{ margin: '8px 0 0', fontSize: 13.5 }}>{statusLine}</p>
          {b.estimated && health != null && <p className="section-sub">Estimated from the charge counter. Most accurate between 50 and 100% charge.</p>}
        </div>
      </div>
      <div className="stat-grid" style={{ marginTop: 18 }}>
        {b.fullCapacity != null && <Stat value={fmt(b.fullCapacity)} label="Capacity now" />}
        {b.designCapacity != null && <Stat value={fmt(b.designCapacity)} label="Factory capacity" />}
        {wear != null && <Stat value={`${dec1(wear)}%`} label="Capacity lost" />}
        {b.cycles != null && <Stat value={int(b.cycles)} label="Charge cycles" />}
        {b.tempC != null && <Stat value={`${Math.round(b.tempC)}°C`} label="Temperature" />}
        {live?.power?.percent != null && <Stat value={`${live.power.percent}%`} label={live.power.charging ? 'Charging' : live.power.onAc ? 'Plugged in' : 'On battery'} />}
      </div>
    </Glass>
  );
}

function NoWearRow({ icon: Icon, title, text }: { icon: typeof Cpu; title: string; text: string }) {
  return (
    <div className="list-row">
      <Icon size={20} className="dim" style={{ flex: 'none' }} />
      <div className="grow">
        <div className="row-title">{title}</div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>
          {text}
        </div>
      </div>
    </div>
  );
}

export function Health() {
  const health = useData<HealthData>('health', () => bridge.health(), 60000);
  const live = useLive();
  const system = useSystem();
  const h = health.data;
  const isAndroid = bridge.platform === 'android';
  const errors = h?.hardwareErrors;
  const crashes = h?.unexpectedShutdowns;

  return (
    <div className="stack">
      <PageHead title="Health" subtitle="How worn your components are, from what they report themselves." />

      {!h && health.loading && (
        <Glass className="card row">
          <Loader2 size={17} className="spin" /> Reading component data…
        </Glass>
      )}
      {!h && !health.loading && (
        <Glass className="card">
          <p className="dim" style={{ margin: 0 }}>
            The data couldn't be read{health.error ? `: ${health.error}` : '.'}
          </p>
        </Glass>
      )}

      {h && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="stack">
            {h.disks.map((d) => (
              <DiskCard key={d.index} d={d} />
            ))}
          </div>
          <div className="stack">
            {h.battery && <BatteryCard b={h.battery} live={live} />}
            <Glass className="card">
              <h2 className="section-title">{isAndroid ? 'Processor and memory' : 'Processor and RAM'}</h2>
              <p className="section-sub">These parts have no wear counter, so they're judged by the errors they report.</p>
              <div className="list" style={{ marginTop: 6 }}>
                {!isAndroid && errors != null && (
                  <div className="list-row">
                    {errors === 0 ? <CheckCircle2 size={20} color="var(--good)" style={{ flex: 'none' }} /> : <AlertTriangle size={20} color="var(--warning)" style={{ flex: 'none' }} />}
                    <div className="grow">
                      <div className="row-title">{errors === 0 ? 'No hardware errors' : `${int(errors)} hardware errors`}</div>
                      <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                        {errors === 0 ? "Windows hasn't logged any processor or RAM errors in the last 30 days." : 'Logged by Windows in the last 30 days. These can point to unstable RAM or a processor problem.'}
                      </div>
                    </div>
                  </div>
                )}
                {!isAndroid && crashes != null && (
                  <div className="list-row">
                    {crashes === 0 ? <CheckCircle2 size={20} color="var(--good)" style={{ flex: 'none' }} /> : <AlertTriangle size={20} color={crashes > 3 ? 'var(--warning)' : 'var(--ink-2)'} style={{ flex: 'none' }} />}
                    <div className="grow">
                      <div className="row-title">{crashes === 0 ? 'No unexpected shutdowns' : `${int(crashes)} unexpected ${crashes === 1 ? 'shutdown' : 'shutdowns'}`}</div>
                      <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                        In the last 30 days. Holding the power button or a flat battery also counts.
                      </div>
                    </div>
                  </div>
                )}
                {system && <NoWearRow icon={Cpu} title={system.cpuName} text={`${system.cores} cores, ${system.threads} threads`} />}
                {isAndroid && <NoWearRow icon={MemoryStick} title="Internal storage" text="Android doesn't allow reading storage wear, except on rooted phones." />}
              </div>
            </Glass>
          </div>
        </div>
      )}
    </div>
  );
}
