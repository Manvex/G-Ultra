// Made-up data, only for working on the UI in a browser. It never reaches the shipped apps:
// bridge.ts loads it only when import.meta.env.DEV is true, and the UI shows a "Demo data" badge.
import type { Bridge } from './bridge';
import type { GpuInfo, Live, ProcessItem } from './types';

const GB = 1024 ** 3;
const proc = (key: string, title: string, mem: number, cpu: number, critical = false): ProcessItem => ({ key, name: key, title, path: `C:\\Program Files\\${key}\\${key}.exe`, pids: [1], mem: mem * GB, cpu, disk: 0, critical, usageMs: mem * 3600000 });

export function demoBridge(android: boolean): Bridge {
  let t = 0;
  const manual = new Map<string, number>();
  const fan = (id: string, name: string, hardware: string, group: string, rpm: number) => ({
    id,
    name,
    hardware,
    group,
    rpm: manual.has(id) ? Math.round((manual.get(id)! / 100) * 3200) : rpm,
    percent: manual.get(id) ?? 42,
    canControl: true,
    manual: manual.has(id),
    minPercent: 30,
    maxPercent: 100,
  });

  const live = async (): Promise<Live> => {
    t += 1;
    const wobble = Math.sin(t / 5);
    return {
      ts: Date.now(),
      cpu: { usage: 24 + wobble * 10, perCore: android ? [] : [30, 12, 44, 8, 25, 18, 60, 10], freqMHz: 2800, baseMHz: 2400, usageIsFrequency: android },
      mem: { total: 16 * GB, available: 6.4 * GB, used: 9.6 * GB, load: 60, standby: 5.2 * GB, modified: android ? 0 : 0.2 * GB, free: 1.2 * GB, commit: 12 * GB, commitLimit: 24 * GB, swapTotal: 8 * GB },
      disk: android ? null : { activePct: 4, readBps: 1e5, writeBps: 2e6 },
      processes: [proc('browser', 'Browser', 2.1, 12), proc('editor', 'Editor', 1.4, 6), proc('music', 'Music', 0.5, 1), proc('svchost', 'svchost', 0.4, 0.8, !android), proc('chat', 'Chat', 0.3, 0.5)],
      sensors: [
        { id: 'cpu', name: 'CPU Package', group: 'cpu', celsius: 58 + wobble * 6, source: 'demo', approximate: false },
        { id: 'c1', name: 'Core 1', group: 'cpu', celsius: 55 + wobble * 5, source: 'demo', approximate: false },
        ...(android ? [] : [{ id: 'gpu', name: 'Demo GPU · Core', group: 'gpu' as const, celsius: 64 + wobble * 4, source: 'demo', approximate: false }]),
        { id: 'ssd', name: 'SSD', group: 'storage', celsius: 41, source: 'demo', approximate: false },
        { id: 'bat', name: 'Battery', group: 'battery', celsius: 32, source: 'demo', approximate: false },
      ],
      gpus: android ? [] : [{ id: '/gpu/0', name: 'Demo GPU 4070', vendor: 'nvidia', load: 46 + wobble * 12, coreMHz: 2010, memMHz: 9500, watts: 118.4, tempC: 64 + wobble * 4, hotspotC: 76, vramUsedMB: 4300, vramTotalMB: 12288 }],
      fans: android ? [] : [fan('board-1', 'Fan 1', 'Demo motherboard', 'board', 1180), fan('board-2', 'Fan 2', 'Demo motherboard', 'board', 960), fan('gpu-1', 'GPU Fan', 'Demo GPU 4070', 'gpu', 1420)],
      throttling: false,
      thermalStatus: android ? 0 : null,
      thermalHeadroom: android ? 0.4 : null,
      power: { percent: 72, charging: false, onAc: false, watts: 8.2 },
      elevated: !android,
    };
  };
  const health = {
    platform: 'demo' as const,
    disks: [{ index: 0, model: 'Demo SSD', size: 512 * GB, bus: 'NVMe', media: 'SSD', status: 'ok', letters: ['C:'], smart: { source: 'demo', tempC: 41, percentUsed: 8, availableSpare: 100, spareThreshold: 5, dataWritten: 2.4e13, dataRead: 3.1e13, powerOnHours: 4200, powerCycles: 900, unsafeShutdowns: 12, mediaErrors: 0 }, smartReason: null }],
    battery: { present: true, designCapacity: 52000, fullCapacity: 44000, unit: 'mWh', healthPct: 84.6, cycles: 310, chemistry: 'Lithium-ion' },
    hardwareErrors: android ? null : 0,
    unexpectedShutdowns: android ? null : 1,
    uptimeSec: 86400,
  };
  const gpuInfo: GpuInfo = {
    nvidia: [{ index: 0, name: 'Demo GPU 4070', powerW: 200, minW: 100, maxW: 220, defaultW: 200, maxClockMHz: 2610 }],
    hags: { state: 'on', canSet: true },
    prefs: [],
    elevated: true,
  };
  const later = <T,>(v: T, ms = 400) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  return {
    platform: android ? 'android' : 'demo',
    isDemo: true,
    system: async () => ({ platform: 'demo', deviceName: android ? 'Demo phone' : 'Demo PC', osName: android ? 'Android 15' : 'Windows 11', cpuName: 'Demo processor', cores: 8, threads: 8, gpus: android ? [] : ['Demo GPU 4070'], isLaptop: false, elevated: !android, uptimeSec: 86400, sensorDriver: android ? undefined : { installed: true, elevated: true, cpuSensors: 2, libLoaded: true, error: null } }),
    live,
    memory: async () => ({
      platform: 'demo',
      installed: 16 * GB,
      type: 'DDR4',
      speed: 3200,
      slotsTotal: 2,
      slotsUsed: 1,
      maxCapacity: 64 * GB,
      dualChannel: null,
      modules: [{ slot: 'Slot 1', manufacturer: 'Maker', partNumber: 'DEMO-1234', capacity: 16 * GB, type: 'DDR4', form: 'SO-DIMM', speed: 3200, voltage: 1.2, soldered: false }],
      upgrade: { verdict: 'yes', title: 'You can add more RAM', details: ['1 free slot out of 2.'] },
    }),
    freeRam: () => later({ before: 5 * GB, after: 6 * GB, freed: GB, trimmed: 40, denied: 10, standbyPurged: false, standbyError: 'admin', elevated: false }, 1500),
    endProcess: () => later({ closed: 1, remaining: 0, asked: 1, failed: 0, refused: 0 }),
    disks: async () => ({ platform: 'demo', volumes: [{ path: 'C:\\', letter: android ? '' : 'C:', label: 'System', fs: 'NTFS', total: 512 * GB, free: 120 * GB, removable: false, system: true, model: 'Demo SSD', media: 'SSD', bus: 'NVMe' }] }),
    health: async () => health,
    cleanScan: () => later({ platform: 'demo', elevated: false, categories: [{ id: 'temp', group: 'system', name: 'Temporary files', desc: 'Demo category.', bytes: 800 * 1024 ** 2, files: 100, needsAdmin: false, defaultOn: true, busy: false }] }),
    cleanRun: () => later({ freed: 800 * 1024 ** 2, files: 100, skipped: 0, results: [] }, 3000),
    scanStart: async () => ({}),
    scanCancel: async () => ({}),
    scanNode: async () => ({ path: 'C:', name: 'C:', size: 0, files: 0, ownBytes: 0, folders: [], items: [], largest: [], denied: 0, isRoot: true }),
    onEvent: () => () => {},
    fileIcon: async () => null,
    reveal: () => {},
    trash: async () => {},
    components: async () => ({
      platform: 'demo',
      groups: [
        { id: 'cpu', title: 'Processor', items: [{ name: 'Demo processor', replace: 'no', note: 'Soldered to the motherboard.', search: 'Demo processor', specs: [['Cores', '8'], ['Socket', 'BGA']] }] },
        { id: 'ram', title: 'Memory', items: [{ name: 'Maker 16 GB DDR4 SO-DIMM', replace: 'yes', note: null, search: 'DEMO-1234', specs: [['Part number', 'DEMO-1234'], ['Speed', '3200 MT/s']] }] },
      ],
    }),
    openLink: () => {},
    monitorGet: async () => ({
      config: {
        enabled: true,
        mode: 'economy',
        notifications: true,
        ram: { enabled: true, threshold: 85, standby: true, cooldownMin: 10, closeApps: false },
        ramTimer: { enabled: false, everyMin: 30, closeApps: false },
        closeApps: [],
        temp: { enabled: true, threshold: 85, limitCpu: true, limitPercent: 80 },
        fan: { mode: 'curve', percent: 50, lowTemp: 50, lowPercent: 35, highTemp: 80, highPercent: 100 },
        clean: { enabled: false, freeGb: 10 },
        battery: { alert: true, alertPercent: 80, efficiency: false, lowPercent: 20 },
      },
      running: true,
      autostart: true,
      elevated: true,
      events: [{ ts: Date.now() - 600000, kind: 'ram', text: 'Memory reached 86%. Freed 1.2 GB.' }],
      canCloseApps: !android,
      notificationsAllowed: true,
    }),
    monitorSet: async () => ({}),
    monitorHistory: async () => Array.from({ length: 120 }, (_, i) => ({ t: Date.now() - (120 - i) * 60000, cpu: 20 + (i % 17), mem: 55 + (i % 11), temp: 50 + (i % 13) })),
    setAutostart: async () => ({}),
    win: android
      ? undefined
      : {
          elevate: async () => ({ ok: false }),
          installDriver: async () => ({ ok: false, code: 1 }),
          reloadSensors: async () => ({}),
          windowAction: () => {},
          fanSet: async (id, percent) => {
            manual.set(id, Math.max(30, percent));
          },
          fanAuto: async (id) => {
            manual.delete(id);
          },
          fanAutoAll: async () => {
            manual.clear();
          },
          gpuInfo: async () => gpuInfo,
          gpuPowerLimit: async (_i, watts) => {
            gpuInfo.nvidia[0].powerW = watts;
          },
          gpuClockLimit: async () => ({}),
          gpuClockReset: async () => ({}),
          gpuPrefSet: async () => ({}),
          hagsSet: async () => ({}),
          cleanCancel: async () => ({}),
          setProgress: () => {},
          notify: () => {},
          batteryInfo: async () => ({ present: true, percent: 72, charging: false, onAc: false, watts: 8.2, secondsLeft: 12000, saverOn: false, saverThreshold: 20, powerMode: 'balanced', brightness: 60, screenOffSec: 300, sleepSec: 600, cpuMax: 100, refresh: { current: 60, options: [60, 120] }, health: health.battery }),
          batteryReport: async () => ({ history: [{ date: '2026-01-01', full: 48000 }, { date: '2026-07-01', full: 46000 }, { date: '2026-11-01', full: 44000 }], design: 52000, cycles: 310, runtimeSec: 18000, designRuntimeSec: 21000, wearPerYear: 9, yearsTo60: 2.7 }),
          batterySet: async () => ({}),
          startupList: async () => [{ id: 'a', title: 'Demo app', path: null, enabled: true, needsAdmin: false }],
          startupSet: async () => ({}),
          ramHealth: async () => ({
            platform: 'demo',
            verdict: 'good',
            title: 'No signs of trouble',
            summary: 'RAM doesn\'t wear out the way SSDs and batteries do.',
            checks: [{ id: 'whea', label: 'Hardware memory errors', status: 'good', value: 'None', detail: 'No memory errors logged by Windows in the last 90 days.' }],
            modules: [{ slot: 'Slot 1', manufacturer: 'Maker', partNumber: 'DEMO-1234', capacity: 16 * GB, ratedSpeed: 3200, configuredSpeed: 3200, tempC: 42 }],
          }),
          ramTestStart: async () => ({}),
          ramTestCancel: async () => ({}),
          ramDiagnostic: async () => ({}),
        },
    android: android
      ? {
          permissions: async () => ({ usageAccess: true, allFiles: false, canClearAllCaches: false, sdk: 35 }),
          requestUsageAccess: async () => {},
          requestAllFiles: async () => {},
          clearAllCaches: async () => ({ launched: false, reason: 'needsAllFiles' }),
          openAppInfo: async () => {},
          openStorageSettings: async () => {},
          batteryInfo: async () => ({ percent: 72, charging: false, tempC: 31, plugged: null, watts: 1.8, chargeTimeSec: null, powerSave: false, canWrite: true, brightness: 60, adaptiveBrightness: true, screenTimeoutSec: 30, health: { ...health.battery, unit: 'mAh', designCapacity: 5000, fullCapacity: 4300, healthPct: 86, estimated: true } }),
          batterySet: async () => ({}),
          openSystemScreen: async () => ({}),
          requestNotifications: async () => ({}),
          storage: async () => ({
            total: 128 * GB,
            free: 40 * GB,
            system: 20 * GB,
            usageAccess: true,
            allFiles: false,
            media: { images: 12 * GB, video: 18 * GB, audio: GB, documents: GB, downloads: 3 * GB },
            largest: [],
            apps: [
              { packageName: 'a', label: 'App 1', appBytes: 2 * GB, dataBytes: 3 * GB, cacheBytes: 1.2 * GB, totalBytes: 6.2 * GB, system: false },
              { packageName: 'b', label: 'App 2', appBytes: GB, dataBytes: GB, cacheBytes: 0.6 * GB, totalBytes: 2.6 * GB, system: false },
            ],
          }),
        }
      : undefined,
  };
}
