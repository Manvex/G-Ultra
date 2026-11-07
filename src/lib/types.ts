export type Platform = 'windows' | 'android' | 'demo';

export interface SensorDriverState {
  installed: boolean;
  elevated: boolean;
  cpuSensors: number;
  libLoaded: boolean;
  error: string | null;
}

export interface SystemInfo {
  platform: Platform;
  deviceName: string;
  manufacturer?: string;
  model?: string;
  osName: string;
  osBuild?: string;
  cpuName: string;
  cores: number;
  threads: number;
  gpus: string[];
  isLaptop?: boolean;
  hasBattery?: boolean;
  elevated: boolean;
  uptimeSec: number;
  sensorDriver?: SensorDriverState;
}

export type SensorGroup = 'cpu' | 'gpu' | 'storage' | 'battery' | 'board' | 'memory' | 'skin' | 'fan' | 'other';

export interface Sensor {
  id: string;
  name: string;
  group: SensorGroup;
  celsius?: number;
  rpm?: number;
  source: string;
  approximate: boolean;
}

export interface ProcessItem {
  key: string;
  name: string;
  title: string;
  path?: string | null;
  pids: number[];
  cpu: number;
  mem: number;
  disk: number;
  critical: boolean;
  icon?: string | null;
  usageMs?: number;
  lastUsed?: number;
}

export interface Live {
  ts: number;
  cpu: {
    usage: number | null;
    perCore: number[];
    freqMHz: number | null;
    baseMHz: number | null;
    maxMHz?: number | null;
    /** Android has no CPU load figure, so this is the share of the top frequency in use. */
    usageIsFrequency?: boolean;
  };
  mem: {
    total: number;
    available: number;
    used: number;
    load: number;
    standby: number;
    modified: number;
    free: number;
    commit: number;
    commitLimit: number;
    swapTotal: number;
    swapUsed?: number;
    low?: boolean;
  };
  disk: { activePct: number; readBps: number; writeBps: number } | null;
  processes: ProcessItem[];
  sensors: Sensor[];
  gpus?: GpuSample[];
  fans?: FanInfo[];
  throttling: boolean | null;
  thermalStatus?: number | null;
  thermalHeadroom?: number | null;
  power: { percent: number | null; charging: boolean; onAc: boolean; watts: number | null } | null;
  elevated: boolean;
}

export interface RamModule {
  slot: string;
  bank?: string;
  manufacturer: string;
  partNumber: string;
  capacity: number;
  type: string | null;
  form: string | null;
  speed: number;
  configuredSpeed?: number;
  voltage?: number | null;
  soldered: boolean;
}

export interface MemoryDetails {
  platform: Platform;
  installed: number;
  type: string | null;
  typeNote?: string | null;
  speed: number;
  slotsTotal: number;
  slotsUsed: number;
  maxCapacity: number | null;
  /** How the maximum splits across slots, such as "2 x 32 GB". */
  maxConfig?: string | null;
  maxSource?: string | null;
  dualChannel: boolean | null;
  modules: RamModule[];
  upgrade: { verdict: 'yes' | 'replace' | 'no' | 'unknown'; title: string; details: string[] };
}

export interface FreeRamResult {
  before: number;
  after: number;
  freed: number;
  trimmed: number;
  denied: number;
  standbyPurged: boolean;
  standbyError: string | null;
  elevated: boolean;
  /** Android 14+: the system no longer allows stopping other apps. */
  restricted?: boolean;
}

export interface EndResult {
  closed: number;
  remaining: number;
  asked: number;
  failed: number;
  refused: number;
}

export interface Volume {
  path: string;
  letter: string;
  label: string;
  fs: string;
  total: number;
  free: number;
  removable: boolean;
  system: boolean;
  model: string | null;
  media: string | null;
  bus: string | null;
}

export interface DisksInfo {
  platform: Platform;
  volumes: Volume[];
}

export interface SmartData {
  source: string;
  tempC?: number | null;
  percentUsed?: number | null;
  availableSpare?: number | null;
  spareThreshold?: number | null;
  dataWritten?: number | null;
  dataRead?: number | null;
  powerOnHours?: number | null;
  powerCycles?: number | null;
  unsafeShutdowns?: number | null;
  mediaErrors?: number | null;
  errorLogEntries?: number | null;
  criticalWarning?: number | null;
}

export interface DiskHealth {
  index: number;
  model: string;
  size: number;
  bus: string | null;
  media: string | null;
  status: string | null;
  letters: string[];
  smart: SmartData | null;
  smartReason: 'admin' | 'unsupported' | 'os' | null;
}

export interface BatteryHealth {
  present: boolean;
  designCapacity: number | null;
  fullCapacity: number | null;
  unit: string;
  healthPct: number | null;
  /** Worked out from the charge counter, not reported directly by the battery. */
  estimated?: boolean;
  cycles: number | null;
  chemistry: string | null;
  name?: string | null;
  manufacturer?: string | null;
  status?: string | null;
  tempC?: number | null;
  voltage?: number | null;
}

export interface HealthData {
  platform: Platform;
  disks: DiskHealth[];
  battery: BatteryHealth | null;
  hardwareErrors: number | null;
  unexpectedShutdowns: number | null;
  uptimeSec: number;
}

export interface CleanCategory {
  id: string;
  group: string;
  name: string;
  desc: string;
  note?: string | null;
  bytes: number | null;
  files: number;
  needsAdmin: boolean;
  defaultOn: boolean;
  busy: boolean;
}

export interface CleanScanResult {
  platform: Platform;
  categories: CleanCategory[];
  elevated: boolean;
}

export interface CleanRunResult {
  freed: number;
  files: number;
  skipped: number;
  cancelled?: boolean;
  results: { id: string; name: string; freed: number; files: number; skipped: number; error?: string }[];
}

export interface ScanEntry {
  name: string;
  path: string;
  size: number;
  files?: number;
  isDir?: boolean;
}

export interface ScanNode {
  path: string;
  name: string;
  size: number;
  files: number;
  ownBytes: number;
  folders: ScanEntry[];
  items: ScanEntry[];
  largest: ScanEntry[] | null;
  denied: number;
  isRoot: boolean;
}

export interface ScanProgress {
  state: 'running' | 'done';
  path: string | null;
  files: number;
  dirs: number;
  bytes: number;
  denied: number;
  current: string | null;
}

// ---- Android only ----
export interface AndroidPermissions {
  usageAccess: boolean;
  allFiles: boolean;
  canClearAllCaches: boolean;
  sdk: number;
}

export interface AppStorageItem {
  packageName: string;
  label: string;
  appBytes: number;
  dataBytes: number;
  cacheBytes: number;
  totalBytes: number;
  system: boolean;
}

export interface AndroidStorage {
  total: number;
  free: number;
  system: number;
  apps: AppStorageItem[];
  media: { images: number; video: number; audio: number; documents: number; downloads: number } | null;
  largest: ScanEntry[];
  usageAccess: boolean;
  allFiles: boolean;
}

// ---- Windows graphics and fans ----
export interface GpuSample {
  id: string;
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel';
  load: number | null;
  coreMHz: number | null;
  memMHz: number | null;
  watts: number | null;
  tempC: number | null;
  hotspotC: number | null;
  vramUsedMB: number | null;
  vramTotalMB: number | null;
}

export interface FanInfo {
  id: string;
  name: string;
  hardware: string;
  group: string;
  rpm: number | null;
  percent: number | null;
  canControl: boolean;
  manual: boolean;
  minPercent: number;
  maxPercent: number;
}

export interface NvidiaGpu {
  index: number;
  name: string;
  powerW: number | null;
  minW: number | null;
  maxW: number | null;
  defaultW: number | null;
  maxClockMHz: number | null;
}

export interface GpuPref {
  path: string;
  name: string;
  /** 0 = let Windows decide, 1 = power saving, 2 = high performance */
  pref: number;
  exists: boolean;
}

export interface GpuInfo {
  nvidia: NvidiaGpu[];
  hags: { state: 'on' | 'off' | 'default'; canSet: boolean };
  prefs: GpuPref[];
  elevated: boolean;
}

// ---- battery ----
export interface StartupApp {
  id: string;
  title: string;
  path: string | null;
  enabled: boolean;
  needsAdmin: boolean;
}

export interface WindowsBatteryInfo {
  present: boolean;
  percent: number | null;
  charging: boolean;
  onAc: boolean;
  watts: number | null;
  secondsLeft: number | null;
  saverOn: boolean;
  saverThreshold: number | null;
  powerMode: 'efficiency' | 'balanced' | 'performance' | null;
  brightness: number | null;
  screenOffSec: number | null;
  sleepSec: number | null;
  cpuMax: number | null;
  refresh: { current: number; options: number[] } | null;
  health: BatteryHealth | null;
}

export interface BatteryReport {
  history: { date: string; full: number }[];
  design: number;
  cycles: number | null;
  runtimeSec: number | null;
  designRuntimeSec: number | null;
  wearPerYear: number | null;
  yearsTo60: number | null;
}

export interface AndroidBatteryInfo {
  percent: number | null;
  charging: boolean;
  tempC: number | null;
  plugged: 'ac' | 'usb' | 'wireless' | null;
  watts: number | null;
  chargeTimeSec: number | null;
  powerSave: boolean;
  canWrite: boolean;
  brightness: number | null;
  adaptiveBrightness: boolean;
  screenTimeoutSec: number | null;
  health: BatteryHealth | null;
}

// ---- components ----
export interface ComponentItem {
  name: string;
  replace: 'yes' | 'tech' | 'no' | 'check' | null;
  note: string | null;
  search: string | null;
  specs: [string, string][];
}

export interface ComponentGroup {
  id: string;
  title: string;
  items: ComponentItem[];
}

export interface ComponentsData {
  platform: Platform;
  device?: string;
  groups: ComponentGroup[];
}

// ---- background monitor ----
export interface MonitorConfig {
  enabled: boolean;
  mode: 'economy' | 'balanced' | 'realtime';
  notifications: boolean;
  ram: { enabled: boolean; threshold: number; standby: boolean; cooldownMin: number; closeApps: boolean };
  ramTimer: { enabled: boolean; everyMin: number; closeApps: boolean };
  closeApps: string[];
  temp: { enabled: boolean; threshold: number; limitCpu: boolean; limitPercent: number };
  fan: { mode: 'auto' | 'fixed' | 'curve'; percent: number; lowTemp: number; lowPercent: number; highTemp: number; highPercent: number };
  clean: { enabled: boolean; freeGb: number };
  battery: { alert: boolean; alertPercent: number; efficiency: boolean; lowPercent: number };
}

export interface MonitorEvent {
  ts: number;
  kind: string;
  text: string;
}

export interface MonitorInfo {
  config: MonitorConfig;
  running: boolean;
  autostart: boolean;
  elevated: boolean;
  cpuLimited?: boolean;
  events: MonitorEvent[];
  canCloseApps?: boolean;
  notificationsAllowed?: boolean;
}

export interface HistoryPoint {
  t: number;
  cpu: number | null;
  mem: number;
  temp: number | null;
}

// ---- RAM health ----
export interface RamCheck {
  id: string;
  label: string;
  status: 'good' | 'warn' | 'bad' | 'info' | 'unknown';
  value: string;
  detail: string;
}

export interface RamHealthModule {
  slot: string;
  manufacturer: string;
  partNumber: string;
  capacity: number;
  ratedSpeed: number;
  configuredSpeed: number;
  tempC: number | null;
}

export interface RamHealthData {
  platform: Platform;
  verdict: 'good' | 'watch' | 'bad';
  title: string;
  summary: string;
  checks: RamCheck[];
  modules: RamHealthModule[];
}

export interface RamTestState {
  state: 'running' | 'done' | 'cancelled' | 'failed';
  percent?: number;
  errors?: number;
  testedBytes?: number;
  message?: string;
}
