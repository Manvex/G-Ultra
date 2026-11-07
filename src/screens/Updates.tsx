import { CircleArrowUp, Loader2 } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { bytes } from '../lib/format';
import { store, useSettings } from '../lib/store';
import { useTasks } from '../lib/tasks';
import { Glass, Switch } from '../ui/kit';

// Appears above every screen when a new version is out.
export function UpdateBanner() {
  const t = useTasks();
  const u = t.update;
  if (!u?.available || t.updateDismissed) return null;
  const isAndroid = bridge.platform === 'android';
  const hint = isAndroid ? 'Android will ask you to confirm the install.' : "G Ultra restarts when it's done. Windows may ask you to confirm.";
  return (
    <Glass className="notice" style={{ marginBottom: 14 }}>
      <div className="notice-icon" style={{ background: 'rgba(100,210,255,.14)' }}>
        <CircleArrowUp size={18} color="var(--info)" />
      </div>
      <div className="grow">
        <div className="row-title">G Ultra {u.version} is available</div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>
          {t.updateInstalling ? `Downloading… ${t.updatePercent}%` : `${u.size ? `${bytes(u.size)}. ` : ''}${hint}`}
        </div>
      </div>
      {!t.updateInstalling && (
        <>
          <button className="btn sm" onClick={() => t.dismissUpdate()}>
            Later
          </button>
          {u.page && (
            <button className="btn sm" onClick={() => bridge.openLink(u.page!)}>
              What's new
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
