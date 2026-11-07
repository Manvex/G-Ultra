import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Globe, Layers3, Loader2, Lock, Package, RefreshCw, Sparkles, Terminal, X } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes, bytesParts, plural } from '../lib/format';
import { useData } from '../lib/store';
import { tasks, useTasks } from '../lib/tasks';
import type { AndroidPermissions, AndroidStorage } from '../lib/types';
import { AppIcon, Glass, PageHead, SheetClose, Switch, openSheet, toast } from '../ui/kit';
import { requestElevation } from './Sheets';

const GROUPS: { id: string; title: string; icon: typeof Layers3 }[] = [
  { id: 'system', title: 'Windows', icon: Layers3 },
  { id: 'browsers', title: 'Browsers', icon: Globe },
  { id: 'apps', title: 'Apps', icon: Package },
  { id: 'dev', title: 'Developer tools', icon: Terminal },
];

function WindowsClean() {
  const t = useTasks();
  const { categories } = t;

  useEffect(() => {
    if (categories.length === 0) t.scanCleanable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sel = t.selection();
  const chosen = categories.filter((c) => sel.has(c.id) && !c.needsAdmin && (c.bytes ?? 0) > 0);
  const total = chosen.reduce((s, c) => s + (c.bytes ?? 0), 0);
  const totalParts = bytesParts(total);
  const pending = categories.filter((c) => c.bytes == null).length;
  const locked = categories.filter((c) => c.needsAdmin);
  const includesRecycle = chosen.some((c) => c.id === 'recycle');
  const anyBusy = chosen.filter((c) => c.busy);
  const result = t.cleanResult;

  const confirm = () => {
    openSheet((close) => (
      <>
        <SheetClose onClose={close} />
        <h2>Delete {bytes(total)}?</h2>
        <p>{plural(chosen.length, 'category', 'categories')} selected. Files deleted here don't go to the Recycle Bin. This runs in the background.</p>
        <ul className="bullets" style={{ marginTop: 10, maxHeight: 180, overflowY: 'auto' }}>
          {chosen.map((c) => (
            <li key={c.id} className="row between">
              <span>{c.name}</span>
              <span className="num">{bytes(c.bytes)}</span>
            </li>
          ))}
        </ul>
        {includesRecycle && (
          <p style={{ color: '#ffb35c' }}>
            <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            The Recycle Bin gets emptied permanently.
          </p>
        )}
        {anyBusy.length > 0 && <p>{anyBusy.map((c) => c.name).join(', ')} {anyBusy.length === 1 ? 'is' : 'are'} running: files in use will be skipped. Close {anyBusy.length === 1 ? 'it' : 'them'} first for a full cleanup.</p>}
        <div className="sheet-actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn solid-danger"
            onClick={() => {
              close();
              void tasks.runClean(chosen.map((c) => c.id));
            }}
          >
            Delete
          </button>
        </div>
      </>
    ));
  };

  return (
    <div className="stack">
      <PageHead
        title="Cleanup"
        subtitle="Your passwords, history, documents and personal files stay untouched."
        actions={
          <button className="btn" onClick={() => t.scanCleanable()} disabled={t.cleanScanning || t.cleanRunning}>
            <RefreshCw size={15} className={t.cleanScanning ? 'spin' : undefined} /> Scan again
          </button>
        }
      />

      <Glass className="clean-hero">
        <div>
          <div className="label">{result && !t.cleanScanning ? `You freed ${bytes(result.freed)}. You can still free` : 'You can free'}</div>
          <div className="clean-total" style={{ marginTop: 4 }}>
            {totalParts.value}
            <small>{totalParts.unit}</small>
          </div>
          <div className="section-sub" style={{ marginTop: 8 }}>
            {pending > 0 ? `Measuring ${plural(pending, 'category', 'categories')}…` : `${plural(chosen.length, 'category', 'categories')} selected`}
            {result && result.skipped > 0 ? ` · ${plural(result.skipped, 'file in use was', 'files in use were')} skipped` : ''}
          </div>
        </div>
        {t.cleanRunning ? (
          <button className="btn lg" onClick={() => t.cancelClean()}>
            <X size={16} /> Stop cleanup
          </button>
        ) : (
          <button className="btn primary lg" disabled={total === 0} onClick={confirm}>
            <Sparkles size={17} />
            Clean selection
          </button>
        )}
      </Glass>

      {locked.length > 0 && (
        <Glass className="notice">
          <div className="notice-icon" style={{ background: 'rgba(255,159,10,.14)' }}>
            <Lock size={17} color="var(--warning)" />
          </div>
          <div className="grow">
            <div className="row-title" style={{ whiteSpace: 'normal' }}>
              {plural(locked.length, 'category needs', 'categories need')} full mode
            </div>
            <div className="row-sub" style={{ whiteSpace: 'normal' }}>
              {locked.map((c) => c.name).join(', ')}
            </div>
          </div>
          <button className="btn sm" onClick={() => requestElevation()}>
            Full mode
          </button>
        </Glass>
      )}

      {GROUPS.map((g) => {
        const list = categories.filter((c) => c.group === g.id);
        if (!list.length) return null;
        return (
          <Glass className="card" key={g.id}>
            <div className="row" style={{ gap: 10 }}>
              <g.icon size={17} className="dim" />
              <h2 className="section-title">{g.title}</h2>
            </div>
            <div className="list" style={{ marginTop: 6 }}>
              {list.map((c) => {
                const on = sel.has(c.id) && !c.needsAdmin;
                return (
                  <div className="list-row" key={c.id}>
                    <div className="grow">
                      <div className="row" style={{ gap: 8 }}>
                        <div className="row-title">{c.name}</div>
                        {c.busy && <span className="badge">running</span>}
                        {c.needsAdmin && (
                          <span className="badge">
                            <Lock size={10} /> admin
                          </span>
                        )}
                      </div>
                      <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                        {c.desc} {c.note}
                      </div>
                    </div>
                    <div className="row-value" style={{ minWidth: 70 }}>
                      {c.bytes == null ? <span className="skeleton" /> : c.needsAdmin && c.bytes === 0 ? <span className="muted">unknown</span> : bytes(c.bytes)}
                    </div>
                    <Switch checked={on} disabled={c.needsAdmin || t.cleanRunning} onChange={(v) => t.toggleCategory(c.id, v)} label={c.name} />
                  </div>
                );
              })}
            </div>
          </Glass>
        );
      })}
    </div>
  );
}

function AndroidClean() {
  const perms = useData<AndroidPermissions>('androidPerms', () => bridge.android!.permissions(), 3000);
  const storage = useData<AndroidStorage>('androidStorage', () => bridge.android!.storage(), 45000);
  const [ownFreed, setOwnFreed] = useState<number | null>(null);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        void perms.reload();
        void storage.reload();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const p = perms.data;
  const apps = useMemo(() => [...(storage.data?.apps ?? [])].filter((a) => a.cacheBytes > 0).sort((a, b) => b.cacheBytes - a.cacheBytes), [storage.data]);
  const total = apps.reduce((s, a) => s + a.cacheBytes, 0);
  const parts = bytesParts(total);

  const clearAll = async () => {
    const r = await bridge.android!.clearAllCaches();
    if (!r.launched) {
      if (r.reason === 'needsAllFiles') {
        toast('To clear app caches, Android requires access to all files.', 'info');
        void bridge.android!.requestAllFiles();
      } else {
        toast("Your Android version doesn't let apps clear all caches. Opening settings.", 'info');
        void bridge.android!.openStorageSettings();
      }
    }
  };

  return (
    <div className="stack">
      <PageHead title="Cleanup" subtitle="Caches rebuild when needed. Your accounts and app data stay." />

      <Glass className="clean-hero">
        <div>
          <div className="label">App caches</div>
          <div className="clean-total" style={{ marginTop: 4 }}>
            {storage.data?.usageAccess ? parts.value : '—'}
            <small>{storage.data?.usageAccess ? parts.unit : ''}</small>
          </div>
          <div className="section-sub" style={{ marginTop: 8 }}>
            {storage.data?.usageAccess ? `across ${plural(apps.length, 'app', 'apps')}` : 'Grant usage access to see sizes'}
          </div>
        </div>
        <button className="btn primary lg" onClick={clearAll}>
          <Sparkles size={17} /> Clear all caches
        </button>
      </Glass>

      {p && !p.canClearAllCaches && (
        <Glass className="notice">
          <div className="notice-icon">
            <Lock size={17} />
          </div>
          <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
            {p.sdk >= 30 ? 'Android only allows clearing every app cache with access to all files, and the system asks you to confirm each time.' : "On this Android version, caches are cleared from each app's settings."}
          </div>
          {p.sdk >= 30 && (
            <button className="btn sm" onClick={() => bridge.android?.requestAllFiles()}>
              Grant
            </button>
          )}
        </Glass>
      )}

      {storage.data && !storage.data.usageAccess && (
        <Glass className="notice">
          <div className="notice-icon">
            <Lock size={17} />
          </div>
          <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
            Android requires usage access for G Ultra to measure each app's cache.
          </div>
          <button className="btn sm" onClick={() => bridge.android?.requestUsageAccess()}>
            Grant
          </button>
        </Glass>
      )}

      <Glass className="card">
        <div className="row between">
          <div>
            <h2 className="section-title">G Ultra's own cache</h2>
            <p className="section-sub">The only one an app can clear by itself, without the system.</p>
          </div>
          <button
            className="btn sm"
            onClick={async () => {
              const r = await bridge.cleanRun([]);
              setOwnFreed(r.freed);
            }}
          >
            {ownFreed != null ? `Freed ${bytes(ownFreed)}` : 'Clear'}
          </button>
        </div>
      </Glass>

      {apps.length > 0 && (
        <Glass className="card">
          <h2 className="section-title">Cache by app</h2>
          <p className="section-sub">Tap an app to clear only its cache from settings.</p>
          <div className="list" style={{ marginTop: 6 }}>
            {apps.slice(0, 40).map((a) => (
              <button key={a.packageName} className="list-row" onClick={() => bridge.android?.openAppInfo(a.packageName)}>
                <AppIcon title={a.label} path={a.packageName} />
                <div className="grow row-title">{a.label}</div>
                <div className="row-value">{bytes(a.cacheBytes)}</div>
                <ChevronRight size={16} className="row-chev" />
              </button>
            ))}
          </div>
        </Glass>
      )}

      {storage.loading && !storage.data && (
        <Glass className="card row">
          <Loader2 size={17} className="spin" /> Measuring…
        </Glass>
      )}
    </div>
  );
}

export function Clean() {
  return bridge.platform === 'android' ? <AndroidClean /> : <WindowsClean />;
}
