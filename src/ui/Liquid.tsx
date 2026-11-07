import { useEffect, useRef } from 'react';
import { useSettings } from '../lib/store';
import { subscribeFrame } from './ticker';

export interface LiquidLayer {
  /** Layer thickness as a fraction of the total height (0-1). */
  value: number;
  /** The top and bottom colors. */
  color: [string, string];
}

interface Props {
  layers: LiquidLayer[];
  /** 0-1: how agitated the surface is. */
  energy?: number;
  bubbles?: boolean;
  className?: string;
}

interface Bubble {
  x: number;
  y: number;
  r: number;
  speed: number;
}

// Liquid drawn on a 2D canvas. Layers stack from the bottom up, like a density tower.
export function Liquid({ layers, energy = 0.2, bubbles = false, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({ layers, energy, bubbles });
  propsRef.current = { layers, energy, bubbles };
  const { motion } = useSettings();
  const motionRef = useRef(motion);
  motionRef.current = motion;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const levels: number[] = [];
    const bubblesList: Bubble[] = [];
    let slosh = 1;
    let phaseShift = Math.random() * 10;
    let visible = true;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width;
      h = r.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      draw(lastT);
    };

    let lastT = 0;
    function waveY(x: number, base: number, amp: number, t: number, offset: number) {
      const k = (Math.PI * 2) / Math.max(180, w * 0.9);
      return (
        base +
        Math.sin(x * k + t * 1.1 + offset) * amp +
        Math.sin(x * k * 2.3 - t * 0.8 + offset * 1.7) * amp * 0.42 +
        Math.sin(x * k * 0.6 + t * 0.5 + offset * 0.5) * amp * 0.6
      );
    }

    function fillWave(top: number, amp: number, t: number, offset: number, fill: string | CanvasGradient) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      const step = Math.max(8, w / 34);
      for (let x = 0; x <= w + step; x += step) ctx.lineTo(x, waveY(x, top, amp, t, offset));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    function strokeWave(top: number, amp: number, t: number, offset: number, alpha: number) {
      ctx.beginPath();
      const step = Math.max(8, w / 34);
      for (let x = 0; x <= w + step; x += step) {
        const y = waveY(x, top, amp, t, offset);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    function draw(t: number) {
      lastT = t;
      const { layers: ls, energy: en, bubbles: wantBubbles } = propsRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Levels ease towards their target.
      let cumulative = 0;
      const tops: number[] = [];
      ls.forEach((l, i) => {
        cumulative += l.value;
        const target = Math.min(1, cumulative);
        if (levels[i] == null) levels[i] = 0;
        const delta = target - levels[i];
        levels[i] += delta * (motionRef.current ? 0.075 : 1);
        slosh = Math.min(1.2, slosh + Math.abs(delta) * 0.04);
        tops[i] = h - levels[i] * h;
      });
      slosh *= 0.985;

      const baseAmp = Math.min(h * 0.022, 6) * (0.5 + en * 1.3) + Math.min(h * 0.05, 11) * slosh * 0.5;

      for (let i = ls.length - 1; i >= 0; i--) {
        const top = tops[i];
        if (levels[i] <= 0.002) continue;
        const amp = baseAmp * (i === ls.length - 1 ? 1 : 0.55);
        const off = phaseShift + i * 2.1;
        const [c1, c2] = ls[i].color;
        if (i === ls.length - 1) {
          ctx.globalAlpha = 0.34;
          fillWave(top - amp * 0.9, amp * 1.1, t * 0.8, off + 2.4, c1);
          ctx.globalAlpha = 1;
        }
        const g = ctx.createLinearGradient(0, Math.max(0, top - amp), 0, h);
        g.addColorStop(0, c1);
        g.addColorStop(1, c2);
        fillWave(top, amp, t, off, g);
        strokeWave(top, amp, t, off, 0.32);
      }

      // Small bubbles, only while the system is busy.
      if (wantBubbles && motionRef.current && ls.length && levels[ls.length - 1] > 0.05) {
        const surface = tops[ls.length - 1];
        const wanted = Math.round(en * 7);
        while (bubblesList.length < wanted) {
          bubblesList.push({ x: Math.random() * w, y: h + Math.random() * 40, r: 0.8 + Math.random() * 2, speed: 14 + Math.random() * 26 });
        }
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        for (let i = bubblesList.length - 1; i >= 0; i--) {
          const b = bubblesList[i];
          b.y -= b.speed / 30;
          if (b.y < surface + 4) {
            if (bubblesList.length > wanted) bubblesList.splice(i, 1);
            else {
              b.y = h + Math.random() * 30;
              b.x = Math.random() * w;
            }
            continue;
          }
          ctx.beginPath();
          ctx.arc(b.x + Math.sin(b.y * 0.05) * 3, b.y, b.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const io = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
    });
    io.observe(canvas);

    let frozenAt = -1;
    const unsub = subscribeFrame((t) => {
      if (!visible) return;
      if (!motionRef.current) {
        // With animation off: redraw rarely, just to follow the data.
        if (t - frozenAt < 1) return;
        frozenAt = t;
        phaseShift = 0;
        draw(0);
        return;
      }
      draw(t);
    });

    return () => {
      unsub();
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={`liquid ${className ?? ''}`} aria-hidden="true" />;
}
