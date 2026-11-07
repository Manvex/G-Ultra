import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, File as FileIcon, Folder, FolderOpen, HardDrive, Loader2, Lock, RefreshCw, ScanSearch, Settings2, Trash2, X } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes, int, plural } from '../lib/format';
import { loadData, useData } from '../lib/store';
import { tasks, useTasks } from '../lib/tasks';
import type { AndroidStorage, DisksInfo, ScanEntry, Volume } from '../lib/types';
import { squarify } from '../ui/charts';
import { AppIcon, Bar, Glass, PageHead, SheetClose, openSheet, toast } from '../ui/kit';

function capacityColor(pct: number) {
  if (pct >= 95) return 'var(--critical)';
  if (pct >= 88) return 'var(--warning)';
  return 'linear-gradient(90deg, var(--s1), #6cb3ff)';
}

function Treemap({ entries, total, onOpen }: { entries: ScanEntry[]; total: number; onOpen: (e: ScanEntry) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setSize({ w: e[0].contentRect.width, h: e[0].contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  // Folders too small for a readable box are merged into "Everything else".
  const threshold = total * 0.008;
  const big = entries.filter((e) => e.size >= threshold).slice(0, 28);
  const restSize = entries.reduce((s, e) => s + (e.size < threshold ? e.size : 0), 0) + entries.filter((e) => e.size >= threshold).slice(28).reduce((s, e) => s + e.size, 0);
  const items: (ScanEntry & { rest?: boolean })[] = restSize > 0 ? [...big, { name: 'Everything else', path: '', size: restSize, rest: true }] : big;
  const rects = squarify(items, (i) => i.size, size.w, size.h);
  return (
    <div className="treemap" ref={ref} role="list" aria-label="Map of used space">
      {rects.map((r) => {
        const share = r.item.size / total;
        const gap = 3;
        const small = r.w < 76 || r.h < 44;
        return (
          <button
            key={r.item.path || r.item.name}
            role="listitem"
            disabled={r.item.rest}
            title={`${r.item.name}: ${bytes(r.item.size)} (${Math.round(share * 100)}%)`}
            onClick={() => onOpen(r.item)}
            aria-label={`${r.item.name}, ${bytes(r.item.size)}`}
            style={{
              left: r.x + gap / 2,
              top: r.y + gap / 2,
              width: Math.max(0, r.w - gap),
              height: Math.max(0, r.h - gap),
              ['--a' as string]: r.item.rest ? 0.08 : 0.14 + Math.min(0.62, share * 1.5),
              cursor: r.item.rest ? 'default' : 'pointer',
            }}
          >
            {!small && (
              <>
                <div className="tm-name">{r.item.name}</div>
                <div className="tm-size">{bytes(r.item.size)}</div>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

function confirmTrash(entry: ScanEntry, onDone: () => void) {
  openSheet((close) => (
    <>
      <SheetClose onClose={close} />
      <h2>Move to the Recycle Bin?</h2>
      <p style={{ wordBreak: 'break-all' }}>{entry.path}</p>
      <p>
        Size: <strong style={{ color: 'var(--ink)' }}>{bytes(entry.size)}</strong>. You can restore it from the Recycle Bin. If this belongs to the system or to an app, that app may stop working.
      </p>
      <div className="sheet-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button
          className="btn solid-danger"
          onClick={() => {
            close();
            // Large folders take a while to move, so this runs in the background too.
            tasks
              .run({ id: `trash-${entry.path}`, label: `Moving ${entry.name} to the Bin`, route: 'storage' }, () => bridge.trash(entry.path))
              .then(() => {
                toast(`${entry.name} moved to the Recycle Bin.`);
                onDone();
              })
              .catch((e: Error) => toast(`Couldn't move it: ${e.message}`, 'warning'));
          }}
        >
          <Trash2 size={15} /> Move to Bin
        </button>
      </div>
    </>
  ));
}

function EntryRow({ entry, max, onOpen, onDeleted }: { entry: ScanEntry; max: number; onOpen?: () => void; onDeleted: () => void }) {
  const Icon = entry.isDir ? Folder : FileIcon;
  const content = (
    <>
      <Icon size={18} className="dim" style={{ flex: 'none' }} />
      <div className="grow">
        <div className="row between" style={{ gap: 8 }}>
          <div className="row-title" title={entry.path}>
            {entry.name}
          </div>
          <div className="row-value">{bytes(entry.size)}</div>
        </div>
        <Bar value={(entry.size / max) * 100} />
      </div>
    </>
  );
  return (
    <div className="list-row">
      {onOpen ? (
        <button onClick={onOpen} className="row grow" style={{ textAlign: 'left' }} aria-label={`Open ${entry.name}`}>
          {content}
        </button>
      ) : (
        <div className="row grow">{content}</div>
      )}
      <button className="btn icon sm hover-action" style={{ width: 30, height: 30 }} onClick={() => bridge.reveal(entry.path)} aria-label={`Show ${entry.name} in Explorer`} title="Show in Explorer">
        <FolderOpen size={14} />
      </button>
      <button className="btn icon sm danger hover-action" style={{ width: 30, height: 30 }} onClick={() => confirmTrash(entry, onDeleted)} aria-label={`Move ${entry.name} to the Recycle Bin`} title="Move to the Recycle Bin">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function WindowsStorage() {
  const t = useTasks();
  const disks = useData<DisksInfo>('disks', () => bridge.disks(), 20000);
  const [view, setView] = useState<'folders' | 'files'>('folders');

  const volumes = disks.data?.volumes ?? [];
  const volume: Volume | undefined = volumes.find((v) => v.path === t.selectedVolume) ?? volumes.find((v) => v.system) ?? volumes[0];

  // Results and progress belong to the drive that was analyzed.
  const showingScan = !!volume && t.scanPath === volume.path;
  const scanning = t.scanRunning;
  const progress = showingScan ? t.scanProgress : null;
  const node = showingScan ? t.scanNode : null;
  const rootNode = showingScan ? t.scanRoot : null;

  const refreshAfterDelete = () => {
    void loadData('disks', () => bridge.disks());
    if (node) tasks.openNode(node.path);
  };

  const crumbs = () => {
    if (!node || !rootNode) return [] as { name: string; path: string }[];
    const root = rootNode.path;
    const out = [{ name: root.endsWith(':') ? root : rootNode.name, path: root }];
    if (node.path !== root) {
      let cur = root;
      for (const seg of node.path.slice(root.length + 1).split('\\')) {
        cur = `${cur}\\${seg}`;
        out.push({ name: seg, path: cur });
      }
    }
    return out;
  };

  const usedOnDisk = volume ? volume.total - volume.free : 0;
  const unaccounted = rootNode && volume ? Math.max(0, usedOnDisk - rootNode.size) : 0;
  const entries = node?.folders ?? [];
  const treeTotal = node ? Math.max(1, entries.reduce((s, e) => s + e.size, 0)) : 1;
  const maxFolder = Math.max(1, ...entries.map((e) => e.size));
  const fileList = node ? (node.isRoot && node.largest?.length ? node.largest : node.items) : [];
  const maxFile = Math.max(1, ...fileList.map((e) => e.size));

  return (
    <div className="stack">
      <PageHead
        title="Storage"
        subtitle="See exactly what takes up space. The analysis runs in the background, so you can keep working."
        actions={
          scanning ? (
            <button className="btn lg" onClick={() => tasks.cancelScan()}>
              <X size={16} /> Stop analysis
            </button>
          ) : (
            <button className="btn primary lg" onClick={() => volume && tasks.startScan(volume.path, volume.letter)} disabled={!volume}>
              {rootNode ? <RefreshCw size={16} /> : <ScanSearch size={17} />}
              {rootNode ? 'Analyze again' : `Analyze ${volume?.letter ?? ''}`}
            </button>
          )
        }
      />

      <div className="grid-2" style={{ gridTemplateColumns: volumes.length > 1 ? undefined : 'minmax(0,1fr)' }}>
        {volumes.map((v) => {
          const used = v.total - v.free;
          const pctUsed = (used / v.total) * 100;
          const active = volume?.path === v.path;
          return (
            <Glass as="button" key={v.path} className="volume-tile" aria-pressed={active} onClick={() => tasks.selectVolume(v.path)}>
              <div className="row between">
                <div className="row" style={{ gap: 10, minWidth: 0 }}>
                  <HardDrive size={18} style={{ flex: 'none' }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="row-title">
                      {v.letter} {v.label && `· ${v.label}`}
                    </div>
                    <div className="row-sub">{v.model ?? v.fs}</div>
                  </div>
                </div>
                {v.media && <span className="badge">{[v.media, v.bus].filter(Boolean).join(' ')}</span>}
              </div>
              <div className="capacity">
                <i style={{ width: `${pctUsed}%`, background: capacityColor(pctUsed) }} />
              </div>
              <div className="row between small">
                <span className="dim">{bytes(used)} used</span>
                <span className="num" style={{ fontWeight: 560 }}>
                  {bytes(v.free)} free of {bytes(v.total)}
                </span>
              </div>
            </Glass>
          );
        })}
      </div>

      {scanning && progress && (
        <Glass className="card">
          <div className="row between">
            <div className="row" style={{ gap: 10 }}>
              <Loader2 size={17} className="spin" />
              <span className="section-title">Analyzing {volume?.letter}</span>
            </div>
            <span className="row-value">{bytes(progress.bytes)}</span>
          </div>
          <div className="progress-track indeterminate" style={{ marginTop: 12 }}>
            <i />
          </div>
          <div className="row between small dim" style={{ marginTop: 8, gap: 16 }}>
            <span className="row-sub" style={{ flex: 1, minWidth: 0, direction: 'rtl', textAlign: 'left' }}>
              {progress.current ?? ''}
            </span>
            <span className="num" style={{ flex: 'none' }}>
              {int(progress.files)} files
            </span>
          </div>
        </Glass>
      )}

      {scanning && !showingScan && (
        <Glass className="notice">
          <div className="notice-icon">
            <Loader2 size={17} className="spin" />
          </div>
          <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
            Another drive is being analyzed. You can start this one when it finishes.
          </div>
        </Glass>
      )}

      {!scanning && !node && (
        <Glass className="card empty-state">
          <ScanSearch size={32} style={{ opacity: 0.7, marginBottom: 8 }} />
          <div style={{ fontSize: 15, fontWeight: 560, color: 'var(--ink)' }}>Analyze {volume?.letter ?? 'the drive'} to see its space map</div>
          <p style={{ margin: '4px auto 0', maxWidth: '50ch' }}>The analysis only reads the file list, at low priority so it doesn't slow your system down. A large drive can take a few minutes.</p>
        </Glass>
      )}

      {node && (
        <>
          <Glass className="card">
            <div className="row between wrap" style={{ marginBottom: 12 }}>
              <div className="crumbs">
                {crumbs().map((c, i) => (
                  <span key={c.path} className="row" style={{ gap: 4 }}>
                    {i > 0 && <ChevronRight size={13} className="muted" />}
                    <button onClick={() => tasks.openNode(c.path)}>{c.name}</button>
                  </span>
                ))}
              </div>
              <span className="row-value">
                {bytes(node.size)} · {plural(node.files, 'file', 'files')}
              </span>
            </div>
            {entries.length > 0 ? <Treemap entries={entries} total={treeTotal} onOpen={(e) => tasks.openNode(e.path)} /> : <div className="empty-state">This folder has no subfolders.</div>}
          </Glass>

          {node.isRoot && (node.denied > 0 || unaccounted > 1 << 30) && (
            <Glass className="notice">
              <div className="notice-icon">
                <Lock size={17} />
              </div>
              <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
                {unaccounted > 1 << 30 ? `Another ${bytes(unaccounted)} is taken by files the analysis can't reach (system, restore points, other users). ` : ''}
                {node.denied > 0 ? `${plural(node.denied, 'folder was', 'folders were')} denied.` : ''}
              </div>
            </Glass>
          )}

          <Glass className="card">
            <div className="row between">
              <h2 className="section-title">{view === 'folders' ? 'Folders by size' : node.isRoot ? 'Largest files on the drive' : 'Files in this folder'}</h2>
              <div className="segmented" role="group" aria-label="What to show">
                <button aria-pressed={view === 'folders'} onClick={() => setView('folders')}>
                  Folders
                </button>
                <button aria-pressed={view === 'files'} onClick={() => setView('files')}>
                  Files
                </button>
              </div>
            </div>
            <div className="list" style={{ marginTop: 6 }}>
              {view === 'folders' && entries.slice(0, 30).map((e) => <EntryRow key={e.path} entry={e} max={maxFolder} onOpen={() => tasks.openNode(e.path)} onDeleted={refreshAfterDelete} />)}
              {view === 'files' && fileList.slice(0, 40).map((e) => <EntryRow key={e.path} entry={e} max={maxFile} onDeleted={refreshAfterDelete} />)}
              {view === 'files' && fileList.length === 0 && <div className="empty-state">No files here.</div>}
              {view === 'folders' && entries.length === 0 && <div className="empty-state">No subfolders here.</div>}
            </div>
          </Glass>
        </>
      )}
    </div>
  );
}

function PermissionNotice({ title, text, action, onClick }: { title: string; text: string; action: string; onClick: () => void }) {
  return (
    <Glass className="notice">
      <div className="notice-icon">
        <Settings2 size={18} />
      </div>
      <div className="grow">
        <div className="row-title" style={{ whiteSpace: 'normal' }}>
          {title}
        </div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>
          {text}
        </div>
      </div>
      <button className="btn sm" onClick={onClick}>
        {action}
      </button>
    </Glass>
  );
}

function AndroidStorageView() {
  const storage = useData<AndroidStorage>('androidStorage', () => bridge.android!.storage(), 45000);
  const s = storage.data;

  // Coming back from the permissions screen reloads the data.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void storage.reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const used = s ? s.total - s.free : 0;
  const pctUsed = s ? (used / s.total) * 100 : 0;
  const apps = s?.apps ?? [];
  const appsTotal = apps.reduce((a, b) => a + b.totalBytes, 0);
  const media = s?.media;
  const maxApp = Math.max(1, ...apps.map((a) => a.totalBytes));

  const parts = s
    ? [
        { name: 'Apps', value: appsTotal, color: 'var(--s1)' },
        { name: 'Images', value: media?.images ?? 0, color: 'var(--s2)' },
        { name: 'Video', value: media?.video ?? 0, color: 'var(--s3)' },
        { name: 'Audio and documents', value: (media?.audio ?? 0) + (media?.documents ?? 0), color: 'var(--s4)' },
      ].filter((p) => p.value > 0)
    : [];
  const known = parts.reduce((a, b) => a + b.value, 0);

  return (
    <div className="stack">
      <PageHead title="Storage" subtitle="What's taking up space on your phone." />
      <Glass className="card">
        <div className="row between">
          <div className="tile-value" style={{ fontSize: 40 }}>
            {s ? bytes(s.free) : '—'}
          </div>
          <span className="dim">{s ? `free of ${bytes(s.total)}` : ''}</span>
        </div>
        <div className="capacity" style={{ height: 12, display: 'flex', gap: 2, background: 'rgba(255,255,255,.08)' }} role="img" aria-label="Used space by category">
          {parts.map((p) => (
            <i key={p.name} style={{ width: `${(p.value / (s?.total ?? 1)) * 100}%`, background: p.color }} />
          ))}
          {s && used > known && <i style={{ width: `${((used - known) / s.total) * 100}%`, background: 'rgba(255,255,255,.28)' }} />}
        </div>
        <div className="legend">
          {parts.map((p) => (
            <div className="legend-row" key={p.name}>
              <i className="dot" style={{ background: p.color }} />
              <div className="row-title">{p.name}</div>
              <div className="row-value">{bytes(p.value)}</div>
            </div>
          ))}
          {s && (
            <div className="legend-row">
              <i className="dot" style={{ background: 'rgba(255,255,255,.28)' }} />
              <div className="row-title">System and other</div>
              <div className="row-value">{bytes(Math.max(0, used - known))}</div>
            </div>
          )}
        </div>
        {!s && storage.loading && (
          <div className="row" style={{ marginTop: 10 }}>
            <Loader2 size={16} className="spin" /> Calculating…
          </div>
        )}
        {!s && !storage.loading && (
          <p className="dim" style={{ marginBottom: 0 }}>
            Storage couldn't be read{storage.error ? `: ${storage.error}` : '.'} Coming back to this screen will try again.
          </p>
        )}
        {pctUsed > 90 && <p className="section-sub">Storage is almost full. Start with the large apps below.</p>}
      </Glass>

      {s && !s.usageAccess && <PermissionNotice title="See the size of every app" text="Android requires usage access to measure them." action="Grant" onClick={() => bridge.android?.requestUsageAccess()} />}
      {s && !s.allFiles && <PermissionNotice title="Find your largest files" text="For photos, videos and downloads, Android requires access to all files." action="Grant" onClick={() => bridge.android?.requestAllFiles()} />}

      {apps.length > 0 && (
        <Glass className="card">
          <h2 className="section-title">Apps by size</h2>
          <div className="list" style={{ marginTop: 6 }}>
            {apps.slice(0, 30).map((a) => (
              <button className="list-row" key={a.packageName} onClick={() => bridge.android?.openAppInfo(a.packageName)}>
                <AppIcon title={a.label} path={a.packageName} />
                <div className="grow">
                  <div className="row between" style={{ gap: 8 }}>
                    <div className="row-title">{a.label}</div>
                    <div className="row-value">{bytes(a.totalBytes)}</div>
                  </div>
                  <Bar value={(a.totalBytes / maxApp) * 100} />
                </div>
                <ChevronRight size={16} className="row-chev" />
              </button>
            ))}
          </div>
        </Glass>
      )}

      {(s?.largest ?? []).length > 0 && (
        <Glass className="card">
          <h2 className="section-title">Largest files</h2>
          <div className="list" style={{ marginTop: 6 }}>
            {s!.largest.slice(0, 20).map((f) => (
              <div className="list-row" key={f.path}>
                <FileIcon size={18} className="dim" style={{ flex: 'none' }} />
                <div className="grow">
                  <div className="row-title">{f.name}</div>
                  <div className="row-sub">{f.path}</div>
                </div>
                <div className="row-value">{bytes(f.size)}</div>
              </div>
            ))}
          </div>
        </Glass>
      )}
    </div>
  );
}

export function Storage() {
  return bridge.platform === 'android' ? <AndroidStorageView /> : <WindowsStorage />;
}
