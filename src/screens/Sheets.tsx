import { useEffect, useState } from 'react';
import { bridge } from '../lib/bridge';
import { bytes } from '../lib/format';
import { store, useSettings } from '../lib/store';
import { tasks, useTasks } from '../lib/tasks';
import type { ProcessItem } from '../lib/types';
import { Segmented, SheetClose, Switch, openSheet, toast } from '../ui/kit';
import { UpdateSettings } from './Updates';

export function requestElevation(close?: () => void) {
  void bridge.win?.elevate().then((r) => {
    if (!r.ok) toast("Windows didn't grant administrator rights.", 'info');
    else close?.();
  });
}

export function ElevateSheet({ close }: { close: () => void }) {
  return (
    <>
      <SheetClose onClose={close} />
      <h2>Full mode</h2>
      <p>With administrator rights, G Ultra can also:</p>
      <ul className="bullets" style={{ marginTop: 12 }}>
        <li>Read the real CPU temperature and control fans</li>
        <li>Clear the RAM standby cache, the step that frees the most memory</li>
        <li>Clean system folders: Windows Temp, Windows Update, Delivery Optimization</li>
        <li>Change graphics card limits and read SMART data from SATA drives</li>
      </ul>
      <p>Windows will ask you to confirm, then the app restarts. Critical system components stay protected.</p>
      <div className="sheet-actions">
        <button className="btn" onClick={close}>
          Not now
        </button>
        <button className="btn primary" onClick={() => requestElevation(close)}>
          Restart as administrator
        </button>
      </div>
    </>
  );
}

export function SettingsSheet({ close }: { close: () => void }) {
  const settings = useSettings();
  return (
    <>
      <SheetClose onClose={close} />
      <h2>Settings</h2>
      <div className="list" style={{ marginTop: 14 }}>
        <div className="list-row">
          <div className="grow">
            <div className="row-title">Fluid animations</div>
            <div className="row-sub" style={{ whiteSpace: 'normal' }}>
              {bridge.platform === 'android' ? 'Off by default, because they can make phones slower and use more battery.' : 'The background and liquid use a little CPU. You can freeze them.'}
            </div>
          </div>
          <Switch checked={settings.motion} onChange={(motion) => store.setSettings({ motion })} label="Fluid animations" />
        </div>
        {bridge.platform !== 'android' && (
          <div className="list-row">
            <div className="grow">
              <div className="row-title">Refresh rate</div>
              <div className="row-sub">How often sensors are read</div>
            </div>
            <Segmented
              label="Refresh rate"
              value={String(settings.intervalMs)}
              options={[
                { value: '1000', label: '1 s' },
                { value: '1500', label: '1.5 s' },
                { value: '3000', label: '3 s' },
              ]}
              onChange={(v) => store.setSettings({ intervalMs: Number(v) })}
            />
          </div>
        )}
        <UpdateSettings />
      </div>
    </>
  );
}

// One-tap optimize. It starts the jobs and steps out of the way: they run in the background.
export function OptimizeSheet({ close }: { close: () => void }) {
  const isAndroid = bridge.platform === 'android';
  const t = useTasks();
  const [ram, setRam] = useState(true);
  const [clean, setClean] = useState(true);

  useEffect(() => {
    if (!isAndroid && t.categories.length === 0) t.scanCleanable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const safe = t.categories.filter((c) => c.defaultOn && !c.needsAdmin && (c.bytes ?? 0) > 0);
  const total = safe.reduce((s, c) => s + (c.bytes ?? 0), 0);
  const pending = t.categories.filter((c) => c.bytes == null).length;

  const start = () => {
    tasks.optimize(ram, clean && !isAndroid ? safe.map((c) => c.id) : []);
    close();
  };

  return (
    <>
      <SheetClose onClose={close} />
      <h2>Optimize</h2>
      <p>Choose what G Ultra should do. This runs in the background, so you can keep using your computer.</p>
      <div className="list" style={{ marginTop: 12 }}>
        <div className="list-row">
          <div className="grow">
            <div className="row-title">Free up RAM</div>
            <div className="row-sub" style={{ whiteSpace: 'normal' }}>
              {isAndroid ? 'Closes background processes, as far as Android allows.' : "Clears memory apps aren't actively using, without closing them."}
            </div>
          </div>
          <Switch checked={ram} onChange={setRam} label="Free up RAM" />
        </div>
        {!isAndroid && (
          <div className="list-row">
            <div className="grow">
              <div className="row-title">Clean safe caches</div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                {t.categories.length === 0 ? (
                  'Measuring…'
                ) : (
                  <>
                    Can free <strong style={{ color: 'var(--ink)' }}>{bytes(total)}</strong>
                    {pending > 0 ? ' so far' : ''} from {safe.length} categories. Passwords and history stay. See the full list in Cleanup.
                  </>
                )}
              </div>
            </div>
            <Switch checked={clean} onChange={setClean} disabled={safe.length === 0} label="Clean safe caches" />
          </div>
        )}
      </div>
      <div className="sheet-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ram && !(clean && safe.length)} onClick={start}>
          Start
        </button>
      </div>
    </>
  );
}

// ---- closing an app ----
export function confirmEndProcess(p: ProcessItem) {
  openSheet((close) => (
    <>
      <SheetClose onClose={close} />
      <h2>Close {p.title}?</h2>
      <p>
        G Ultra asks the app to close normally, so it can save your work.{' '}
        {p.pids.length > 1 ? `That's ${p.pids.length} processes using ${bytes(p.mem)} of RAM.` : `It's using ${bytes(p.mem)} of RAM.`}
      </p>
      <div className="sheet-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={() => {
            close();
            void endGracefully(p);
          }}
        >
          Close app
        </button>
      </div>
    </>
  ));
}

async function endGracefully(p: ProcessItem) {
  try {
    const r = await tasks.run({ id: `end-${p.key}`, label: `Closing ${p.title}`, route: 'memory' }, () => bridge.endProcess(p.pids, false));
    if (r.remaining === 0) toast(`${p.title} closed.`);
    else
      openSheet((close) => (
        <>
          <SheetClose onClose={close} />
          <h2>{p.title} is still running</h2>
          <p>
            {r.remaining === 1 ? "One process didn't close by itself" : `${r.remaining} processes didn't close by themselves`}. They may be background processes, or the app may be waiting for you to save something. Forcing them to stop loses any unsaved work.
          </p>
          <div className="sheet-actions">
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button
              className="btn solid-danger"
              onClick={() => {
                close();
                void endForced(p);
              }}
            >
              Force stop
            </button>
          </div>
        </>
      ));
  } catch (e) {
    toast(`Couldn't close it: ${(e as Error).message}`, 'warning');
  }
}

async function endForced(p: ProcessItem) {
  try {
    const r = await tasks.run({ id: `end-${p.key}`, label: `Stopping ${p.title}`, route: 'memory' }, () => bridge.endProcess(p.pids, true));
    if (r.failed > 0) toast(`${r.closed} stopped, ${r.failed} refused. Those need full mode.`, 'warning');
    else toast(`${p.title} stopped.`);
  } catch (e) {
    toast(`Couldn't stop it: ${(e as Error).message}`, 'warning');
  }
}
