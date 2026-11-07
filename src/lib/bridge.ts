import { Capacitor, registerPlugin } from '@capacitor/core';
import type {
  AndroidBatteryInfo,
  AndroidPermissions,
  AndroidStorage,
  BatteryReport,
  CleanRunResult,
  CleanScanResult,
  ComponentsData,
  DisksInfo,
  DriverInstallResult,
  DriverScan,
  EndResult,
  FreeRamResult,
  GpuInfo,
  HealthData,
  HistoryPoint,
  InstalledDrivers,
  Live,
  MemoryDetails,
  MonitorConfig,
  MonitorInfo,
  Platform,
  RamHealthData,
  ScanNode,
  StartupApp,
  SystemInfo,
  UpdateInfo,
  UpdateStart,
  WindowsBatteryInfo,
} from './types';

export interface WindowsApi {
  elevate(): Promise<{ ok: boolean }>;
  installDriver(): Promise<{ ok: boolean; code: number }>;
  reloadSensors(): Promise<unknown>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
  fanSet(id: string, percent: number): Promise<unknown>;
  fanAuto(id: string): Promise<unknown>;
  fanAutoAll(): Promise<unknown>;
  gpuInfo(): Promise<GpuInfo>;
  gpuPowerLimit(index: number, watts: number): Promise<unknown>;
  gpuClockLimit(index: number, maxMHz: number): Promise<unknown>;
  gpuClockReset(index: number): Promise<unknown>;
  gpuPrefSet(path: string, pref: number): Promise<unknown>;
  hagsSet(on: boolean): Promise<unknown>;
  cleanCancel(): Promise<unknown>;
  setProgress(value: number): void;
  notify(title: string, body: string): void;
  batteryInfo(): Promise<WindowsBatteryInfo>;
  batteryReport(): Promise<BatteryReport | null>;
  batterySet(key: string, value: number): Promise<unknown>;
  startupList(): Promise<StartupApp[]>;
  startupSet(id: string, on: boolean): Promise<unknown>;
  ramHealth(): Promise<RamHealthData>;
  ramTestStart(): Promise<unknown>;
  ramTestCancel(): Promise<unknown>;
  ramDiagnostic(): Promise<unknown>;
  driversScan(): Promise<DriverScan>;
  driversInstalled(): Promise<InstalledDrivers>;
  driversInstall(ids: string[], allowNoRestorePoint: boolean): Promise<DriverInstallResult>;
}

export interface AndroidApi {
  permissions(): Promise<AndroidPermissions>;
  requestUsageAccess(): Promise<unknown>;
  requestAllFiles(): Promise<unknown>;
  clearAllCaches(): Promise<{ launched: boolean; reason?: string }>;
  openAppInfo(packageName: string): Promise<unknown>;
  openStorageSettings(): Promise<unknown>;
  storage(): Promise<AndroidStorage>;
  batteryInfo(): Promise<AndroidBatteryInfo>;
  batterySet(key: string, value: number): Promise<unknown>;
  openSystemScreen(screen: string): Promise<unknown>;
  requestNotifications(): Promise<unknown>;
}

export interface Bridge {
  platform: Platform;
  /** Only while developing in a browser: the data is made up. */
  isDemo?: boolean;
  system(): Promise<SystemInfo>;
  live(): Promise<Live>;
  memory(): Promise<MemoryDetails>;
  freeRam(standby: boolean): Promise<FreeRamResult>;
  endProcess(pids: number[], force: boolean): Promise<EndResult>;
  disks(): Promise<DisksInfo>;
  health(): Promise<HealthData>;
  cleanScan(): Promise<CleanScanResult>;
  cleanRun(ids: string[]): Promise<CleanRunResult>;
  scanStart(path: string): Promise<unknown>;
  scanCancel(): Promise<unknown>;
  scanNode(path: string): Promise<ScanNode>;
  onEvent(cb: (name: string, data: any) => void): () => void;
  fileIcon(path: string): Promise<string | null>;
  reveal(path: string): void;
  trash(path: string): Promise<unknown>;
  components(): Promise<ComponentsData>;
  /** Opens a link in the system browser. */
  openLink(url: string): void;
  monitorGet(): Promise<MonitorInfo>;
  monitorSet(config: MonitorConfig): Promise<unknown>;
  monitorHistory(): Promise<HistoryPoint[]>;
  setAutostart(on: boolean): Promise<unknown>;
  updateCheck(): Promise<UpdateInfo>;
  updateInstall(onProgress: (percent: number) => void): Promise<UpdateStart>;
  win?: WindowsApi;
  android?: AndroidApi;
}

declare global {
  const __APP_VERSION__: string;
  interface Window {
    gultraNative?: {
      rpc(method: string, params?: unknown): Promise<any>;
      window(action: string): Promise<void>;
      elevate(): Promise<{ ok: boolean }>;
      installDriver(): Promise<{ ok: boolean; code: number }>;
      updateCheck(): Promise<UpdateInfo>;
      updateInstall(): Promise<UpdateStart>;
      reveal(path: string): Promise<void>;
      trash(path: string): Promise<boolean>;
      openLink(url: string): Promise<void>;
      fileIcon(path: string): Promise<string | null>;
      setProgress(value: number): Promise<void>;
      notify(title: string, body: string): Promise<void>;
      onEvent(cb: (name: string, data: any) => void): () => void;
    };
  }
}

function windowsBridge(): Bridge {
  const n = window.gultraNative!;
  return {
    platform: 'windows',
    system: () => n.rpc('system'),
    live: () => n.rpc('live'),
    memory: () => n.rpc('memory'),
    freeRam: (standby) => n.rpc('freeRam', { standby }),
    endProcess: (pids, force) => n.rpc('endProcess', { pids, force }),
    disks: () => n.rpc('disks'),
    health: () => n.rpc('health'),
    cleanScan: () => n.rpc('cleanScan'),
    cleanRun: (ids) => n.rpc('cleanRun', { ids }),
    scanStart: (path) => n.rpc('scanStart', { path }),
    scanCancel: () => n.rpc('scanCancel'),
    scanNode: (path) => n.rpc('scanNode', { path }),
    onEvent: (cb) => n.onEvent(cb),
    fileIcon: (p) => n.fileIcon(p),
    reveal: (p) => void n.reveal(p),
    trash: (p) => n.trash(p),
    components: () => n.rpc('components'),
    openLink: (url) => void n.openLink(url),
    monitorGet: () => n.rpc('monitorGet'),
    monitorSet: (config) => n.rpc('monitorSet', { config }),
    monitorHistory: () => n.rpc('monitorHistory'),
    setAutostart: (on) => n.rpc('autostartSet', { on }),
    updateCheck: () => n.updateCheck(),
    updateInstall: (onProgress) => {
      const off = n.onEvent((name, data) => {
        if (name === 'updateProgress') onProgress(data.percent);
      });
      return n.updateInstall().finally(off);
    },
    win: {
      elevate: () => n.elevate(),
      installDriver: () => n.installDriver(),
      reloadSensors: () => n.rpc('sensorsReload'),
      windowAction: (a) => void n.window(a),
      fanSet: (id, percent) => n.rpc('fanSet', { id, percent }),
      fanAuto: (id) => n.rpc('fanAuto', { id }),
      fanAutoAll: () => n.rpc('fanAutoAll'),
      gpuInfo: () => n.rpc('gpuInfo'),
      gpuPowerLimit: (index, watts) => n.rpc('gpuPowerLimit', { index, watts }),
      gpuClockLimit: (index, maxMHz) => n.rpc('gpuClockLimit', { index, maxMHz }),
      gpuClockReset: (index) => n.rpc('gpuClockReset', { index }),
      gpuPrefSet: (path, pref) => n.rpc('gpuPrefSet', { path, pref }),
      hagsSet: (on) => n.rpc('hagsSet', { on }),
      cleanCancel: () => n.rpc('cleanCancel'),
      setProgress: (value) => void n.setProgress(value),
      notify: (title, body) => void n.notify(title, body),
      batteryInfo: () => n.rpc('batteryInfo'),
      batteryReport: () => n.rpc('batteryReport'),
      batterySet: (key, value) => n.rpc('batterySet', { key, value }),
      startupList: () => n.rpc('startupList'),
      startupSet: (id, on) => n.rpc('startupSet', { id, on }),
      ramHealth: () => n.rpc('ramHealth'),
      ramTestStart: () => n.rpc('ramTestStart'),
      ramTestCancel: () => n.rpc('ramTestCancel'),
      ramDiagnostic: () => n.rpc('ramDiagnostic'),
      driversScan: () => n.rpc('driversScan'),
      driversInstalled: () => n.rpc('driversInstalled'),
      driversInstall: (ids, allowNoRestorePoint) => n.rpc('driversInstall', { ids, allowNoRestorePoint }),
    },
  };
}

interface GUltraPlugin {
  system(): Promise<any>;
  live(): Promise<any>;
  memory(): Promise<any>;
  freeRam(): Promise<any>;
  health(): Promise<any>;
  disks(): Promise<any>;
  cleanScan(): Promise<any>;
  clearOwnCache(): Promise<any>;
  permissions(): Promise<any>;
  requestUsageAccess(): Promise<any>;
  requestAllFiles(): Promise<any>;
  clearAllCaches(): Promise<any>;
  openAppInfo(o: { packageName: string }): Promise<any>;
  openStorageSettings(): Promise<any>;
  storage(): Promise<any>;
  appIcon(o: { packageName: string }): Promise<{ icon: string | null }>;
  batteryInfo(): Promise<any>;
  batterySet(o: { key: string; value: number }): Promise<any>;
  openSystemScreen(o: { screen: string }): Promise<any>;
  openUrl(o: { url: string }): Promise<any>;
  components(): Promise<any>;
  monitorGet(): Promise<any>;
  monitorSet(o: { config: MonitorConfig }): Promise<any>;
  monitorHistory(): Promise<{ points: HistoryPoint[] }>;
  monitorAutostart(o: { on: boolean }): Promise<any>;
  requestNotifications(): Promise<any>;
  updateCheck(): Promise<UpdateInfo>;
  updateInstall(): Promise<UpdateStart>;
  addListener(name: 'updateProgress', cb: (d: { percent: number }) => void): Promise<{ remove(): Promise<void> }>;
}

// Android has no public way to name the GPU, but WebGL reports it.
function gpuFromWebGL(): { name: string; maker: string } | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (!gl || !ext) return null;
    return { name: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)), maker: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) };
  } catch {
    return null;
  }
}

function androidBridge(): Bridge {
  const p = registerPlugin<GUltraPlugin>('GUltra');
  const unsupported = () => Promise.reject(new Error('Not available on Android.'));
  return {
    platform: 'android',
    system: async () => {
      const s = await p.system();
      // WebView doesn't always report env(safe-area-inset-*), so these are set directly.
      const root = document.documentElement.style;
      if (s.insetTop != null) root.setProperty('--sat', `${s.insetTop}px`);
      if (s.insetBottom != null) root.setProperty('--sab', `${s.insetBottom}px`);
      return s;
    },
    live: () => p.live(),
    memory: () => p.memory(),
    freeRam: () => p.freeRam(),
    endProcess: unsupported,
    disks: () => p.disks(),
    health: () => p.health(),
    cleanScan: () => p.cleanScan(),
    cleanRun: async () => {
      const r = await p.clearOwnCache();
      return { freed: r.freed ?? 0, files: 0, skipped: 0, results: [] };
    },
    scanStart: unsupported,
    scanCancel: () => Promise.resolve(),
    scanNode: unsupported,
    onEvent: () => () => {},
    fileIcon: (packageName) => p.appIcon({ packageName }).then((r) => r.icon, () => null),
    reveal: () => {},
    trash: unsupported,
    components: async () => {
      const data: ComponentsData = await p.components();
      const gpu = gpuFromWebGL();
      if (gpu) {
        const after = data.groups.findIndex((g) => g.id === 'cpu');
        data.groups.splice(after + 1, 0, {
          id: 'gpu',
          title: 'Graphics',
          items: [{ name: gpu.name, replace: 'no', note: 'Built into the processor.', search: null, specs: [['Maker', gpu.maker]] }],
        });
      }
      return data;
    },
    openLink: (url) => void p.openUrl({ url }),
    monitorGet: () => p.monitorGet(),
    monitorSet: (config) => p.monitorSet({ config }),
    monitorHistory: () => p.monitorHistory().then((r) => r.points),
    setAutostart: (on) => p.monitorAutostart({ on }),
    updateCheck: () => p.updateCheck(),
    updateInstall: async (onProgress) => {
      const listener = await p.addListener('updateProgress', (d) => onProgress(d.percent));
      try {
        return await p.updateInstall();
      } finally {
        void listener.remove();
      }
    },
    android: {
      permissions: () => p.permissions(),
      requestUsageAccess: () => p.requestUsageAccess(),
      requestAllFiles: () => p.requestAllFiles(),
      clearAllCaches: () => p.clearAllCaches(),
      openAppInfo: (packageName) => p.openAppInfo({ packageName }),
      openStorageSettings: () => p.openStorageSettings(),
      storage: () => p.storage(),
      batteryInfo: () => p.batteryInfo(),
      batterySet: (key, value) => p.batterySet({ key, value }),
      openSystemScreen: (screen) => p.openSystemScreen({ screen }),
      requestNotifications: () => p.requestNotifications(),
    },
  };
}

export let bridge: Bridge;

export async function initBridge(): Promise<boolean> {
  if (window.gultraNative) {
    bridge = windowsBridge();
    return true;
  }
  if (Capacitor.getPlatform() === 'android') {
    bridge = androidBridge();
    return true;
  }
  // Demo data only while developing in a browser; it never reaches the shipped apps.
  if (import.meta.env.DEV) {
    const { demoBridge } = await import('./demo');
    bridge = demoBridge(new URLSearchParams(location.search).get('os') === 'android');
    return true;
  }
  return false;
}
