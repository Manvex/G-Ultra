import { useSyncExternalStore } from 'react';
import { bridge } from './bridge';
import { bytes, int, plural } from './format';
import { loadData, store } from './store';
import type { CleanCategory, CleanRunResult, DriverInstallResult, DriverScan, FreeRamResult, RamTestState, RecoverPage, RecoverResult, RecoverScanState, ScanNode, ScanProgress, UpdateInfo } from './types';
import { toast } from '../ui/kit';

export type RouteId = 'home' | 'monitor' | 'memory' | 'thermal' | 'gpu' | 'battery' | 'storage' | 'clean' | 'recover' | 'health' | 'drivers' | 'components';

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

  // Drivers
  driverScan: DriverScan | null = null;
  driverError: string | null = null;
  driversChecking = false;
  driversInstalling = false;
  driverResult: DriverInstallResult | null = null;
  driverConfirm: { ids: string[]; message: string } | null = null;
  private driverChoice: Set<string> | null = null;

  // File recovery
  recoverState: RecoverScanState | null = null;
  recoverDrive: string | null = null;
  recoverPage: RecoverPage | null = null;
  recoverCategory = 'all';
  recoverSearch = '';
  recoverSelected = new Set<number>();
  recovering = false;
  recoverResult: RecoverResult | null = null;
  private recoverTimer = 0;

  // App updates
  update: UpdateInfo | null = null;
  updateChecking = false;
  updateInstalling = false;
  updatePercent = 0;
  updateDismissed = false;
  updateFailed = false;

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
      } else if (name === 'recoverScan') {
        this.onRecoverScan(data);
      } else if (name === 'recoverCopy') {
        this.setActivity({ id: 'recover', label: 'Recovering files', detail: `${data.index + 1} of ${data.total}`, route: 'recover' });
      } else if (name === 'driverInstall') {
        this.onDriverInstall(data);
      } else if (name === 'monitorEvent') {
        toast(data.text, 'info');
        bridge.win?.notify('G Ultra', data.text);
        void loadData('monitor', () => bridge.monitorGet());
      } else if (name === 'fanSafety') {
        toast(`Fans are back on automatic: the system reached ${Math.round(data.celsius)}°C.`, 'warning');
        bridge.win?.notify('Fans back on automatic', `The system reached ${Math.round(data.celsius)}°C.`);
      }
    });
    // Soon after opening, then every 6 hours. The setting can change at any time.
    const autoCheck = () => {
      if (store.settings.autoUpdate) void this.checkUpdate(false);
    };
    window.setTimeout(autoCheck, 8000);
    window.setInterval(autoCheck, 6 * 60 * 60 * 1000);
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

  // ---- drivers ----
  checkDrivers() {
    if (this.driversChecking) return;
    this.driversChecking = true;
    this.driverError = null;
    this.setActivity({ id: 'driversCheck', label: 'Checking for driver updates', route: 'drivers' });
    void bridge
      .win!.driversScan()
      .then((r) => {
        this.driverScan = r;
        this.driverChoice = null;
      })
      .catch((e: Error) => {
        this.driverScan = null;
        this.driverError = e.message;
      })
      .finally(() => {
        this.driversChecking = false;
        this.endActivity('driversCheck');
      });
  }

  /** By default, every driver that can be installed from here. */
  driverSelected(): Set<string> {
    return this.driverChoice ?? new Set(this.driverScan?.updates.filter((u) => !u.needsTerms).map((u) => u.id) ?? []);
  }

  toggleDriver(id: string, on: boolean) {
    const next = new Set(this.driverSelected());
    if (on) next.add(id);
    else next.delete(id);
    this.driverChoice = next;
    this.emit();
  }

  cancelDriverConfirm() {
    this.driverConfirm = null;
    this.emit();
  }

  async installDrivers(ids: string[], allowNoRestorePoint = false) {
    if (this.driversInstalling) return;
    this.driversInstalling = true;
    this.driverConfirm = null;
    this.driverResult = null;
    this.setActivity({ id: 'driversInstall', label: 'Installing drivers', detail: 'Getting ready', route: 'drivers' });
    let finished = false;
    try {
      const r = await bridge.win!.driversInstall(ids, allowNoRestorePoint);
      if (r.needsConfirm) {
        this.driverConfirm = { ids, message: r.restore.message };
      } else {
        this.driverResult = r;
        finished = true;
        const failed = r.results.filter((x) => x.state !== 'installed').length;
        const text = r.rebootRequired ? 'Drivers installed. Restart your PC to finish.' : failed ? `Finished, but ${plural(failed, 'driver', 'drivers')} didn't install.` : 'Drivers installed.';
        toast(text, failed ? 'warning' : 'good');
        bridge.win?.notify('Driver updates finished', text);
      }
    } catch (e) {
      toast(`Drivers weren't installed: ${(e as Error).message}`, 'warning');
    } finally {
      this.driversInstalling = false;
      this.endActivity('driversInstall');
    }
    if (finished) {
      void loadData('driversInstalled', () => bridge.win!.driversInstalled());
      this.checkDrivers();
    }
  }

  private onDriverInstall(data: { stage: string; index?: number; total?: number; title?: string }) {
    const step = data.total && data.total > 1 ? ` (${(data.index ?? 0) + 1} of ${data.total})` : '';
    const detail = data.stage === 'restore' ? 'Creating a restore point' : data.stage === 'download' ? `Downloading${step}` : `Installing${step}`;
    this.setActivity({ id: 'driversInstall', label: 'Installing drivers', detail, route: 'drivers' });
  }

  // ---- file recovery ----
  recoverStart(drive: string) {
    if (this.recoverState?.state === 'running') return;
    this.recoverDrive = drive;
    this.recoverState = { state: 'running', percent: 0, found: 0 };
    this.recoverPage = null;
    this.recoverResult = null;
    this.recoverSelected = new Set();
    this.setActivity({ id: 'recoverScan', label: `Scanning ${drive}: for deleted files`, route: 'recover' });
    bridge.win!.recoverStart(drive).catch((e: Error) => this.onRecoverScan({ state: 'failed', message: e.message }));
  }

  recoverCancel() {
    void bridge.win!.recoverCancel();
  }

  private onRecoverScan(data: RecoverScanState) {
    this.recoverState = data;
    if (data.state === 'running') {
      this.setActivity({ id: 'recoverScan', label: `Scanning ${this.recoverDrive}: for deleted files`, detail: `${data.percent ?? 0}%`, route: 'recover' });
      return;
    }
    this.endActivity('recoverScan');
    if (data.state === 'done') {
      toast(`Scan finished: ${int(data.found ?? 0)} deleted files found.`);
      bridge.win?.notify('Scan finished', `${int(data.found ?? 0)} deleted files found.`);
      this.loadRecoverPage();
    }
  }

  private loadRecoverPage() {
    void bridge.win!.recoverList(this.recoverCategory, this.recoverSearch, 200).then(
      (p) => {
        this.recoverPage = p;
        this.emit();
      },
      (e: Error) => toast(e.message, 'warning'),
    );
  }

  recoverFilter(category: string, search: string) {
    this.recoverCategory = category;
    this.recoverSearch = search;
    this.emit();
    clearTimeout(this.recoverTimer);
    this.recoverTimer = window.setTimeout(() => this.loadRecoverPage(), 300);
  }

  recoverToggle(id: number, on: boolean) {
    const next = new Set(this.recoverSelected);
    if (on) next.add(id);
    else next.delete(id);
    this.recoverSelected = next;
    this.emit();
  }

  async recoverRun(ids: number[], folder: string) {
    if (this.recovering) return;
    this.recovering = true;
    this.recoverResult = null;
    this.setActivity({ id: 'recover', label: 'Recovering files', detail: 'Getting ready', route: 'recover' });
    try {
      const r = await bridge.win!.recoverRun(ids, folder);
      this.recoverResult = r;
      this.recoverSelected = new Set();
      const saved = r.results.filter((x) => x.ok).length;
      const text = `${saved} of ${r.results.length} files saved.`;
      toast(text, saved === r.results.length ? 'good' : 'warning');
      bridge.win?.notify('Recovery finished', text);
    } catch (e) {
      toast((e as Error).message, 'warning');
    } finally {
      this.recovering = false;
      this.endActivity('recover');
    }
  }

  // ---- app updates ----
  async checkUpdate(manual: boolean) {
    if (this.updateChecking || this.updateInstalling) return;
    this.updateChecking = true;
    this.emit();
    try {
      const r = await bridge.updateCheck();
      this.update = r;
      if (manual) {
        if (r.available) this.updateDismissed = false;
        else toast(r.supported ? `You have the latest version, ${r.current}.` : 'Updates only work in the installed app.', 'info');
      }
    } catch {
      // A failed automatic check stays quiet: it runs again later.
      if (manual) toast("Couldn't check for updates. Check your internet connection.", 'warning');
    } finally {
      this.updateChecking = false;
      this.emit();
    }
  }

  dismissUpdate() {
    this.updateDismissed = true;
    this.emit();
  }

  showUpdateBanner() {
    this.updateDismissed = false;
    this.emit();
  }

  async installUpdate() {
    if (this.updateInstalling) return;
    this.updateInstalling = true;
    this.updatePercent = 0;
    this.updateFailed = false;
    this.setActivity({ id: 'update', label: 'Updating G Ultra', detail: 'Downloading', route: 'home' });
    try {
      const r = await bridge.updateInstall((percent) => {
        this.updatePercent = percent;
        this.setActivity({ id: 'update', label: 'Updating G Ultra', detail: `Downloading ${percent}%`, route: 'home' });
      });
      if (r.needsPermission) toast('Allow G Ultra to install apps, then press Update again.', 'info');
    } catch {
      this.updateFailed = true;
      toast("The update didn't finish. You can try again or download it from GitHub.", 'warning');
    } finally {
      this.updateInstalling = false;
      this.endActivity('update');
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
