import { AlertTriangle, CheckCircle2, CircleHelp, HeartPulse, Info, Loader2, RotateCw, ShieldCheck, X, XCircle } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes } from '../lib/format';
import { useData } from '../lib/store';
import { tasks, useTasks } from '../lib/tasks';
import type { RamCheck, RamHealthData } from '../lib/types';
import { Glass, SheetClose, openSheet, toast } from '../ui/kit';

const STATUS: Record<RamCheck['status'], { icon: typeof Info; color: string }> = {
  good: { icon: CheckCircle2, color: 'var(--good)' },
  warn: { icon: AlertTriangle, color: 'var(--warning)' },
  bad: { icon: XCircle, color: 'var(--critical)' },
  info: { icon: Info, color: 'var(--info)' },
  unknown: { icon: CircleHelp, color: 'var(--ink-3)' },
};

const VERDICT = {
  good: { icon: ShieldCheck, color: 'var(--good)', bg: 'rgba(48,209,88,.15)' },
  watch: { icon: AlertTriangle, color: 'var(--warning)', bg: 'rgba(255,159,10,.15)' },
  bad: { icon: XCircle, color: 'var(--critical)', bg: 'rgba(255,69,58,.15)' },
};

function confirmDiagnostic() {
  openSheet((close) => (
    <>
      <SheetClose onClose={close} />
      <h2>Windows Memory Diagnostic</h2>
      <p>The most thorough test here. Windows restarts, tests the memory for about 15 minutes, then shows the result. G Ultra lists it here afterwards.</p>
      <p>The Windows tool asks whether to restart now or next time, so save your work first.</p>
      <div className="sheet-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={() => {
            close();
            bridge.win?.ramDiagnostic().catch((e: Error) => toast(e.message, 'warning'));
          }}
        >
          Open the tool
        </button>
      </div>
    </>
  ));
}

export function RamHealthCard() {
  const t = useTasks();
  const isAndroid = bridge.platform === 'android';
  const health = useData<RamHealthData>('ramHealth', () => bridge.win!.ramHealth(), 300000);
  const d = health.data;

  if (isAndroid) {
    return (
      <Glass className="notice">
        <div className="notice-icon">
          <HeartPulse size={17} />
        </div>
        <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
          Android doesn't report memory errors or module health to apps, so RAM health can't be checked on a phone.
        </div>
      </Glass>
    );
  }

  const verdict = d ? VERDICT[d.verdict] : null;
  const running = t.ramTest?.state === 'running';

  return (
    <Glass className="card">
      <div className="row between wrap" style={{ gap: 10 }}>
        <div>
          <h2 className="section-title">RAM health</h2>
          <p className="section-sub">RAM has no wear counter like an SSD, so this comes from the errors it has caused and from memory tests.</p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {running ? (
            <button className="btn sm" onClick={() => tasks.cancelRamTest()}>
              <X size={13} /> Stop test
            </button>
          ) : (
            <button className="btn sm" onClick={() => tasks.startRamTest()}>
              <RotateCw size={13} /> Quick test
            </button>
          )}
          <button className="btn sm" onClick={confirmDiagnostic}>
            Full test
          </button>
        </div>
      </div>

      {health.loading && !d && (
        <div className="row" style={{ marginTop: 12 }}>
          <Loader2 size={16} className="spin" /> Reading the Windows logs…
        </div>
      )}

      {d && verdict && (
        <div className="verdict" style={{ marginTop: 14 }}>
          <div className="verdict-icon" style={{ background: verdict.bg }}>
            <verdict.icon size={22} color={verdict.color} />
          </div>
          <div className="grow">
            <div style={{ fontWeight: 620, fontSize: 16, letterSpacing: '-0.02em' }}>{d.title}</div>
            <p className="section-sub" style={{ margin: '3px 0 0' }}>
              {d.summary}
            </p>
          </div>
        </div>
      )}

      {running && (
        <div style={{ marginTop: 14 }}>
          <div className="row between small">
            <span className="dim">Quick test running in the background</span>
            <span className="num" style={{ fontWeight: 560 }}>
              {t.ramTest?.percent ?? 0}%
            </span>
          </div>
          <div className="progress-track" style={{ marginTop: 6 }}>
            <i style={{ display: 'block', height: '100%', borderRadius: 6, width: `${t.ramTest?.percent ?? 0}%`, background: 'var(--s1)', transition: 'width .4s' }} />
          </div>
        </div>
      )}

      {d && (
        <div className="list" style={{ marginTop: 8 }}>
          {d.checks.map((c) => {
            const s = STATUS[c.status];
            return (
              <div className="list-row" key={c.id} style={{ alignItems: 'flex-start' }}>
                <s.icon size={18} color={s.color} style={{ flex: 'none', marginTop: 2 }} />
                <div className="grow">
                  <div className="row between" style={{ gap: 8 }}>
                    <div className="row-title">{c.label}</div>
                    <div className="row-value">{c.value}</div>
                  </div>
                  <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                    {c.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {d && d.modules.length > 0 && (
        <div className="sticks" style={{ marginTop: 12 }}>
          {d.modules.map((m, i) => (
            <div className="stick" key={i}>
              <div className="row between">
                <div className="row-title">
                  {m.manufacturer} {bytes(m.capacity)}
                </div>
                {m.tempC != null && <span className="badge">{Math.round(m.tempC)}°C</span>}
              </div>
              <dl className="spec">
                <dt>Slot</dt>
                <dd title={m.slot}>{m.slot}</dd>
                <dt>Running at</dt>
                <dd>
                  {m.configuredSpeed || m.ratedSpeed} of {m.ratedSpeed} MT/s
                </dd>
              </dl>
            </div>
          ))}
        </div>
      )}

      {d && d.modules.length > 1 && (
        <p className="section-sub" style={{ marginTop: 10 }}>
          Windows can't say which module caused an error. If a test fails, try one module at a time to find the faulty one.
        </p>
      )}
    </Glass>
  );
}
