const n0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const n1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const int = (v: number) => n0.format(v);
export const dec1 = (v: number) => n1.format(v);

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function bytesParts(b: number | null | undefined): { value: string; unit: string } {
  if (b == null || !isFinite(b)) return { value: '—', unit: '' };
  if (b < 1024) return { value: n0.format(b), unit: 'B' };
  let u = 0;
  let v = b;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const raw = v >= 100 ? n0.format(v) : v >= 10 ? n1.format(v) : u >= 3 ? n2.format(v) : n1.format(v);
  // "8 GB" rather than "8.00 GB".
  const value = raw.replace(/\.0+$/, '');
  return { value, unit: UNITS[u] };
}

export function bytes(b: number | null | undefined): string {
  const p = bytesParts(b);
  return p.unit ? `${p.value} ${p.unit}` : p.value;
}

/** Terabytes written to an SSD: manufacturers count these in decimal units. */
export function terabytes(b: number | null | undefined): string {
  if (b == null) return '—';
  const tb = b / 1e12;
  return tb >= 1 ? `${n1.format(tb)} TB` : `${n0.format(b / 1e9)} GB`;
}

export function pct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${n0.format(v)}%`;
}

export function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} ${d === 1 ? 'day' : 'days'}${h > 0 ? `, ${h} ${h === 1 ? 'hour' : 'hours'}` : ''}`;
  if (h > 0) return `${h} ${h === 1 ? 'hour' : 'hours'}${m > 0 ? `, ${m} min` : ''}`;
  return `${m} min`;
}

/** The equivalent in days or years, for power-on hours. */
export function hoursText(h: number): string {
  const days = h / 24;
  if (days >= 365) return `${n1.format(days / 365)} years`;
  return `${n0.format(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`;
}

export function minutesText(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under 1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export interface TempState {
  key: 'cool' | 'normal' | 'warm' | 'hot';
  label: string;
  color: string;
}

export function tempState(c: number | null | undefined): TempState {
  if (c == null) return { key: 'normal', label: 'Unavailable', color: 'var(--ink-3)' };
  if (c < 50) return { key: 'cool', label: 'Cool', color: 'var(--good)' };
  if (c < 72) return { key: 'normal', label: 'Normal', color: 'var(--good)' };
  if (c < 88) return { key: 'warm', label: 'Warm', color: 'var(--warning)' };
  return { key: 'hot', label: 'Hot', color: 'var(--critical)' };
}

export function clamp(v: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}

export function plural(n: number, one: string, many: string): string {
  return `${int(n)} ${n === 1 ? one : many}`;
}

/** The model name without "Convertible" or series suffixes full of x's. */
export function shortDevice(name: string): string {
  return name.replace(/\s+Convertible/i, '').replace(/-[a-z0-9]*x{2,}$/i, '').trim();
}

export function ghz(mhz: number): string {
  return `${(mhz / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} GHz`;
}
