import { useEffect, useState, useSyncExternalStore } from 'react';
import { bridge } from './bridge';
import type { Live, Sensor, SystemInfo } from './types';

const HISTORY = 200; // about 5 minutes at one sample per 1.5 seconds

export interface History {
  ts: number[];
  cpu: (number | null)[];
  mem: number[];
  temps: Map<string, (number | null)[]>;
  names: Map<string, Sensor>;
}

interface Settings {
  motion: boolean;
  intervalMs: number;
  autoUpdate: boolean;
}

function readSettings(): Settings {
  const defaults: Settings = { motion: true, intervalMs: 1500, autoUpdate: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('gultra.settings') || '{}') };
  } catch {
    return defaults;
  }
}

class Store {
  live: Live | null = null;
  system: SystemInfo | null = null;
  liveError: string | null = null;
  settings = readSettings();
  history: History = { ts: [], cpu: [], mem: [], temps: new Map(), names: new Map() };
  energy = 0;

  private listeners = new Set<() => void>();
  private timer: number | null = null;
  private busy = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getLive = () => this.live;
  getSystem = () => this.system;
  getSettings = () => this.settings;
  getError = () => this.liveError;

  private emit() {
    this.listeners.forEach((l) => l());
  }

  start() {
    void this.refreshSystem();
    void this.tick();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this.tick();
    });
  }

  async refreshSystem() {
    try {
      this.system = await bridge.system();
      this.emit();
    } catch {
      /* tried again on the next refresh */
    }
  }

  private schedule() {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.tick(), this.settings.intervalMs);
  }

  private async tick() {
    if (this.busy) return;
    if (document.hidden) {
      this.schedule();
      return;
    }
    this.busy = true;
    try {
      const live = await bridge.live();
      this.ingest(live);
      this.liveError = null;
    } catch (e) {
      this.liveError = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
      this.emit();
      this.schedule();
    }
  }

  private ingest(live: Live) {
    this.live = live;
    const h = this.history;
    h.ts.push(live.ts);
    h.cpu.push(live.cpu.usage);
    h.mem.push(live.mem.load);
    const seen = new Set<string>();
    for (const s of live.sensors) {
      if (s.celsius == null) continue;
      seen.add(s.id);
      h.names.set(s.id, s);
      let arr = h.temps.get(s.id);
      if (!arr) {
        arr = new Array(h.ts.length - 1).fill(null);
        h.temps.set(s.id, arr);
      }
      arr.push(s.celsius);
    }
    for (const [id, arr] of h.temps) if (!seen.has(id)) arr.push(null);
    if (h.ts.length > HISTORY) {
      h.ts.shift();
      h.cpu.shift();
      h.mem.shift();
      for (const arr of h.temps.values()) arr.shift();
    }
    this.energy += ((live.cpu.usage ?? 20) / 100 - this.energy) * 0.3;
  }

  setSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem('gultra.settings', JSON.stringify(this.settings));
    } catch {
      /* the settings last for this session */
    }
    this.emit();
  }
}

export const store = new Store();

/** The highest reading from a real sensor (leaving out the approximate ACPI zones). */
export function hottestReal(sensors: Sensor[]): number | null {
  let max: number | null = null;
  for (const s of sensors) if (s.celsius != null && !s.approximate && (max == null || s.celsius > max)) max = s.celsius;
  return max;
}

export function cpuTemp(sensors: Sensor[]): number | null {
  const pkg = sensors.find((s) => s.group === 'cpu' && s.celsius != null && /package|tctl|tdie/i.test(s.name));
  if (pkg) return pkg.celsius!;
  let max: number | null = null;
  for (const s of sensors) if (s.group === 'cpu' && !s.approximate && s.celsius != null && (max == null || s.celsius > max)) max = s.celsius;
  return max;
}

export const useLive = () => useSyncExternalStore(store.subscribe, store.getLive);
export const useSystem = () => useSyncExternalStore(store.subscribe, store.getSystem);
export const useSettings = () => useSyncExternalStore(store.subscribe, store.getSettings);
export const useLiveError = () => useSyncExternalStore(store.subscribe, store.getError);

// ---- data that loads once and is kept between screens ----
interface Entry<T> {
  value?: T;
  error?: string;
  loading: boolean;
  at: number;
}

const cache = new Map<string, Entry<any>>();
const cacheListeners = new Set<() => void>();

export function loadData<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  const prev = cache.get(key);
  cache.set(key, { ...prev, loading: true, at: prev?.at ?? 0 });
  cacheListeners.forEach((l) => l());
  return fn().then(
    (value) => {
      cache.set(key, { value, loading: false, at: Date.now() });
      cacheListeners.forEach((l) => l());
      return value;
    },
    (e) => {
      cache.set(key, { ...cache.get(key), error: e instanceof Error ? e.message : String(e), loading: false, at: Date.now() });
      cacheListeners.forEach((l) => l());
      return undefined;
    },
  );
}

export function useData<T>(key: string, fn: () => Promise<T>, maxAgeMs = 60000) {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    cacheListeners.add(l);
    const e = cache.get(key);
    if (!e || (!e.loading && Date.now() - e.at > maxAgeMs)) void loadData(key, fn);
    return () => {
      cacheListeners.delete(l);
    };
    // The key identifies the source; the function doesn't change between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, maxAgeMs]);
  const e = cache.get(key) as Entry<T> | undefined;
  return {
    data: e?.value,
    error: e?.error,
    loading: !e || e.loading,
    reload: () => loadData(key, fn),
  };
}

export function setData<T>(key: string, value: T) {
  cache.set(key, { value, loading: false, at: Date.now() });
  cacheListeners.forEach((l) => l());
}

export function peekData<T>(key: string): T | undefined {
  return cache.get(key)?.value as T | undefined;
}
