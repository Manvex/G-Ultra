import { useEffect, useMemo, useRef, useState } from 'react';

export interface Series {
  id: string;
  name: string;
  color: string;
  values: (number | null)[];
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function linePath(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

// Line chart with a single axis. Text keeps the normal ink; only the lines carry color.
export function LineChart({
  series,
  ts,
  height = 190,
  unit = '°',
  yMin,
  yMax,
  area = false,
  xStart,
  xEnd,
  tipLabel,
}: {
  series: Series[];
  ts: number[];
  height?: number;
  unit?: string;
  yMin?: number;
  yMax?: number;
  area?: boolean;
  /** Custom axis ends and tooltip heading, for charts that span months rather than minutes. */
  xStart?: string;
  xEnd?: string;
  tipLabel?: (index: number) => string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: unit === '%' ? 42 : 34, r: 8, t: 8, b: 20 };
  const innerW = Math.max(10, width - pad.l - pad.r);
  const innerH = height - pad.t - pad.b;
  const n = Math.max(2, ts.length);

  const [lo, hi] = useMemo(() => {
    let a = Infinity;
    let b = -Infinity;
    for (const s of series)
      for (const v of s.values)
        if (v != null) {
          if (v < a) a = v;
          if (v > b) b = v;
        }
    if (!isFinite(a)) return [yMin ?? 0, yMax ?? 100];
    const lower = yMin ?? Math.floor((a - 4) / 10) * 10;
    const upper = yMax ?? Math.ceil((b + 4) / 10) * 10;
    return [lower, upper > lower ? upper : lower + 10];
  }, [series, yMin, yMax]);

  const x = (i: number) => pad.l + (i / (n - 1)) * innerW;
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * innerH;
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  const spanMin = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / 60000 : 0;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - pad.l) / innerW) * (n - 1));
    setHover(i >= 0 && i < ts.length ? i : null);
  };

  return (
    <div className="chart-wrap" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Change over time: ${series.map((s) => s.name).join(', ')}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ display: 'block', touchAction: 'pan-y' }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,.07)" />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="rgba(226,232,250,.5)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(t)}
                {unit}
              </text>
            </g>
          ))}
          <text x={pad.l} y={height - 4} fontSize="11" fill="rgba(226,232,250,.42)">
            {xStart ?? (spanMin >= 1 ? `${Math.round(spanMin)} min ago` : 'seconds ago')}
          </text>
          <text x={width - pad.r} y={height - 4} textAnchor="end" fontSize="11" fill="rgba(226,232,250,.42)">
            {xEnd ?? 'now'}
          </text>
          {area &&
            series.map((s) => {
              const d = linePath(s.values, x, y);
              if (!d) return null;
              const firstIdx = s.values.findIndex((v) => v != null);
              let lastIdx = s.values.length - 1;
              while (lastIdx > 0 && s.values[lastIdx] == null) lastIdx--;
              return (
                <path key={`a-${s.id}`} d={`${d}L${x(lastIdx).toFixed(1)} ${y(lo).toFixed(1)}L${x(firstIdx).toFixed(1)} ${y(lo).toFixed(1)}Z`} fill={s.color} opacity="0.13" />
              );
            })}
          {series.map((s) => (
            <path key={s.id} d={linePath(s.values, x, y)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} stroke="rgba(255,255,255,.28)" />
              {series.map((s) => {
                const v = s.values[hover];
                return v == null ? null : <circle key={s.id} cx={x(hover)} cy={y(v)} r="4" fill={s.color} stroke="#14161f" strokeWidth="2" />;
              })}
            </g>
          )}
        </svg>
      )}
      {hover != null && width > 0 && (
        <div className="chart-tip" style={{ left: Math.max(70, Math.min(width - 70, x(hover))) }}>
          <div className="muted small" style={{ marginBottom: 2 }}>
            {tipLabel ? tipLabel(hover) : `${Math.max(0, Math.round((ts[ts.length - 1] - ts[hover]) / 1000))} s ago`}
          </div>
          {series.map((s) => (
            <div key={s.id} className="row" style={{ gap: 6 }}>
              <i style={{ width: 8, height: 8, borderRadius: 4, background: s.color, display: 'inline-block', flex: 'none' }} />
              <span className="dim">{s.name}</span>
              <span className="num" style={{ marginLeft: 'auto', fontWeight: 600, paddingLeft: 10 }}>
                {s.values[hover] == null ? '—' : `${Math.round(s.values[hover]! * 10) / 10}${unit}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChartLegend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span key={s.id}>
          <i style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

export function Sparkline({ values, width = 76, height = 26, color = 'rgba(255,255,255,.6)' }: { values: (number | null)[]; width?: number; height?: number; color?: string }) {
  const clean = values.filter((v): v is number => v != null);
  if (clean.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const lo = Math.min(...clean) - 1;
  const hi = Math.max(...clean) + 1;
  const n = values.length;
  const d = linePath(
    values,
    (i) => (i / (n - 1)) * width,
    (v) => 2 + (1 - (v - lo) / (hi - lo)) * (height - 4),
  );
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- treemap (the "squarified" algorithm) ----
export interface TreeRect<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function squarify<T>(items: T[], size: (t: T) => number, W: number, H: number): TreeRect<T>[] {
  const sorted = items.filter((i) => size(i) > 0).sort((a, b) => size(b) - size(a));
  const total = sorted.reduce((s, i) => s + size(i), 0);
  if (!total || W <= 0 || H <= 0) return [];
  const scale = (W * H) / total;
  const out: TreeRect<T>[] = [];
  let x = 0;
  let y = 0;
  let w = W;
  let h = H;
  let i = 0;

  const worst = (row: number[], side: number) => {
    const sum = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  while (i < sorted.length) {
    const side = Math.min(w, h);
    const row: T[] = [];
    const areas: number[] = [];
    while (i < sorted.length) {
      const a = size(sorted[i]) * scale;
      if (areas.length && worst([...areas, a], side) > worst(areas, side)) break;
      areas.push(a);
      row.push(sorted[i]);
      i++;
    }
    const sum = areas.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const cw = sum / h;
      let cy = y;
      row.forEach((it, k) => {
        const ch = areas[k] / cw;
        out.push({ item: it, x, y: cy, w: cw, h: ch });
        cy += ch;
      });
      x += cw;
      w -= cw;
    } else {
      const ch = sum / w;
      let cx = x;
      row.forEach((it, k) => {
        const cw = areas[k] / ch;
        out.push({ item: it, x: cx, y, w: cw, h: ch });
        cx += cw;
      });
      y += ch;
      h -= ch;
    }
  }
  return out;
}
