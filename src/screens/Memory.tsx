import { useMemo, useState } from 'react';
import { CheckCircle2, CircleSlash2, ExternalLink, HelpCircle, Loader2, Lock, MemoryStick, Replace, Sparkles } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes, bytesParts, plural } from '../lib/format';
import { store, useData, useLive, useSystem } from '../lib/store';
import { tasks, useTasks } from '../lib/tasks';
import type { MemoryDetails, RamModule } from '../lib/types';
import { Glass, PageHead, SheetClose, Switch, openSheet } from '../ui/kit';
import { Liquid, type LiquidLayer } from '../ui/Liquid';
import { ProcessRow } from './Home';
import { requestElevation } from './Sheets';
import { RamHealthCard } from './RamHealth';
import { StartupApps } from './Startup';

const SEG = {
  used: ['rgba(164,126,255,.95)', 'rgba(72,40,184,.92)'] as [string, string],
  modified: ['rgba(235,140,84,.95)', 'rgba(170,84,34,.92)'] as [string, string],
  standby: ['rgba(82,170,255,.72)', 'rgba(24,88,196,.72)'] as [string, string],
};

// A drawing of a module: the board, the chips and the gold contacts.
function StickArt({ form, empty }: { form?: string | null; empty?: boolean }) {
  const sodimm = form === 'SO-DIMM';
  const w = sodimm ? 170 : 240;
  const chips = sodimm ? 4 : 8;
  const chipW = (w - 28) / chips - 5;
  if (empty) {
    return (
      <svg viewBox={`0 0 ${w} 48`} style={{ width: '100%', maxWidth: w, display: 'block' }} aria-hidden="true">
        <rect x="1" y="1" width={w - 2} height="46" rx="6" fill="none" stroke="rgba(255,255,255,.24)" strokeDasharray="5 5" />
      </svg>
    );
  }
  return (
    <svg viewBox={`0 0 ${w} 48`} style={{ width: '100%', maxWidth: w, display: 'block' }} aria-hidden="true">
      <defs>
        <linearGradient id={`pcb${w}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1f6b4f" />
          <stop offset="1" stopColor="#0c3a2d" />
        </linearGradient>
        <linearGradient id="chip" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a3d48" />
          <stop offset="1" stopColor="#14151b" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={w} height="40" rx="4" fill={`url(#pcb${w})`} />
      {Array.from({ length: chips }).map((_, i) => (
        <rect key={i} x={14 + i * (chipW + 5)} y="7" width={chipW} height="20" rx="2" fill="url(#chip)" stroke="rgba(255,255,255,.1)" />
      ))}
      <g fill="#d8b25c">
        {Array.from({ length: Math.floor(w / 5) - 2 }).map((_, i) => {
          const x = 6 + i * 5;
          if (Math.abs(x - w * 0.58) < 5) return null;
          return <rect key={i} x={x} y="34" width="3" height="12" rx="0.8" />;
        })}
      </g>
    </svg>
  );
}

function ModuleCard({ m }: { m: RamModule }) {
  return (
    <div className="stick">
      <StickArt form={m.form} />
      <div className="row between" style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 620, letterSpacing: '-0.02em', fontSize: 15 }}>
          {m.manufacturer} {bytes(m.capacity)}
        </div>
        <span className="badge">{m.type ?? 'RAM'}</span>
      </div>
      <dl className="spec">
        {m.partNumber && (
          <>
            <dt>Part number</dt>
            <dd title={m.partNumber}>{m.partNumber}</dd>
          </>
        )}
        {m.speed > 0 && (
          <>
            <dt>Speed</dt>
            <dd>{m.speed} MT/s</dd>
          </>
        )}
        {m.form && (
          <>
            <dt>Form factor</dt>
            <dd>{m.form}</dd>
          </>
        )}
        {m.voltage != null && (
          <>
            <dt>Voltage</dt>
            <dd>{m.voltage.toLocaleString('en-US')} V</dd>
          </>
        )}
        {m.slot && (
          <>
            <dt>Slot</dt>
            <dd title={m.slot}>{m.slot}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

const VERDICT = {
  yes: { icon: CheckCircle2, color: 'var(--good)', bg: 'rgba(48,209,88,.15)' },
  replace: { icon: Replace, color: 'var(--info)', bg: 'rgba(100,210,255,.15)' },
  no: { icon: CircleSlash2, color: 'var(--warning)', bg: 'rgba(255,159,10,.15)' },
  unknown: { icon: HelpCircle, color: 'var(--ink-2)', bg: 'rgba(255,255,255,.1)' },
};

function FreeRamSheet({ close }: { close: () => void }) {
  const elevated = store.live?.elevated ?? false;
  const isAndroid = bridge.platform === 'android';
  const [standby, setStandby] = useState(elevated);

  return (
    <>
      <SheetClose onClose={close} />
      <h2>Free up RAM</h2>
      {isAndroid ? (
        <p>G Ultra closes background processes as far as your Android version allows. Since Android 14, the system no longer lets apps stop other apps.</p>
      ) : (
        <p>Your apps stay open. Windows moves what isn't in active use out of RAM and reloads it when needed, so an app may respond a little slower right after.</p>
      )}
      {!isAndroid && (
        <div className="list" style={{ marginTop: 12 }}>
          <div className="list-row">
            <div className="grow">
              <div className="row-title">Clear app memory</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                For every process G Ultra can reach.
              </div>
            </div>
            <Switch checked disabled onChange={() => {}} label="Clear app memory" />
          </div>
          <div className="list-row">
            <div className="grow">
              <div className="row-title">Clear the standby cache</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                {elevated ? 'Frees the most, but files get read from the SSD again.' : 'Available in full mode, with administrator rights.'}
              </div>
            </div>
            {elevated ? (
              <Switch checked={standby} onChange={setStandby} label="Clear the standby cache" />
            ) : (
              <button className="btn sm" onClick={() => requestElevation(close)}>
                <Lock size={13} /> Full mode
              </button>
            )}
          </div>
        </div>
      )}
      <div className="sheet-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={() => {
            void tasks.freeRam(standby);
            close();
          }}
        >
          <Sparkles size={16} />
          Free up
        </button>
      </div>
    </>
  );
}

export function Memory() {
  const live = useLive();
  const t = useTasks();
  const system = useSystem();
  const details = useData<MemoryDetails>('memory', () => bridge.memory(), 600000);
  const isAndroid = bridge.platform === 'android';
  const mem = live?.mem;
  const result = t.ramResult;

  const layers: LiquidLayer[] = useMemo(() => {
    if (!mem) return [];
    const inUse = Math.max(0, mem.used - mem.modified);
    return [
      { value: inUse / mem.total, color: SEG.used },
      ...(mem.modified > 0 ? [{ value: mem.modified / mem.total, color: SEG.modified }] : []),
      { value: mem.standby / mem.total, color: SEG.standby },
    ];
  }, [mem]);

  const legend = mem
    ? [
        { color: 'rgb(164,126,255)', name: 'In use', hint: 'Actively used by apps and the system', value: Math.max(0, mem.used - mem.modified) },
        ...(mem.modified > 0 ? [{ color: 'rgb(235,140,84)', name: 'Modified', hint: 'Must be written to disk before reuse', value: mem.modified }] : []),
        {
          color: 'rgb(82,170,255)',
          name: isAndroid ? 'Cache' : 'Cache (standby)',
          hint: 'Ready to reuse, released automatically when needed',
          value: mem.standby,
        },
        { color: 'rgba(255,255,255,.26)', name: 'Free', hint: 'Completely unoccupied', value: mem.free },
      ]
    : [];

  const d = details.data;
  const verdict = d ? VERDICT[d.upgrade.verdict] : null;
  const usedParts = bytesParts(mem?.used);
  const processes = useMemo(() => [...(live?.processes ?? [])].sort((a, b) => b.mem - a.mem).slice(0, 14), [live]);
  const maxMem = Math.max(1, ...processes.map((p) => p.mem));
  const emptySlots = d ? Math.max(0, d.slotsTotal - d.slotsUsed) : 0;

  return (
    <div className="stack">
      <PageHead
        title="Memory"
        subtitle={d ? `${bytes(d.installed)}${d.type ? ` ${d.type}` : ''}${d.speed ? ` at ${d.speed} MT/s` : ''}${d.dualChannel ? ' · dual channel' : ''}` : ' '}
        actions={
          <button className="btn primary lg" disabled={t.freeingRam} onClick={() => openSheet((close) => <FreeRamSheet close={close} />)}>
            {t.freeingRam ? <Loader2 size={17} className="spin" /> : <Sparkles size={17} />}
            {t.freeingRam ? 'Freeing…' : 'Free up RAM'}
          </button>
        }
      />

      {result && (
        <Glass className="notice">
          <div className="notice-icon" style={{ background: 'rgba(48,209,88,.15)' }}>
            <CheckCircle2 size={18} color="var(--good)" />
          </div>
          <div className="grow">
            <div className="row-title" style={{ whiteSpace: 'normal' }}>
              {result.restricted ? 'Android kept control of memory' : `+${bytes(result.freed)} of available memory`}
            </div>
            <div className="row-sub" style={{ whiteSpace: 'normal' }}>
              From {bytes(result.before)} to {bytes(result.after)} available.
              {!result.restricted && ` ${plural(result.trimmed, 'process', 'processes')} cleared.`}
              {result.standbyPurged && ' Standby cache cleared.'} The system reloads what it needs over time.
            </div>
          </div>
        </Glass>
      )}

      <div className="grid-mem">
        <Glass className="card" style={{ padding: 10 }}>
          <div className="tank">
            {layers.length > 0 && <Liquid layers={layers} energy={0.22} />}
            <div className="tank-label">
              <div className="label" style={{ color: 'rgba(255,255,255,.86)' }}>
                In use now
              </div>
              <div className="tile-value" style={{ marginTop: 2 }}>
                {usedParts.value}
                <small>{usedParts.unit}</small>
              </div>
              <div className="tile-sub">{mem ? `of ${bytes(mem.total)} · ${mem.load}%` : ''}</div>
            </div>
          </div>
        </Glass>

        <Glass className="card">
          <h2 className="section-title">What's in memory</h2>
          <div className="legend" style={{ marginTop: 6 }}>
            {legend.map((l) => (
              <div className="legend-row" key={l.name}>
                <i className="dot" style={{ background: l.color }} />
                <div style={{ minWidth: 0 }}>
                  <div className="row-title">{l.name}</div>
                  <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                    {l.hint}
                  </div>
                </div>
                <div className="row-value">{bytes(l.value)}</div>
              </div>
            ))}
            {mem && mem.commitLimit > 0 && (
              <div className="legend-row">
                <i className="dot" style={{ background: 'transparent' }} />
                <div style={{ minWidth: 0 }}>
                  <div className="row-title">{isAndroid ? 'Swap' : 'Committed'}</div>
                  <div className="row-sub">{isAndroid ? 'Memory extended onto storage' : 'Promised to apps, including the page file'}</div>
                </div>
                <div className="row-value">
                  {bytes(mem.commit)} / {bytes(mem.commitLimit)}
                </div>
              </div>
            )}
          </div>
        </Glass>
      </div>

      <div className="grid-mem">
        <Glass className="card">
          <div className="row between">
            <h2 className="section-title">Installed modules</h2>
            {d && d.slotsTotal > 0 && !isAndroid && <span className="badge">{`${d.slotsUsed} of ${d.slotsTotal} slots`}</span>}
          </div>
          <div className="sticks" style={{ marginTop: 12 }}>
            {details.loading && !d && <span className="skeleton" style={{ width: '100%', height: 120 }} />}
            {d?.modules.map((m, i) => (
              <ModuleCard key={i} m={m} />
            ))}
            {Array.from({ length: emptySlots }).map((_, i) => (
              <div className="stick empty" key={`e${i}`}>
                <StickArt form={d?.modules[0]?.form} empty />
                <div className="row-title" style={{ marginTop: 12 }}>
                  Free slot
                </div>
              </div>
            ))}
            {d && d.modules.length === 0 && (
              <div className="stick">
                <MemoryStick size={20} />
                <div className="row-title" style={{ marginTop: 8 }}>
                  {bytes(d.installed)}
                  {d.type ? ` ${d.type}` : ''}
                </div>
                <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                  {d.typeNote ?? "The system doesn't report module details."}
                </div>
              </div>
            )}
          </div>
        </Glass>

        <Glass className="card">
          <h2 className="section-title">Can you upgrade?</h2>
          {d && verdict && (
            <div className="verdict" style={{ marginTop: 14 }}>
              <div className="verdict-icon" style={{ background: verdict.bg }}>
                <verdict.icon size={22} color={verdict.color} />
              </div>
              <div className="grow">
                <div style={{ fontWeight: 620, fontSize: 16, letterSpacing: '-0.02em' }}>{d.upgrade.title}</div>
                {d.maxCapacity != null && d.upgrade.verdict !== 'unknown' && (
                  <div className="ram-max">
                    <div className="tile-value" style={{ fontSize: 34 }}>
                      {bytesParts(d.maxCapacity).value}
                      <small style={{ fontSize: 17 }}>{bytesParts(d.maxCapacity).unit}</small>
                    </div>
                    <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                      maximum{d.maxConfig ? `: ${d.maxConfig}` : ''}
                    </div>
                  </div>
                )}
                <ul className="bullets">
                  {d.upgrade.details.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
                {!isAndroid && d.upgrade.verdict !== 'no' && system && (
                  <button className="btn sm" style={{ marginTop: 12 }} onClick={() => bridge.openLink(`https://www.google.com/search?q=${encodeURIComponent(`${system.deviceName} maximum RAM official specifications`)}`)}>
                    <ExternalLink size={13} /> Check the maker's limit
                  </button>
                )}
              </div>
            </div>
          )}
          {details.error && <p className="dim">The modules couldn't be read: {details.error}</p>}
        </Glass>
      </div>

      <RamHealthCard />

      {!isAndroid && <StartupApps />}

      {processes.length > 0 && !isAndroid && (
        <Glass className="card">
          <h2 className="section-title">What's using RAM</h2>
          <p className="section-sub">Grouped by app. System processes are protected.</p>
          <div className="list" style={{ marginTop: 6 }}>
            {processes.map((p) => (
              <ProcessRow key={p.key} p={p} sort="mem" max={maxMem} />
            ))}
          </div>
        </Glass>
      )}
    </div>
  );
}
