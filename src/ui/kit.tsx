import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { bridge } from '../lib/bridge';

export function Glass({ children, className = '', style, as: As = 'div', ...rest }: any) {
  return (
    <As className={`glass ${className}`} style={style} {...rest}>
      {children}
    </As>
  );
}

// The sheen that follows the cursor: one listener for the whole app.
export function useSheen() {
  useEffect(() => {
    let current: HTMLElement | null = null;
    const move = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest?.('.glass') as HTMLElement | null;
      if (el !== current) {
        current?.style.setProperty('--sheen', '0');
        current = el;
        current?.style.setProperty('--sheen', '1');
      }
      if (el) {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${e.clientX - r.left}px`);
        el.style.setProperty('--my', `${e.clientY - r.top}px`);
      }
    };
    if (window.matchMedia('(hover: hover)').matches) window.addEventListener('pointermove', move, { passive: true });
    return () => window.removeEventListener('pointermove', move);
  }, []);
}

export function PageHead({ kicker, title, subtitle, actions }: { kicker?: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="grow">
        {kicker && <div className="kicker">{kicker}</div>}
        <h1 className="title">{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </header>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step = 1, onChange, onCommit, disabled, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: (v: number) => void; disabled?: boolean; label: string }) {
  const pctValue = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className="slider"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      style={{ ['--v' as string]: `${pctValue}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
    />
  );
}

export function Stat({ value, label, style }: { value: ReactNode; label: string; style?: CSSProperties }) {
  return (
    <div className="stat" style={style}>
      <div className="v">{value}</div>
      <div className="k">{label}</div>
    </div>
  );
}

export function Bar({ value, color = 'var(--s1)' }: { value: number; color?: string }) {
  return (
    <div className="bar">
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
    </div>
  );
}

export function Ring({ value, size = 104, stroke = 9, color = 'var(--good)', children }: { value: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(id);
  }, [value]);
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.09)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(100, shown)) / 100)} />
      </svg>
      <div className="ring-label">{children}</div>
    </div>
  );
}

const hashColor = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `linear-gradient(145deg, hsl(${h} 42% 46%), hsl(${(h + 34) % 360} 46% 32%))`;
};

const iconRequests = new Map<string, Promise<string | null>>();

function iconFor(path: string) {
  let req = iconRequests.get(path);
  if (!req) {
    req = bridge.fileIcon(path);
    iconRequests.set(path, req);
  }
  return req;
}

export function AppIcon({ title, path, icon }: { title: string; path?: string | null; icon?: string | null }) {
  const [src, setSrc] = useState<string | null>(icon ?? null);
  useEffect(() => {
    if (icon) {
      setSrc(icon);
      return;
    }
    if (!path) return;
    let alive = true;
    iconFor(path).then((u) => {
      if (alive) setSrc(u);
    });
    return () => {
      alive = false;
    };
  }, [path, icon]);
  if (src) {
    return (
      <div className="app-icon" style={{ background: 'rgba(255,255,255,.07)' }}>
        <img src={src} alt="" />
      </div>
    );
  }
  return (
    <div className="app-icon" style={{ background: hashColor(title) }} aria-hidden="true">
      {title.charAt(0).toUpperCase()}
    </div>
  );
}

// ---- sheets and toasts ----
type SheetRender = (close: () => void) => ReactNode;
type ToastKind = 'good' | 'warning' | 'info';
interface ToastData {
  id: number;
  text: string;
  kind: ToastKind;
}

let openSheetFn: ((r: SheetRender) => void) | null = null;
let closeSheetFn: (() => boolean) | null = null;
let pushToastFn: ((t: ToastData) => void) | null = null;
let toastId = 1;

export const openSheet = (render: SheetRender) => openSheetFn?.(render);
/** Closes the open sheet. Returns false if there wasn't one. */
export const closeSheet = () => closeSheetFn?.() ?? false;
export const toast = (text: string, kind: ToastKind = 'good') => pushToastFn?.({ id: toastId++, text, kind });

export function Overlays() {
  const [sheet, setSheet] = useState<SheetRender | null>(null);
  const [t, setT] = useState<ToastData | null>(null);
  const timer = useRef<number>(0);
  const sheetOpen = useRef(false);
  sheetOpen.current = sheet != null;

  useEffect(() => {
    openSheetFn = (r) => setSheet(() => r);
    closeSheetFn = () => {
      if (!sheetOpen.current) return false;
      setSheet(null);
      return true;
    };
    pushToastFn = (x) => {
      setT(x);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setT(null), 5200);
    };
    return () => {
      openSheetFn = null;
      closeSheetFn = null;
      pushToastFn = null;
    };
  }, []);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const close = () => setSheet(null);
  const Icon = t?.kind === 'warning' ? AlertTriangle : t?.kind === 'info' ? Info : Check;
  const iconColor = t?.kind === 'warning' ? 'var(--warning)' : t?.kind === 'info' ? 'var(--info)' : 'var(--good)';

  return createPortal(
    <>
      {sheet && (
        <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
          <Glass className="sheet" role="dialog" aria-modal="true">
            {sheet(close)}
          </Glass>
        </div>
      )}
      {t && (
        <div className="toast" role="status" key={t.id}>
          <Icon size={16} color={iconColor} style={{ flex: 'none' }} />
          <span>{t.text}</span>
        </div>
      )}
    </>,
    document.body,
  );
}

export function SheetClose({ onClose }: { onClose: () => void }) {
  return (
    <button className="btn icon" style={{ position: 'absolute', top: 14, right: 14, width: 30, height: 30 }} onClick={onClose} aria-label="Close">
      <X size={15} />
    </button>
  );
}
