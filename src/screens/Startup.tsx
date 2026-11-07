import { useState } from 'react';
import { Lock } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { useData } from '../lib/store';
import type { StartupApp } from '../lib/types';
import { AppIcon, Glass, Switch, toast } from '../ui/kit';

// Apps that launch with Windows. Same on/off switch Task Manager uses, so nothing gets deleted.
export function StartupApps() {
  const apps = useData<StartupApp[]>('startup', () => bridge.win!.startupList(), 30000);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const list = apps.data ?? [];
  if (list.length === 0) return null;

  const toggle = (app: StartupApp, on: boolean) => {
    setOverrides((o) => ({ ...o, [app.id]: on }));
    bridge.win?.startupSet(app.id, on).catch((e: Error) => {
      toast(e.message, 'warning');
      setOverrides((o) => ({ ...o, [app.id]: !on }));
    });
  };

  return (
    <Glass className="card">
      <h2 className="section-title">Apps that start with Windows</h2>
      <p className="section-sub">Fewer of these means less memory in use, longer battery life and a faster boot. It only takes effect the next time you sign in.</p>
      <div className="list" style={{ marginTop: 6 }}>
        {list.map((a) => (
          <div className="list-row" key={a.id}>
            <AppIcon title={a.title} path={a.path} />
            <div className="grow row-title" title={a.path ?? undefined}>
              {a.title}
            </div>
            {a.needsAdmin && (
              <span className="badge">
                <Lock size={10} /> admin
              </span>
            )}
            <Switch checked={overrides[a.id] ?? a.enabled} disabled={a.needsAdmin} onChange={(v) => toggle(a, v)} label={`Start ${a.title} with Windows`} />
          </div>
        ))}
      </div>
    </Glass>
  );
}
