import { useEffect, useMemo } from 'react';
import { AlertTriangle, Check, ChevronRight, CircleX, Loader2, PackageCheck, RefreshCw, RotateCcw } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes } from '../lib/format';
import { useData, useSystem } from '../lib/store';
import { useTasks } from '../lib/tasks';
import type { InstalledDrivers } from '../lib/types';
import { Glass, PageHead, Switch } from '../ui/kit';
import { requestElevation } from './Sheets';

const MAKERS = [
  { test: /nvidia|geforce|quadro/i, name: 'NVIDIA', url: 'https://www.nvidia.com/Download/index.aspx' },
  { test: /\bamd\b|radeon/i, name: 'AMD', url: 'https://www.amd.com/en/support/download/drivers.html' },
  { test: /intel/i, name: 'Intel', url: 'https://www.intel.com/content/www/us/en/support/detect.html' },
];

function Updates() {
  const t = useTasks();
  const scan = t.driverScan;
  const selected = t.driverSelected();
  const chosen = scan?.updates.filter((u) => selected.has(u.id)) ?? [];
  const total = chosen.reduce((s, u) => s + u.size, 0);

  return (
    <Glass className="card">
      <h2 className="section-title">Available updates</h2>
      <p className="section-sub">Only drivers from Windows Update, chosen by Microsoft for your hardware. Windows updates aren't included.</p>

      {!scan && t.driversChecking && (
        <div className="row small dim" style={{ marginTop: 14, gap: 8 }}>
          <Loader2 size={15} className="spin" />
          Checking Windows Update. This can take a few minutes, and you can keep using the app.
        </div>
      )}
      {!scan && !t.driversChecking && t.driverError && <p className="section-sub" style={{ marginTop: 14 }}>{t.driverError}</p>}
      {scan && scan.updates.length === 0 && (
        <div className="row small" style={{ marginTop: 14, gap: 8 }}>
          <Check size={16} color="var(--good)" />
          Windows Update has no new drivers for this PC.
        </div>
      )}

      {scan && scan.updates.length > 0 && (
        <>
          <div className="list" style={{ marginTop: 6 }}>
            {scan.updates.map((u) => (
              <div className="list-row" key={u.id}>
                <div className="grow">
                  <div className="row-title" style={{ whiteSpace: 'normal' }}>
                    {u.title}
                  </div>
                  <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                    {[u.provider, u.date, u.size > 0 ? bytes(u.size) : null].filter(Boolean).join(' · ')}
                    {u.needsTerms ? ' · Has license terms, so install it from Windows Update' : ''}
                  </div>
                </div>
                <Switch checked={selected.has(u.id)} disabled={u.needsTerms || t.driversInstalling} onChange={(on) => t.toggleDriver(u.id, on)} label={`Install ${u.title}`} />
              </div>
            ))}
          </div>
          <p className="section-sub" style={{ marginTop: 12 }}>
            G Ultra creates a restore point first, so you can go back if a driver causes problems. Keep the app open until it finishes.
          </p>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            {!scan.elevated && (
              <button className="btn sm" onClick={() => requestElevation()}>
                Full mode
              </button>
            )}
            <button className="btn sm primary" disabled={!scan.elevated || chosen.length === 0 || t.driversInstalling || t.driversChecking} onClick={() => void t.installDrivers(chosen.map((u) => u.id))}>
              {t.driversInstalling && <Loader2 size={13} className="spin" />}
              {t.driversInstalling ? 'Installing…' : `Install ${chosen.length}${total > 0 ? ` (${bytes(total)})` : ''}`}
            </button>
          </div>
          {!scan.elevated && <p className="section-sub" style={{ marginTop: 8, textAlign: 'right' }}>Installing drivers needs full mode.</p>}
        </>
      )}
    </Glass>
  );
}

function NoRestorePoint() {
  const t = useTasks();
  const c = t.driverConfirm;
  if (!c) return null;
  return (
    <Glass className="notice">
      <div className="notice-icon">
        <AlertTriangle size={17} color="var(--warning)" />
      </div>
      <div className="grow">
        <div className="row-title">Install without a restore point?</div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>
          {c.message} Without one, you'd have to roll back a bad driver yourself from Device Manager.
        </div>
      </div>
      <button className="btn sm" onClick={() => t.cancelDriverConfirm()}>
        Cancel
      </button>
      <button className="btn sm" onClick={() => void t.installDrivers(c.ids, true)}>
        Install anyway
      </button>
    </Glass>
  );
}

function LastResult() {
  const t = useTasks();
  const r = t.driverResult;
  if (!r) return null;
  return (
    <Glass className="card">
      <h2 className="section-title">Last install</h2>
      <p className="section-sub">{r.restore.message}</p>
      <div className="list" style={{ marginTop: 6 }}>
        {r.results.map((x) => (
          <div className="list-row" key={x.id}>
            {x.state === 'installed' ? <Check size={18} color="var(--good)" style={{ flex: 'none' }} /> : x.state === 'failed' ? <CircleX size={18} color="var(--warning)" style={{ flex: 'none' }} /> : <ChevronRight size={18} className="dim" style={{ flex: 'none' }} />}
            <div className="grow">
              <div className="row-title" style={{ whiteSpace: 'normal' }}>
                {x.title ?? 'Driver'}
              </div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                {x.state === 'installed' ? 'Installed' : x.message}
              </div>
            </div>
          </div>
        ))}
      </div>
      {r.rebootRequired && (
        <div className="row small" style={{ marginTop: 12, gap: 8 }}>
          <RotateCcw size={15} />
          Restart your PC to finish installing.
        </div>
      )}
    </Glass>
  );
}

export function Drivers() {
  const t = useTasks();
  const system = useSystem();
  const installed = useData<InstalledDrivers>('driversInstalled', () => bridge.win!.driversInstalled(), 300000);

  useEffect(() => {
    if (!t.driverScan && !t.driverError) t.checkDrivers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const makers = useMemo(() => MAKERS.filter((m) => system?.gpus.some((g) => m.test.test(g))), [system?.gpus]);
  const groups = useMemo(() => {
    const map = new Map<string, InstalledDrivers['drivers']>();
    for (const d of installed.data?.drivers ?? []) map.set(d.group, [...(map.get(d.group) ?? []), d]);
    return [...map.entries()];
  }, [installed.data]);
  const problems = installed.data?.problems ?? [];

  return (
    <div className="stack">
      <PageHead
        title="Drivers"
        subtitle="Keep your hardware's drivers up to date, and choose exactly what gets installed."
        actions={
          <button className="btn sm" disabled={t.driversChecking || t.driversInstalling} onClick={() => t.checkDrivers()}>
            {t.driversChecking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {t.driversChecking ? 'Checking…' : 'Check again'}
          </button>
        }
      />

      <NoRestorePoint />
      <LastResult />
      <Updates />

      {problems.length > 0 && (
        <Glass className="card">
          <h2 className="section-title">Devices with a problem</h2>
          <div className="list" style={{ marginTop: 6 }}>
            {problems.map((p, i) => (
              <div className="list-row" key={`${p.name}-${i}`}>
                <AlertTriangle size={18} color="var(--warning)" style={{ flex: 'none' }} />
                <div className="grow">
                  <div className="row-title">{p.name}</div>
                  <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                    {p.meaning}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Glass>
      )}

      {makers.length > 0 && (
        <Glass className="card">
          <h2 className="section-title">Newest graphics drivers</h2>
          <p className="section-sub">Graphics card makers usually release new drivers before Windows Update offers them. These links open the maker's site.</p>
          <div className="list" style={{ marginTop: 6 }}>
            {makers.map((m) => (
              <button className="list-row" key={m.name} onClick={() => bridge.openLink(m.url)}>
                <PackageCheck size={18} className="dim" style={{ flex: 'none' }} />
                <div className="grow row-title">{m.name} drivers</div>
                <ChevronRight size={16} className="row-chev" />
              </button>
            ))}
          </div>
        </Glass>
      )}

      <Glass className="card">
        <h2 className="section-title">Installed drivers</h2>
        <p className="section-sub">Your main hardware. Drivers built into Windows update along with it, so they aren't listed.</p>
        {installed.data == null && installed.loading && <p className="section-sub" style={{ marginTop: 12 }}>Reading your drivers…</p>}
        {installed.data == null && !installed.loading && installed.error && <p className="section-sub" style={{ marginTop: 12 }}>{installed.error}</p>}
        {groups.map(([group, list]) => (
          <div key={group} style={{ marginTop: 14 }}>
            <div className="small dim">{group}</div>
            <div className="list">
              {list.map((d) => (
                <div className="list-row" key={`${d.name}-${d.version}`}>
                  <div className="grow">
                    <div className="row-title" style={{ whiteSpace: 'normal' }}>
                      {d.name}
                    </div>
                    <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                      {[`Version ${d.version}`, d.date, d.provider].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Glass>
    </div>
  );
}
