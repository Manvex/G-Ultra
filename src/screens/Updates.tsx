import { useEffect } from 'react';
import { CircleArrowUp, Loader2, RefreshCw } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes } from '../lib/format';
import { store, useSettings } from '../lib/store';
import { useTasks } from '../lib/tasks';
import { Glass, SheetClose, Switch, openSheet } from '../ui/kit';

function UpdateSheet({ close }: { close: () => void }) {
  const t = useTasks();
  const u = t.update;
  if (!u) return null;
  const failed = t.updateFailed || !!u.lastAttemptFailed;
  return (
    <>
      <SheetClose onClose={close} />
      <h2>Update available</h2>
      <p>
        G Ultra {u.version} is ready to install. You have version {u.current}.{u.size ? ` The download is ${bytes(u.size)}.` : ''}
      </p>
      <p>
        {failed
          ? "The last update didn't finish. Try again, or download it from GitHub."
          : bridge.platform === 'android'
            ? 'Android will ask you to confirm the install.'
            : 'A setup window shows the progress, then G Ultra reopens by itself.'}
      </p>
      <div className="sheet-actions">
        <button
          className="btn"
          onClick={() => {
            t.dismissUpdate();
            close();
          }}
        >
          Later
        </button>
        {u.page && (
          <button className="btn" onClick={() => bridge.openLink(u.page!)}>
            {failed ? 'Download' : "What's new"}
          </button>
        )}
        <button
          className="btn primary"
          onClick={() => {
            t.showUpdateBanner();
            close();
            void t.installUpdate();
          }}
        >
          Update
        </button>
      </div>
    </>
  );
}

const openUpdateSheet = () => openSheet((close) => <UpdateSheet close={close} />);

// The popup shows once for each new version, however it was found.
let announcedVersion: string | null = null;

export function UpdatePopup() {
  const t = useTasks();
  const version = t.update?.available ? t.update.version : null;
  useEffect(() => {
    if (!version || version === announcedVersion || t.updateInstalling) return;
    announcedVersion = version;
    openUpdateSheet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return null;
}

export function UpdateButton() {
  const t = useTasks();
  const u = t.update;
  const available = !!u?.available;
  const title = t.updateInstalling ? `Updating… ${t.updatePercent}%` : t.updateChecking ? 'Checking…' : available ? 'Update available' : 'Check for updates';
  const detail = available ? `Version ${u!.version}` : `Version ${__APP_VERSION__}`;
  const busy = t.updateInstalling || t.updateChecking;
  return (
    <button
      className="mode-pill"
      disabled={busy}
      aria-label={title}
      onClick={() => {
        if (available) openUpdateSheet();
        else void t.checkUpdate(true);
      }}
    >
      {busy ? <Loader2 size={18} className="spin" style={{ flex: 'none' }} /> : available ? <CircleArrowUp size={18} color="var(--info)" style={{ flex: 'none' }} /> : <RefreshCw size={18} style={{ flex: 'none' }} />}
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </button>
  );
}

// Appears above every screen when a new version is out.
export function UpdateBanner() {
  const t = useTasks();
  const u = t.update;
  if (!u?.available || t.updateDismissed) return null;
  const isAndroid = bridge.platform === 'android';
  const failed = t.updateFailed || !!u.lastAttemptFailed;
  const hint = failed
    ? "The last update didn't finish. Try again, or download it from GitHub."
    : isAndroid
      ? 'Android will ask you to confirm the install.'
      : "A setup window shows the progress, then G Ultra reopens by itself. Windows may ask you to confirm.";
  const progress = t.updatePercent >= 100 ? 'Starting the install…' : `Downloading… ${t.updatePercent}%`;
  return (
    <Glass className="notice" style={{ marginBottom: 14 }}>
      <div className="notice-icon" style={{ background: 'rgba(100,210,255,.14)' }}>
        <CircleArrowUp size={18} color="var(--info)" />
      </div>
      <div className="grow">
        <div className="row-title">G Ultra {u.version} is available</div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>
          {t.updateInstalling ? progress : `${u.size ? `${bytes(u.size)}. ` : ''}${hint}`}
        </div>
      </div>
      {!t.updateInstalling && (
        <>
          <button className="btn sm" onClick={() => t.dismissUpdate()}>
            Later
          </button>
          {u.page && (
            <button className="btn sm" onClick={() => bridge.openLink(u.page!)}>
              {failed ? 'Download' : "What's new"}
            </button>
          )}
        </>
      )}
      <button className="btn sm primary" disabled={t.updateInstalling} onClick={() => void t.installUpdate()}>
        {t.updateInstalling && <Loader2 size={13} className="spin" />}
        Update
      </button>
    </Glass>
  );
}

export function UpdateSettings() {
  const t = useTasks();
  const settings = useSettings();
  const u = t.update;
  return (
    <>
      <div className="list-row">
        <div className="grow">
          <div className="row-title">Check for updates automatically</div>
          <div className="row-sub" style={{ whiteSpace: 'normal' }}>
            Nothing installs until you press Update.
          </div>
        </div>
        <Switch checked={settings.autoUpdate} onChange={(autoUpdate) => store.setSettings({ autoUpdate })} label="Check for updates automatically" />
      </div>
      <div className="list-row">
        <div className="grow">
          <div className="row-title">G Ultra {__APP_VERSION__}</div>
          <div className="row-sub" style={{ whiteSpace: 'normal' }}>
            {u?.available ? `Version ${u.version} is available.` : bridge.platform === 'android' ? 'Your data stays on your phone. G Ultra only goes online for its own updates.' : 'Your data stays on your PC. G Ultra only goes online for its own updates and, on the Drivers screen, Windows Update. Sensors use LibreHardwareMonitor (MPL-2.0) and the PawnIO driver.'}
          </div>
        </div>
        {u?.available ? (
          <button className="btn sm primary" disabled={t.updateInstalling} onClick={() => void t.installUpdate()}>
            {t.updateInstalling ? `${t.updatePercent}%` : 'Update'}
          </button>
        ) : (
          <button className="btn sm" disabled={t.updateChecking} onClick={() => void t.checkUpdate(true)}>
            {t.updateChecking && <Loader2 size={13} className="spin" />}
            {t.updateChecking ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>
    </>
  );
}
