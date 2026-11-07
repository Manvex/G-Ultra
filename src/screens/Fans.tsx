import { useEffect, useRef, useState } from 'react';
import { Fan, ShieldCheck } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { int } from '../lib/format';
import { useLive, useSystem } from '../lib/store';
import type { FanInfo } from '../lib/types';
import { Glass, Segmented, Slider, Switch, toast } from '../ui/kit';
import { requestElevation } from './Sheets';

const PRESETS: { value: string; label: string; percent: number | null }[] = [
  { value: 'auto', label: 'Auto', percent: null },
  { value: 'quiet', label: 'Quiet', percent: 35 },
  { value: 'balanced', label: 'Balanced', percent: 55 },
  { value: 'full', label: 'Full', percent: 100 },
];

function fanError(e: unknown) {
  toast((e as Error).message, 'warning');
}

function FanRow({ fan }: { fan: FanInfo }) {
  // The slider keeps its own value while dragging; the fan is only written to once it settles.
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const value = draft ?? fan.percent ?? fan.minPercent;

  const apply = (v: number) => {
    setDraft(v);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      bridge.win
        ?.fanSet(fan.id, v)
        .catch(fanError)
        .finally(() => {
          // Leave time for the next live sample to show the new value.
          timer.current = window.setTimeout(() => setDraft(null), 2000);
        });
    }, 250);
  };

  const setAuto = (auto: boolean) => {
    if (auto) {
      setDraft(null);
      bridge.win?.fanAuto(fan.id).catch(fanError);
    } else {
      apply(Math.max(fan.minPercent, Math.round(fan.percent ?? 50)));
    }
  };

  return (
    <div className="fan-row">
      <div className="row between">
        <div className="row" style={{ gap: 10, minWidth: 0 }}>
          <Fan size={18} className={fan.rpm ? 'dim' : 'muted'} style={{ flex: 'none' }} />
          <div style={{ minWidth: 0 }}>
            <div className="row-title">{fan.name}</div>
            <div className="row-sub">{fan.hardware}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 12, flex: 'none' }}>
          <div className="row-value">{fan.rpm != null ? `${int(fan.rpm)} RPM` : fan.percent != null ? `${Math.round(fan.percent)}%` : '—'}</div>
          {fan.canControl ? (
            <div className="row" style={{ gap: 8 }}>
              <span className="label">Auto</span>
              <Switch checked={!fan.manual && draft == null} onChange={setAuto} label={`Automatic control for ${fan.name}`} />
            </div>
          ) : (
            <span className="badge">read only</span>
          )}
        </div>
      </div>
      {fan.canControl && (fan.manual || draft != null) && (
        <div className="row" style={{ marginTop: 10, gap: 12 }}>
          <Slider value={value} min={fan.minPercent} max={fan.maxPercent} onChange={apply} label={`Speed of ${fan.name}`} />
          <div className="row-value" style={{ width: 44 }}>
            {Math.round(value)}%
          </div>
        </div>
      )}
    </div>
  );
}

export function FanPanel({ group }: { group?: 'gpu' }) {
  const live = useLive();
  const system = useSystem();
  const fans = (live?.fans ?? []).filter((f) => (group ? f.group === group : true));
  const controllable = fans.filter((f) => f.canControl);
  const driver = system?.sensorDriver;
  const allAuto = controllable.every((f) => !f.manual);

  const preset = (percent: number | null) => {
    if (percent == null) {
      bridge.win?.fanAutoAll().catch(fanError);
      return;
    }
    for (const f of controllable) bridge.win?.fanSet(f.id, percent).catch(fanError);
  };

  let empty: string | null = null;
  if (controllable.length === 0) {
    if (driver && !driver.elevated) empty = 'Fan control needs full mode.';
    else if (group === 'gpu') empty = fans.length > 0 ? "This card's fan speed can't be changed from Windows." : 'No graphics card fan was found. Integrated graphics share the system cooling.';
    else if (system?.isLaptop) empty = "This laptop's firmware controls its fans. Laptop makers don't offer apps a safe way to change the speed, so G Ultra shows what it can read and leaves control to the firmware.";
    else empty = 'No controllable fans were found. Some motherboards hide fan control until "Smart Fan" is set to manual in the BIOS.';
  }

  return (
    <Glass className="card">
      <div className="row between wrap">
        <div>
          <h2 className="section-title">{group === 'gpu' ? 'Graphics card fans' : 'Fans'}</h2>
          {controllable.length > 0 && <p className="section-sub">Applies instantly and goes back to automatic when you close G Ultra.</p>}
        </div>
        {controllable.length > 0 && (
          <Segmented
            label="Fan preset"
            value={allAuto ? 'auto' : ''}
            options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
            onChange={(v) => preset(PRESETS.find((p) => p.value === v)!.percent)}
          />
        )}
      </div>

      {fans.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {fans.map((f) => (
            <FanRow key={f.id} fan={f} />
          ))}
        </div>
      )}

      {empty && (
        <div className="row" style={{ marginTop: 10, alignItems: 'flex-start' }}>
          <p className="section-sub" style={{ margin: 0, maxWidth: '68ch' }}>
            {empty}
          </p>
          {driver && !driver.elevated && (
            <button className="btn sm" style={{ flex: 'none', marginLeft: 'auto' }} onClick={() => requestElevation()}>
              Full mode
            </button>
          )}
        </div>
      )}

      {controllable.length > 0 && (
        <div className="row small dim" style={{ marginTop: 10, gap: 8, alignItems: 'flex-start' }}>
          <ShieldCheck size={15} color="var(--good)" style={{ flex: 'none', marginTop: 1 }} />
          <span>Safety limits: fans never drop below 30%, and they return to automatic if the CPU or GPU reaches 90°C.</span>
        </div>
      )}
    </Glass>
  );
}
