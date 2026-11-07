import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, BatteryMedium, CircuitBoard, Gpu, HardDrive, HeartPulse, House, Loader2, PackageCheck, MemoryStick, Minus, Radar, Settings, ShieldAlert, ShieldCheck, Sparkles, Square, Thermometer, X, type LucideIcon } from 'lucide-react';
import logo from './assets/logo.png';
import { bridge } from './lib/bridge';
import { shortDevice } from './lib/format';
import { store, useSettings, useSystem } from './lib/store';
import { tasks, useTasks, type RouteId } from './lib/tasks';
import { FluidBackground } from './ui/FluidBackground';
import { Glass, Overlays, openSheet, useSheen } from './ui/kit';
import { makeLens } from './ui/lens';
import { Battery } from './screens/Battery';
import { Clean } from './screens/Clean';
import { Components } from './screens/Components';
import { Graphics } from './screens/Graphics';
import { Health } from './screens/Health';
import { Home } from './screens/Home';
import { Memory } from './screens/Memory';
import { Monitor } from './screens/Monitor';
import { Recover } from './screens/Recover';
import { Drivers } from './screens/Drivers';
import { ElevateSheet, SettingsSheet } from './screens/Sheets';
import { Storage } from './screens/Storage';
import { Thermal } from './screens/Thermal';
import { UpdateBanner } from './screens/Updates';

export type Route = RouteId;

function routesFor(isAndroid: boolean, hasBattery: boolean): { id: Route; label: string; icon: LucideIcon }[] {
  return [
    { id: 'home', label: 'Home', icon: House },
    { id: 'monitor', label: 'Monitor', icon: Radar },
    { id: 'memory', label: 'Memory', icon: MemoryStick },
    { id: 'thermal', label: 'Thermals', icon: Thermometer },
    ...(isAndroid ? [] : [{ id: 'gpu' as Route, label: 'Graphics', icon: Gpu }]),
    ...(hasBattery ? [{ id: 'battery' as Route, label: 'Battery', icon: BatteryMedium }] : []),
    { id: 'storage', label: 'Storage', icon: HardDrive },
    { id: 'clean', label: 'Cleanup', icon: Sparkles },
    { id: 'recover', label: 'Recover', icon: ArchiveRestore },
    { id: 'health', label: 'Health', icon: HeartPulse },
    ...(isAndroid ? [] : [{ id: 'drivers' as Route, label: 'Drivers', icon: PackageCheck }]),
    { id: 'components', label: 'Components', icon: CircuitBoard },
  ];
}

function routeFromHash(routes: { id: Route }[]): Route {
  const h = location.hash.replace('#/', '') as Route;
  return routes.some((r) => r.id === h) ? h : 'home';
}

// Navigation with the glass droplet: it follows the active item on a spring and stretches as it moves.
function Nav({ route, routes, onNav }: { route: Route; routes: { id: Route; label: string; icon: LucideIcon }[]; onNav: (r: Route) => void }) {
  const navRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const items = useRef<Partial<Record<Route, HTMLButtonElement | null>>>({});
  const s = useRef({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, w: 0, h: 0, init: false, raf: 0, lensW: 0, lensH: 0 });
  const { motion } = useSettings();

  useLayoutEffect(() => {
    const st = s.current;

    const paint = () => {
      const d = dropRef.current;
      if (!d) return;
      const speed = Math.hypot(st.vx, st.vy);
      const stretch = Math.min(0.26, speed / 3200);
      const moveX = Math.abs(st.vx) > Math.abs(st.vy);
      const sx = moveX ? 1 + stretch : 1 - stretch * 0.5;
      const sy = moveX ? 1 - stretch * 0.5 : 1 + stretch;
      d.style.transform = `translate3d(${st.x}px, ${st.y}px, 0) scale(${sx}, ${sy})`;
    };

    let lastTime = 0;
    const loop = (now: number) => {
      // Real time, split into small steps: the move takes the same time even with sparse frames.
      const elapsed = lastTime ? Math.min(0.25, (now - lastTime) / 1000) : 1 / 60;
      lastTime = now;
      const k = 210;
      const c = 21;
      for (let left = elapsed; left > 0; left -= 1 / 120) {
        const dt = Math.min(left, 1 / 120);
        st.vx += (-k * (st.x - st.tx) - c * st.vx) * dt;
        st.vy += (-k * (st.y - st.ty) - c * st.vy) * dt;
        st.x += st.vx * dt;
        st.y += st.vy * dt;
      }
      paint();
      if (Math.abs(st.x - st.tx) + Math.abs(st.y - st.ty) > 0.15 || Math.hypot(st.vx, st.vy) > 2) {
        st.raf = requestAnimationFrame(loop);
      } else {
        st.x = st.tx;
        st.y = st.ty;
        st.vx = st.vy = 0;
        st.raf = 0;
        lastTime = 0;
        paint();
      }
    };

    const measure = () => {
      const el = items.current[route];
      const d = dropRef.current;
      if (!el || !d) return;
      st.tx = el.offsetLeft;
      st.ty = el.offsetTop;
      st.w = el.offsetWidth;
      st.h = el.offsetHeight;
      d.style.width = `${st.w}px`;
      d.style.height = `${st.h}px`;
      if (st.w !== st.lensW || st.h !== st.lensH) {
        st.lensW = st.w;
        st.lensH = st.h;
        const radius = parseFloat(getComputedStyle(d).borderTopLeftRadius) || 15;
        makeLens('g-lens', st.w, st.h, radius, 12, 22);
        d.style.backdropFilter = 'url(#g-lens) saturate(1.5) brightness(1.08)';
      }
      if (!st.init || !motion) {
        st.init = true;
        st.x = st.tx;
        st.y = st.ty;
        st.vx = st.vy = 0;
        paint();
        return;
      }
      if (!st.raf) st.raf = requestAnimationFrame(loop);
    };

    measure();
    const ro = new ResizeObserver(measure);
    if (navRef.current) ro.observe(navRef.current);
    return () => {
      ro.disconnect();
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
    };
  }, [route, motion, routes.length]);

  // With more items than fit on a phone, the bar scrolls to keep the active one in view.
  useEffect(() => {
    if (window.matchMedia('(max-width: 720px)').matches) items.current[route]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [route]);

  return (
    <nav className="nav" ref={navRef} aria-label="Main navigation">
      {routes.map((r) => (
        <button
          key={r.id}
          type="button"
          ref={(el) => {
            items.current[r.id] = el;
          }}
          className="nav-item"
          aria-current={route === r.id ? 'page' : undefined}
          aria-label={r.label}
          onClick={() => onNav(r.id)}
        >
          <r.icon size={19} strokeWidth={route === r.id ? 2.2 : 1.8} />
          <span>{r.label}</span>
        </button>
      ))}
      <div className="droplet" ref={dropRef} aria-hidden="true" />
    </nav>
  );
}

function WindowControls() {
  return (
    <Glass className="win-controls">
      <button aria-label="Minimize" onClick={() => bridge.win?.windowAction('minimize')}>
        <Minus size={14} />
      </button>
      <button aria-label="Maximize" onClick={() => bridge.win?.windowAction('maximize')}>
        <Square size={11} />
      </button>
      <button className="close" aria-label="Close" onClick={() => bridge.win?.windowAction('close')}>
        <X size={15} />
      </button>
    </Glass>
  );
}

// What's running in the background. Always visible, so the user can leave a screen freely.
function ActivityList({ onNav }: { onNav: (r: Route) => void }) {
  const t = useTasks();
  if (t.activities.length === 0) return null;
  return (
    <div className="activity" role="status" aria-label="Running in the background">
      {t.activities.map((a) => (
        <button key={a.id} className="activity-row" onClick={() => onNav(a.route)}>
          <Loader2 size={15} className="spin" style={{ flex: 'none' }} />
          <div style={{ minWidth: 0 }}>
            <strong>{a.label}</strong>
            {a.detail && <span>{a.detail}</span>}
          </div>
        </button>
      ))}
    </div>
  );
}

export function App() {
  const isAndroid = bridge.platform === 'android';
  const settings = useSettings();
  const system = useSystem();
  // Battery appears once the system confirms there is one, so a desktop never shows it.
  const routes = useMemo(() => routesFor(isAndroid, isAndroid || !!system?.hasBattery), [isAndroid, system?.hasBattery]);
  const [route, setRoute] = useState<Route>(() => routeFromHash(routes));
  const scrollRef = useRef<HTMLDivElement>(null);
  useSheen();

  useEffect(() => {
    store.start();
    tasks.start();
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash(routes));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [routes]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [route]);

  const nav = (r: Route) => {
    setRoute(r);
    // replaceState: on Android the Back button leaves the app instead of walking through screens.
    history.replaceState(null, '', `#/${r}`);
  };

  const hasWindowControls = !isAndroid;
  const elevated = system?.elevated ?? false;

  return (
    <div className="app" data-motion={settings.motion ? 'on' : 'off'}>
      <FluidBackground motion={settings.motion} />
      {hasWindowControls && <div className="drag" />}
      {hasWindowControls && <WindowControls />}

      <Glass className="sidebar">
        <div className="brand">
          <img src={logo} className="brand-mark" alt="" draggable={false} />
          <div>
            <div className="brand-name">G Ultra</div>
            <div className="brand-sub">{system ? shortDevice(system.deviceName) : ' '}</div>
          </div>
        </div>
        <Nav route={route} routes={routes} onNav={nav} />
        <div className="sidebar-foot">
          <div className="activity-side">
            <ActivityList onNav={nav} />
          </div>
          {hasWindowControls &&
            (elevated ? (
              <div className="mode-pill">
                <ShieldCheck size={18} color="var(--good)" style={{ flex: 'none' }} />
                <div>
                  <strong>Full mode</strong>
                  <span>Running as administrator</span>
                </div>
              </div>
            ) : (
              <button className="mode-pill" onClick={() => openSheet((close) => <ElevateSheet close={close} />)} aria-label="Turn on full mode">
                <ShieldAlert size={18} color="var(--warning)" style={{ flex: 'none' }} />
                <div>
                  <strong>Limited mode</strong>
                  <span>Tap for full mode</span>
                </div>
              </button>
            ))}
          <button className="mode-pill" onClick={() => openSheet((close) => <SettingsSheet close={close} />)} aria-label="Settings">
            <Settings size={18} style={{ flex: 'none' }} />
            <div>
              <strong>Settings</strong>
            </div>
          </button>
        </div>
      </Glass>

      <main className="content">
        <div className="scroll" ref={scrollRef}>
          <div className="page" key={route}>
            <UpdateBanner />
            {route === 'home' && <Home nav={nav} />}
            {route === 'monitor' && <Monitor />}
            {route === 'memory' && <Memory />}
            {route === 'thermal' && <Thermal />}
            {route === 'gpu' && <Graphics nav={nav} />}
            {route === 'battery' && <Battery nav={nav} />}
            {route === 'storage' && <Storage />}
            {route === 'clean' && <Clean />}
            {route === 'recover' && <Recover />}
            {route === 'health' && <Health />}
            {route === 'drivers' && <Drivers />}
            {route === 'components' && <Components />}
          </div>
        </div>
      </main>

      <div className="activity-float">
        <ActivityList onNav={nav} />
      </div>

      <Overlays />
      {bridge.isDemo && <span className="badge demo-flag">Demo data</span>}
    </div>
  );
}
