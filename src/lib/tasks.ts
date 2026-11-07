import { useSyncExternalStore } from 'react';
import { bridge } from './bridge';
import { bytes, int, plural } from './format';
import { loadData, store } from './store';
import type { CleanCategory, CleanRunResult, FreeRamResult, RamTestState, ScanNode, ScanProgress } from './types';
import { toast } from '../ui/kit';

export type RouteId = 'home' | 'monitor' | 'memory' | 'thermal' | 'gpu' | 'battery' | 'storage' | 'clean' | 'health' | 'components';

export interface Activity {
  id: string;
  label: string;
  detail?: string;
  route: RouteId;
}

// Long-running work lives here, outside the screens, so it keeps going while the user moves
// around the app or uses other windows. Each job shows up in the activity list and reports
// back with a toast, plus a system notification if the window isn't in front.
class Tasks {
  version = 0;
  activities: Activity[] = [];

  // Storage analysis
  selectedVolume: string | null = null;
  scanPath: string | null = null;
  scanRunning = false;
  scanProgress: ScanProgress | null = null;
  scanNode: ScanNode | null = null;
  scanRoot: ScanNode | null = null;

  // Cleanup
  categories: CleanCategory[] = [];
  cleanScanning = false;
  cleanRunning = false;
  cleanResult: CleanRunResult | null = null;
  cleanSelection: Set<string> | null = null;

  // Memory
  freeingRam = false;
  ramResult: FreeRamResult | null = null;
  ramTest: RamTestState | null = null;

  private listeners = new Set<() => void>();
  private started = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private setActivity(a: Activity) {
    const i = this.activities.findIndex((x) => x.id === a.id);
    this.activities = i >= 0 ? this.activities.map((x) => (x.id === a.id ? a : x)) : [...this.activities, a];
    bridge.win?.setProgress(2);
    this.emit();
  }

  private endActivity(id: string) {
    this.activities = this.activities.filter((x) => x.id !== id);
    if (this.activities.length === 0) bridge.win?.setProgress(-1);
    this.emit();
  }

  /** A generic background job for anything that doesn't need its own state. */
  async run<T>(a: Activity, job: () => Promise<T>): Promise<T> {
    this.setActivity(a);
    try {
      return await job();
    } finally {
      this.endActivity(a.id);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    bridge.onEvent((name, data) => {
      if (name === 'scan') this.onScanEvent(data);
      else if (name === 'cleanList') {
        if (this.categories.length === 0) {
          this.categories = data;
          this.emit();
        }
      } else if (name === 'cleanItem') {
        const known = this.categories.some((c) => c.id === data.id);
        this.categories = known ? this.categories.map((c) => (c.id === data.id ? data : c)) : [...this.categories, data];
        this.emit();
      } else if (name === 'cleanRun') {
        this.setActivity({ id: 'clean', label: 'Cleaning up', detail: `${data.name} · ${bytes(data.freed)} freed`, route: 'clean' });
      } else if (name === 'ramTest') {
        this.onRamTest(data);
      } else if (name === 'monitorEvent') {
        toast(data.text, 'info');
        bridge.win?.notify('G Ultra', data.text);
        void loadData('monitor', () => bridge.monitorGet());
      } else if (name === 'fanSafety') {
        toast(`Fans are back on automatic: the system reached ${Math.round(data.celsius)}°C.`, 'warning');
        bridge.win?.notify('Fans back on automatic', `The system reached ${Math.round(data.celsius)}°C.`);
      }
    });
  }

  // ---- storage analysis ----
  startScan(path: string, label: string) {
    this.scanPath = path;
    this.scanRunning = true;
    this.scanNode = null;
    this.scanRoot = null;
    this.scanProgress = { state: 'running', path, files: 0, dirs: 0, bytes: 0, denied: 0, current: null };
    this.setActivity({ id: 'scan', label: `Analyzing ${label}`, route: 'storage' });
    bridge.scanStart(path).catch((e: Error) => {
      this.scanRunning = false;
      this.endActivity('scan');
      toast(`The analysis didn't start: ${e.message}`, 'warning');
    });
  }

  cancelScan() {
    void bridge.scanCancel();
    this.scanRunning = false;
    this.scanProgress = null;
    this.endActivity('scan');
  }

  private onScanEvent(data: ScanProgress) {
    if (!this.scanRunning) return;
    this.scanProgress = data;
    if (data.state === 'done') {
      this.scanRunning = false;
      this.endActivity('scan');
      void bridge.scanNode('').then((n) => {
        this.scanNode = n;
        this.scanRoot = n;
        this.emit();
        toast(`Analysis finished: ${plural(n.files, 'file', 'files')}, ${bytes(n.size)}.`);
        bridge.win?.notify('Storage analysis finished', `${plural(n.files, 'file', 'files')}, ${bytes(n.size)}.`);
      });
    } else {
      const a = this.activities.find((x) => x.id === 'scan');
      if (a) this.setActivity({ ...a, detail: `${int(data.files)} files · ${bytes(data.bytes)}` });
    }
  }

  openNode(path: string) {
    bridge.scanNode(path).then(
      (n) => {
        this.scanNode = n;
        this.emit();
      },
      (e: Error) => toast(e.message, 'warning'),
    );
  }

  selectVolume(path: string) {
    this.selectedVolume = path;
    this.emit();
  }

  // ---- cleanup ----
  scanCleanable() {
    if (this.cleanScanning) return;
    this.cleanScanning = true;
    this.setActivity({ id: 'cleanScan', label: 'Measuring caches', route: 'clean' });
    void bridge
      .cleanScan()
      .then((r) => {
        this.categories = r.categories;
      })
      .catch((e: Error) => toast(`The scan stopped: ${e.message}`, 'warning'))
      .finally(() => {
        this.cleanScanning = false;
        this.endActivity('cleanScan');
      });
  }

  toggleCategory(id: string, on: boolean) {
    const next = new Set(this.selection());
    if (on) next.add(id);
    else next.delete(id);
    this.cleanSelection = next;
    this.emit();
  }

  /** By default: only the categories marked safe that can actually be accessed. */
  selection(): Set<string> {
    return this.cleanSelection ?? new Set(this.categories.filter((c) => c.defaultOn && !c.needsAdmin).map((c) => c.id));
  }

  async runClean(ids: string[]) {
    if (this.cleanRunning) return;
    this.cleanRunning = true;
    this.cleanResult = null;
    this.setActivity({ id: 'clean', label: 'Cleaning up', detail: 'Getting ready', route: 'clean' });
    try {
      const r = await bridge.cleanRun(ids);
      this.cleanResult = r;
      const text = r.cancelled ? `Stopped. ${bytes(r.freed)} freed so far.` : `Cleanup finished: ${bytes(r.freed)} freed.`;
      toast(text);
      bridge.win?.notify('Cleanup finished', text);
      void loadData('disks', () => bridge.disks());
    } catch (e) {
      toast(`Cleanup stopped: ${(e as Error).message}`, 'warning');
    } finally {
      this.cleanRunning = false;
      this.endActivity('clean');
    }
    this.categories = [];
    this.scanCleanable();
  }

  cancelClean() {
    void bridge.win?.cleanCancel();
  }

  // ---- memory ----
  async freeRam(standby: boolean) {
    if (this.freeingRam) return;
    this.freeingRam = true;
    this.setActivity({ id: 'ram', label: 'Freeing memory', route: 'memory' });
    try {
      const r = await bridge.freeRam(standby);
      this.ramResult = r;
      if (r.restricted) toast("Android doesn't allow freeing other apps' memory.", 'info');
      else toast(`${bytes(r.freed)} of memory freed.`);
    } catch (e) {
      toast(`Memory couldn't be freed: ${(e as Error).message}`, 'warning');
    } finally {
      this.freeingRam = false;
      this.endActivity('ram');
    }
  }

  // ---- RAM test ----
  startRamTest() {
    if (this.ramTest?.state === 'running') return;
    this.ramTest = { state: 'running', percent: 0 };
    this.setActivity({ id: 'ramTest', label: 'Testing memory', detail: '0%', route: 'memory' });
    bridge.win?.ramTestStart().catch((e: Error) => {
      this.ramTest = null;
      this.endActivity('ramTest');
      toast(e.message, 'warning');
    });
  }

  cancelRamTest() {
    void bridge.win?.ramTestCancel();
  }

  private onRamTest(data: RamTestState) {
    this.ramTest = data;
    if (data.state === 'running') {
      this.setActivity({ id: 'ramTest', label: 'Testing memory', detail: `${data.percent ?? 0}%`, route: 'memory' });
      return;
    }
    this.endActivity('ramTest');
    if (data.state === 'done') {
      const text = data.errors ? `Memory test found ${int(data.errors)} errors. Run the full test to confirm.` : `Memory test passed on ${bytes(data.testedBytes)}.`;
      toast(text, data.errors ? 'warning' : 'good');
      bridge.win?.notify('Memory test finished', text);
      void loadData('ramHealth', () => bridge.win!.ramHealth());
    } else if (data.state === 'failed') {
      toast(`The memory test stopped: ${data.message}`, 'warning');
    }
  }

  // ---- one-tap optimize ----
  optimize(ram: boolean, cleanIds: string[]) {
    if (ram) void this.freeRam(store.live?.elevated ?? false);
    if (cleanIds.length) void this.runClean(cleanIds);
  }
}

export const tasks = new Tasks();

/** Re-renders the component whenever any background job changes. */
export function useTasks() {
  useSyncExternalStore(tasks.subscribe, tasks.getVersion);
  return tasks;
}
