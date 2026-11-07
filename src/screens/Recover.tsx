import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ArchiveRestore, Check, CircleX, ExternalLink, Folder, Info, Loader2, Search, Trash2 } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes } from '../lib/format';
import { loadData, useData } from '../lib/store';
import { useTasks } from '../lib/tasks';
import type { AndroidPermissions, BinItem, PhoneTrash, RecoverDrives } from '../lib/types';
import { Glass, PageHead, Segmented, Switch, toast } from '../ui/kit';
import { requestElevation } from './Sheets';

const date = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown date');

function Notice({ icon: Icon, children }: { icon: typeof Info; children: ReactNode }) {
  return (
    <Glass className="notice">
      <div className="notice-icon">
        <Icon size={17} />
      </div>
      <div className="grow row-sub" style={{ whiteSpace: 'normal' }}>
        {children}
      </div>
    </Glass>
  );
}

// ---- Windows: Recycle Bin ----
function BinPanel() {
  const data = useData<BinItem[]>('recycleBin', () => bridge.win!.binList(), 10000);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = () => void loadData('recycleBin', () => bridge.win!.binList());

  const all = data.data ?? [];
  const list = search ? all.filter((i) => `${i.name} ${i.original}`.toLowerCase().includes(search.toLowerCase())) : all;
  const shown = list.slice(0, 200);

  const restore = async (ids: string[]) => {
    setBusy(true);
    try {
      const r = await bridge.win!.binRestore(ids);
      const failed = r.filter((x) => !x.ok);
      if (failed.length) toast(`${r.length - failed.length} restored, ${failed.length} failed: ${failed[0].message}`, 'warning');
      else toast(r.length === 1 ? 'Restored to its original folder.' : `${r.length} items restored to their original folders.`);
    } catch (e) {
      toast((e as Error).message, 'warning');
    }
    setBusy(false);
    reload();
  };

  return (
    <Glass className="card">
      <div className="row between wrap" style={{ gap: 10 }}>
        <div>
          <h2 className="section-title">Recycle Bin</h2>
          <p className="section-sub">{data.data ? `${all.length} items. Restoring puts them back exactly where they were.` : 'Reading the Recycle Bin…'}</p>
        </div>
        {list.length > 1 && (
          <button className="btn sm" disabled={busy} onClick={() => void restore(list.map((i) => i.id))}>
            {search ? `Restore ${list.length} found` : 'Restore all'}
          </button>
        )}
      </div>
      {all.length > 0 && <SearchBox value={search} onChange={setSearch} />}
      {data.data && all.length === 0 && <div className="empty-state">The Recycle Bin is empty. If you emptied it or deleted files with Shift + Delete, try Deep scan.</div>}
      <div className="list" style={{ marginTop: 6 }}>
        {shown.map((i) => (
          <div className="list-row" key={i.id}>
            {i.isDir ? <Folder size={18} className="dim" style={{ flex: 'none' }} /> : <Trash2 size={18} className="dim" style={{ flex: 'none' }} />}
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row-title">{i.name}</div>
              <div className="row-sub" title={i.original}>
                {bytes(i.size)} · deleted {date(i.deletedMs)} · {i.original}
              </div>
            </div>
            <button className="btn sm" disabled={busy} onClick={() => void restore([i.id])}>
              Restore
            </button>
          </div>
        ))}
      </div>
      {list.length > shown.length && <p className="section-sub" style={{ marginTop: 10 }}>Showing the newest 200. Search to find others.</p>}
    </Glass>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="row" style={{ gap: 8, marginTop: 12 }}>
      <Search size={15} className="dim" style={{ flex: 'none' }} />
      <input className="grow" type="search" placeholder="Search by name or folder" aria-label="Search" value={value} onChange={(e) => onChange(e.target.value)} style={{ background: 'transparent', border: 0, outline: 0, color: 'inherit', font: 'inherit', minWidth: 0, width: '100%' }} />
    </div>
  );
}

// ---- Windows: deep scan ----
const CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'pictures', label: 'Pictures' },
  { value: 'videos', label: 'Videos' },
  { value: 'documents', label: 'Documents' },
  { value: 'music', label: 'Music' },
  { value: 'archives', label: 'Archives' },
];

const CHANCE: Record<string, { label: string; color: string }> = {
  good: { label: 'Good chance', color: 'var(--good)' },
  unchecked: { label: 'Not checked yet', color: 'var(--ink-3)' },
  unknown: { label: 'Unknown', color: 'var(--ink-3)' },
  partial: { label: 'Partly overwritten', color: 'var(--warning)' },
  erased: { label: 'Probably erased', color: 'var(--warning)' },
};

function DeepPanel() {
  const t = useTasks();
  const drives = useData<RecoverDrives>('recoverDrives', () => bridge.win!.recoverDrives(), 30000);
  const [letter, setLetter] = useState<string | null>(null);
  const list = drives.data?.drives ?? [];
  const ntfs = list.filter((d) => d.ntfs);
  const drive = letter ?? t.recoverDrive ?? ntfs[0]?.letter ?? null;
  const elevated = drives.data?.elevated ?? false;
  const scan = t.recoverState;
  const page = t.recoverPage;
  const selected = t.recoverSelected;

  const pickAndRecover = async () => {
    const folder = await bridge.win!.pickFolder();
    if (folder) void t.recoverRun([...selected], folder);
  };

  return (
    <>
      <Notice icon={AlertTriangle}>
        <strong>Stop saving files to that drive until you're done,</strong> because new files can overwrite deleted ones. Recent deletions have the best chance. On SSDs, Windows usually erases deleted files soon after, so often nothing can be recovered, and no program can change that.
      </Notice>

      <Glass className="card">
        <h2 className="section-title">Deep scan</h2>
        <p className="section-sub">Looks through a drive's file table for deleted files. It only reads the drive, and nothing on it changes.</p>
        {drive && (
          <div style={{ marginTop: 12 }}>
            <Segmented label="Drive" disabled={scan?.state === 'running'} value={drive} options={ntfs.map((d) => ({ value: d.letter, label: `${d.letter}:${d.label ? ` ${d.label}` : ''}` }))} onChange={setLetter} />
          </div>
        )}
        {drives.data && ntfs.length === 0 && <p className="section-sub" style={{ marginTop: 12 }}>No NTFS drives found. Deep scan only works on NTFS.</p>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          {!elevated && (
            <button className="btn sm" onClick={() => requestElevation()}>
              Full mode
            </button>
          )}
          {scan?.state === 'running' ? (
            <button className="btn sm" onClick={() => t.recoverCancel()}>
              Stop
            </button>
          ) : (
            <button className="btn sm primary" disabled={!elevated || !drive} onClick={() => drive && t.recoverStart(drive)}>
              Scan {drive ? `${drive}:` : ''}
            </button>
          )}
        </div>
        {!elevated && <p className="section-sub" style={{ marginTop: 8, textAlign: 'right' }}>Scanning a drive needs full mode.</p>}
        {scan?.state === 'running' && (
          <div className="row small dim" style={{ gap: 8, marginTop: 12 }}>
            <Loader2 size={15} className="spin" />
            {scan.percent ?? 0}% · {(scan.found ?? 0).toLocaleString('en-US')} deleted files found. You can keep using the app.
          </div>
        )}
        {scan?.state === 'failed' && <p className="section-sub" style={{ marginTop: 12, color: 'var(--warning)' }}>{scan.message}</p>}
      </Glass>

      {t.recoverResult && (
        <Glass className="card">
          <h2 className="section-title">Recovered</h2>
          <p className="section-sub">
            {t.recoverResult.results.filter((r) => r.ok).length} of {t.recoverResult.results.length} saved. Open them to check them, because a file can be saved and still be damaged if parts of it were overwritten.
          </p>
          <div className="list" style={{ marginTop: 6 }}>
            {t.recoverResult.results.slice(0, 50).map((r) => (
              <div className="list-row" key={r.id}>
                {r.ok ? <Check size={18} color="var(--good)" style={{ flex: 'none' }} /> : <CircleX size={18} color="var(--warning)" style={{ flex: 'none' }} />}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row-title">{r.name}</div>
                  <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                    {r.ok ? (r.whole ? 'Saved' : 'Saved, but it may be damaged') : r.message}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn sm" onClick={() => bridge.reveal(t.recoverResult!.folder)}>
              Show folder
            </button>
          </div>
        </Glass>
      )}

      {scan?.state === 'done' && (
        <Glass className="card">
          <h2 className="section-title">Deleted files</h2>
          <p className="section-sub">
            {page ? `${page.total.toLocaleString('en-US')} found that may still be readable.` : 'Loading…'} Files that were fully overwritten aren't listed.
            {scan.truncated ? ' This drive has too many deleted files to list them all.' : ''}
          </p>
          <div style={{ marginTop: 12 }}>
            <Segmented label="File type" value={t.recoverCategory} options={CATEGORIES} onChange={(v) => t.recoverFilter(v, t.recoverSearch)} />
          </div>
          <SearchBox value={t.recoverSearch} onChange={(v) => t.recoverFilter(t.recoverCategory, v)} />
          <div className="list" style={{ marginTop: 6 }}>
            {page?.items.map((f) => (
              <div className="list-row" key={f.id}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row-title">{f.name}</div>
                  <div className="row-sub" title={f.path}>
                    {bytes(f.size)} · {date(f.modifiedMs)} · {f.path}
                  </div>
                </div>
                <span className="small" style={{ flex: 'none', color: CHANCE[f.chance]?.color }}>
                  {CHANCE[f.chance]?.label}
                </span>
                <Switch checked={selected.has(f.id)} onChange={(on) => t.recoverToggle(f.id, on)} label={`Recover ${f.name}`} />
              </div>
            ))}
          </div>
          {page && page.total > page.items.length && <p className="section-sub" style={{ marginTop: 10 }}>Showing the newest {page.items.length}. Search or choose a file type to find others.</p>}
          <p className="section-sub" style={{ marginTop: 12 }}>You'll choose a folder on a different drive, such as a USB stick, so saving can't overwrite what you're recovering.</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn sm primary" disabled={selected.size === 0 || t.recovering} onClick={() => void pickAndRecover()}>
              {t.recovering && <Loader2 size={13} className="spin" />}
              {t.recovering ? 'Recovering…' : `Recover ${selected.size}`}
            </button>
          </div>
        </Glass>
      )}
    </>
  );
}

// ---- Android ----
function PhoneRecover() {
  const perms = useData<AndroidPermissions>('androidPermissions', () => bridge.android!.permissions(), 3000);
  const trash = useData<PhoneTrash>('phoneTrash', () => bridge.android!.trashList(), 3000);
  const [busy, setBusy] = useState(false);
  const reload = () => {
    void loadData('androidPermissions', () => bridge.android!.permissions());
    void loadData('phoneTrash', () => bridge.android!.trashList());
  };

  // Android shows its own confirmation, and the list changes after it closes.
  useEffect(() => {
    const onShow = () => {
      if (!document.hidden) reload();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);

  const restore = async (uris: string[]) => {
    setBusy(true);
    try {
      await bridge.android!.trashRestore(uris);
    } catch (e) {
      toast((e as Error).message, 'warning');
    }
    setBusy(false);
  };

  const items = trash.data?.items ?? [];
  const allFiles = perms.data?.allFiles ?? false;

  return (
    <>
      <Notice icon={Info}>
        Android doesn't let any app read files that were permanently deleted unless the phone is rooted. G Ultra can bring back what's still in the system's trash, and your apps may keep their own.
      </Notice>

      <Glass className="card">
        <div className="row between wrap" style={{ gap: 10 }}>
          <div>
            <h2 className="section-title">Phone trash</h2>
            <p className="section-sub">{trash.data?.supported === false ? 'The system trash needs Android 11 or newer.' : `${items.length} items. Android deletes them for good after about 30 days.`}</p>
          </div>
          {items.length > 1 && (
            <button className="btn sm" disabled={busy} onClick={() => void restore(items.map((i) => i.uri))}>
              Restore all
            </button>
          )}
        </div>
        {!allFiles && trash.data?.supported !== false && (
          <div className="row between" style={{ marginTop: 12, gap: 10 }}>
            <span className="section-sub">To see files from other apps, allow access to all files.</span>
            <button className="btn sm" onClick={() => bridge.android?.requestAllFiles()}>
              Allow
            </button>
          </div>
        )}
        {trash.data?.supported !== false && trash.data && items.length === 0 && <div className="empty-state">Nothing in the trash.</div>}
        <div className="list" style={{ marginTop: 6 }}>
          {items.slice(0, 200).map((i) => (
            <div className="list-row" key={i.uri}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row-title">{i.name}</div>
                <div className="row-sub">
                  {bytes(i.size)}
                  {i.expiresMs > 0 ? ` · removed for good on ${date(i.expiresMs)}` : ''}
                </div>
              </div>
              <button className="btn sm" disabled={busy} onClick={() => void restore([i.uri])}>
                Restore
              </button>
            </div>
          ))}
        </div>
      </Glass>

      <Glass className="card">
        <h2 className="section-title">Other places to look</h2>
        <div className="list" style={{ marginTop: 6 }}>
          <button className="list-row" onClick={() => bridge.openLink('https://photos.google.com/trash')}>
            <ArchiveRestore size={18} className="dim" style={{ flex: 'none' }} />
            <div className="grow">
              <div className="row-title">Google Photos trash</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                Backed-up photos stay here for up to 60 days
              </div>
            </div>
            <ExternalLink size={15} className="row-chev" />
          </button>
        </div>
        <ul className="bullets" style={{ marginTop: 12 }}>
          <li>Check the Trash or Recently deleted album in your phone's Gallery app.</li>
          <li>Check the Trash in your Files app.</li>
          <li>Check your cloud backups, such as Google Drive or your phone maker's cloud.</li>
        </ul>
      </Glass>
    </>
  );
}

export function Recover() {
  const isAndroid = bridge.platform === 'android';
  const [tab, setTab] = useState('bin');
  return (
    <div className="stack">
      <PageHead title="Recover" subtitle={isAndroid ? 'Bring back files that are still in the trash.' : 'Bring back deleted files from the Recycle Bin, or look for them on the drive.'} />
      {isAndroid ? (
        <PhoneRecover />
      ) : (
        <>
          <Segmented
            label="Recovery type"
            value={tab}
            options={[
              { value: 'bin', label: 'Recycle Bin' },
              { value: 'deep', label: 'Deep scan' },
            ]}
            onChange={setTab}
          />
          {tab === 'bin' ? <BinPanel /> : <DeepPanel />}
        </>
      )}
    </div>
  );
}
