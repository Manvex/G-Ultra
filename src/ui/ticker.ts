// One animation loop for everything liquid. It runs at a low rate and stops by itself
// when nothing is subscribed or the window is hidden: a monitoring app
// must not be the thing heating up the processor.
type Fn = (t: number, dt: number) => void;

const subs = new Set<Fn>();
let raf = 0;
let last = 0;
let start = 0;

export function hasFocus() {
  return document.hasFocus() || (window as unknown as { __gultraForceFocus?: boolean }).__gultraForceFocus === true;
}

function loop(now: number) {
  raf = requestAnimationFrame(loop);
  if (!start) start = now;
  const dt = now - last;
  // 24 frames with the window active, 5 while it sits in the background.
  if (dt < (hasFocus() ? 1000 / 24 : 1000 / 5) - 2) return;
  last = now;
  const t = (now - start) / 1000;
  subs.forEach((f) => f(t, Math.min(0.1, dt / 1000)));
}

export function subscribeFrame(fn: Fn): () => void {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
