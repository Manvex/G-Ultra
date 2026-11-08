package com.gultra.app;

import android.app.ActivityManager;
import android.app.AppOpsManager;
import android.app.usage.StorageStats;
import android.app.usage.StorageStatsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Process;
import android.os.SystemClock;
import android.os.storage.StorageManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Real data from the phone, in the same shape as the Windows helper.
 * Anything Android doesn't allow stays null and the UI explains why: values are never made up.
 */
@CapacitorPlugin(name = "GUltra")
public class GUltraPlugin extends Plugin {

    private static final long MONITOR_START_DELAY_MS = 6000;

    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    // Long jobs get their own threads, so they can't use up the pool or delay live data.
    private final ExecutorService heavy = Executors.newSingleThreadExecutor();
    private final ExecutorService readings = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, String> iconCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> labelCache = new ConcurrentHashMap<>();

    @Override
    public void load() {
        // After the app has finished opening: until then the page needs the main thread,
        // and Android ends an app whose service is late to show its notification.
        new Handler(Looper.getMainLooper()).postDelayed(this::startMonitor, MONITOR_START_DELAY_MS);
    }

    private void startMonitor() {
        try {
            if (MonitorStore.config(getContext()).optBoolean("enabled", true)) MonitorService.start(getContext());
        } catch (Exception ignored) {
            // Android refuses this if the app has already left the screen. The next opening tries again.
        }
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdown();
        heavy.shutdown();
        readings.shutdown();
    }

    private interface Job {
        JSObject run() throws Exception;
    }

    private void async(PluginCall call, Job job) {
        run(pool, call, job);
    }

    private void asyncHeavy(PluginCall call, Job job) {
        run(heavy, call, job);
    }

    private void run(ExecutorService where, PluginCall call, Job job) {
        where.execute(() -> {
            try {
                call.resolve(job.run());
            } catch (Throwable e) {
                // An uncaught error on these threads would close the app.
                call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            }
        });
    }

    // ---- system ----
    @PluginMethod
    public void system(PluginCall call) {
        async(call, () -> {
            JSObject o = new JSObject();
            o.put("platform", "android");
            o.put("deviceName", deviceName());
            o.put("manufacturer", Build.MANUFACTURER);
            o.put("model", Build.MODEL);
            o.put("osName", "Android " + Build.VERSION.RELEASE);
            o.put("osBuild", String.valueOf(Build.VERSION.SDK_INT));
            o.put("cpuName", socName());
            int cores = Runtime.getRuntime().availableProcessors();
            o.put("cores", cores);
            o.put("threads", cores);
            o.put("gpus", new JSArray());
            o.put("hasBattery", true);
            o.put("elevated", false);
            o.put("uptimeSec", SystemClock.elapsedRealtime() / 1000);
            return o;
        });
    }

    private String deviceName() {
        String man = capitalize(Build.MANUFACTURER);
        String model = Build.MODEL;
        return model.toLowerCase(Locale.ROOT).startsWith(man.toLowerCase(Locale.ROOT)) ? model : man + " " + model;
    }

    private String socName() {
        if (Build.VERSION.SDK_INT >= 31 && !Build.SOC_MODEL.equals(Build.UNKNOWN)) {
            String m = Build.SOC_MANUFACTURER.equals(Build.UNKNOWN) ? "" : capitalize(Build.SOC_MANUFACTURER) + " ";
            return m + Build.SOC_MODEL;
        }
        return Build.HARDWARE;
    }

    private static String capitalize(String s) {
        return s == null || s.isEmpty() ? "" : s.substring(0, 1).toUpperCase(Locale.ROOT) + s.substring(1);
    }

    // ---- live sample ----
    @PluginMethod
    public void live(PluginCall call) {
        async(call, this::buildLive);
    }

    private JSObject buildLive() throws Exception {
        Context ctx = getContext();
        ActivityManager am = ctx.getSystemService(ActivityManager.class);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        Map<String, Long> info = readMeminfo();

        long total = mi.totalMem;
        long avail = mi.availMem;
        long cached = get(info, "Cached") + get(info, "Buffers");
        long swapTotal = get(info, "SwapTotal");
        long swapFree = get(info, "SwapFree");

        JSObject mem = new JSObject();
        mem.put("total", total);
        mem.put("available", avail);
        mem.put("used", total - avail);
        mem.put("load", Math.round((total - avail) * 100.0 / total));
        mem.put("standby", Math.min(cached, avail));
        mem.put("modified", 0);
        mem.put("free", get(info, "MemFree"));
        mem.put("commit", swapTotal - swapFree);
        mem.put("commitLimit", swapTotal);
        mem.put("swapTotal", swapTotal);
        mem.put("swapUsed", swapTotal - swapFree);
        mem.put("low", mi.lowMemory);

        JSObject o = new JSObject();
        o.put("ts", System.currentTimeMillis());
        o.put("cpu", cpuSample());
        o.put("mem", mem);
        o.put("disk", JSObject.NULL);
        o.put("processes", recentApps());
        o.put("sensors", sensors());

        PowerManager pm = ctx.getSystemService(PowerManager.class);
        int status = Build.VERSION.SDK_INT >= 29 ? pm.getCurrentThermalStatus() : -1;
        o.put("thermalStatus", status >= 0 ? (Object) status : JSObject.NULL);
        o.put("throttling", status >= 0 ? (Object) (status >= PowerManager.THERMAL_STATUS_MODERATE) : JSObject.NULL);
        Object headroom = JSObject.NULL;
        if (Build.VERSION.SDK_INT >= 30) {
            float h = pm.getThermalHeadroom(10);
            if (!Float.isNaN(h) && !Float.isInfinite(h)) headroom = (double) h;
        }
        o.put("thermalHeadroom", headroom);
        o.put("power", power());
        o.put("elevated", false);
        return o;
    }

    private JSObject cpuSample() {
        int n = Runtime.getRuntime().availableProcessors();
        JSArray perCore = new JSArray();
        double sum = 0;
        int count = 0;
        long curSum = 0;
        long maxSeen = 0;
        for (int i = 0; i < n; i++) {
            long cur = readLong("/sys/devices/system/cpu/cpu" + i + "/cpufreq/scaling_cur_freq");
            long max = readLong("/sys/devices/system/cpu/cpu" + i + "/cpufreq/cpuinfo_max_freq");
            if (cur > 0 && max > 0) {
                double pct = Math.min(100.0, cur * 100.0 / max);
                perCore.put((Object) (Math.round(pct * 10) / 10.0));
                sum += pct;
                curSum += cur;
                count++;
                if (max > maxSeen) maxSeen = max;
            }
        }
        JSObject cpu = new JSObject();
        // Android 8+ blocks /proc/stat. What can honestly be shown is how much of the top frequency is in use.
        cpu.put("usage", count > 0 ? (Object) (Math.round(sum / count * 10) / 10.0) : JSObject.NULL);
        cpu.put("perCore", perCore);
        cpu.put("freqMHz", count > 0 ? (Object) (curSum / count / 1000) : JSObject.NULL);
        cpu.put("baseMHz", JSObject.NULL);
        cpu.put("maxMHz", maxSeen > 0 ? (Object) (maxSeen / 1000) : JSObject.NULL);
        cpu.put("usageIsFrequency", true);
        return cpu;
    }

    private Intent batteryIntent() {
        return getContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    }

    private Object power() {
        Intent b = batteryIntent();
        if (b == null) return JSObject.NULL;
        int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
        int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        int plugged = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
        int mv = b.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0);
        BatteryManager bm = getContext().getSystemService(BatteryManager.class);
        long current = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW);
        Object watts = JSObject.NULL;
        if (current != 0 && current != Integer.MIN_VALUE && mv > 0) {
            // Some phones report mA rather than µA.
            double amps = Math.abs(current) > 20000 ? Math.abs(current) / 1e6 : Math.abs(current) / 1e3;
            watts = Math.round(amps * (mv / 1000.0) * 10) / 10.0;
        }
        JSObject p = new JSObject();
        p.put("percent", level >= 0 ? (Object) Math.round(level * 100f / scale) : JSObject.NULL);
        p.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL);
        p.put("onAc", plugged != 0);
        p.put("watts", watts);
        return p;
    }

    // ---- temperatures ----
    private volatile long sensorsAt = 0;
    private volatile JSArray sensorsCache = null;
    private final AtomicBoolean sensorsBusy = new AtomicBoolean(false);

    // Reading a thermal zone can take a long time on some phones, so live data never waits for it.
    private JSArray sensors() {
        long now = SystemClock.elapsedRealtime();
        if ((sensorsCache == null || now - sensorsAt >= 10000) && sensorsBusy.compareAndSet(false, true)) {
            readings.execute(() -> {
                try {
                    sensorsCache = readSensors();
                    sensorsAt = SystemClock.elapsedRealtime();
                } catch (Throwable ignored) {
                } finally {
                    sensorsBusy.set(false);
                }
            });
        }
        JSArray known = sensorsCache;
        return known != null ? known : batterySensor();
    }

    private JSArray batterySensor() {
        JSArray list = new JSArray();
        Intent b = batteryIntent();
        if (b != null) {
            int t = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
            if (t != Integer.MIN_VALUE && t > 0) list.put(sensor("battery", "Battery", "battery", t / 10.0));
        }
        return list;
    }

    private JSArray readSensors() {
        JSArray list = batterySensor();

        // On many Android 12+ phones SELinux blocks these files, which leaves only the battery.
        File[] zones = new File("/sys/class/thermal").listFiles((d, name) -> name.startsWith("thermal_zone"));
        if (zones != null) {
            List<String[]> found = new ArrayList<>();
            for (File z : zones) {
                String type = readString(new File(z, "type").getPath());
                long raw = readLong(new File(z, "temp").getPath());
                if (type == null || raw == Long.MIN_VALUE) continue;
                double c = raw > 1000 ? raw / 1000.0 : raw > 200 ? raw / 10.0 : raw;
                if (c < 8 || c > 130) continue;
                String low = type.toLowerCase(Locale.ROOT);
                if (low.endsWith("-step") || low.contains("batt")) continue;
                found.add(new String[] {type, String.valueOf(c)});
            }
            Collections.sort(found, (x, y) -> x[0].compareTo(y[0]));
            int added = 0;
            for (String[] f : found) {
                if (added++ >= 28) break;
                list.put(sensor("zone:" + f[0], zoneName(f[0]), zoneGroup(f[0]), Math.round(Double.parseDouble(f[1]) * 10) / 10.0));
            }
        }
        return list;
    }

    private static JSObject sensor(String id, String name, String group, double c) {
        JSObject s = new JSObject();
        s.put("id", id);
        s.put("name", name);
        s.put("group", group);
        s.put("celsius", Math.round(c * 10) / 10.0);
        s.put("source", "android");
        s.put("approximate", false);
        return s;
    }

    private static String zoneGroup(String type) {
        String t = type.toLowerCase(Locale.ROOT);
        if (t.contains("gpu")) return "gpu";
        if (t.contains("cpu") || t.contains("apc") || t.contains("soc") || t.contains("tsens") || t.contains("cluster") || t.contains("core")) return "cpu";
        if (t.contains("skin") || t.contains("quiet") || t.contains("back") || t.contains("case") || t.contains("usb") || t.contains("xo")) return "skin";
        if (t.contains("ufs") || t.contains("nand") || t.contains("emmc") || t.contains("sdc")) return "storage";
        if (t.contains("ddr") || t.contains("memory")) return "memory";
        return "other";
    }

    private static String zoneName(String type) {
        String n = type.replace("-usr", "").replace("_usr", "").replace('_', ' ').replace('-', ' ').trim();
        return n.isEmpty() ? type : n.substring(0, 1).toUpperCase(Locale.ROOT) + n.substring(1);
    }

    // ---- recently used apps ----
    private volatile long appsAt = 0;
    private volatile JSArray appsCache = new JSArray();
    private final AtomicBoolean appsBusy = new AtomicBoolean(false);

    private JSArray recentApps() {
        long now = SystemClock.elapsedRealtime();
        if ((appsAt == 0 || now - appsAt >= 30000) && appsBusy.compareAndSet(false, true)) {
            readings.execute(() -> {
                try {
                    appsCache = readRecentApps();
                    appsAt = SystemClock.elapsedRealtime();
                } catch (Throwable ignored) {
                } finally {
                    appsBusy.set(false);
                }
            });
        }
        return appsCache;
    }

    private JSArray readRecentApps() {
        JSArray list = new JSArray();
        if (!hasUsageAccess()) return list;
        try {
            Context ctx = getContext();
            UsageStatsManager usm = ctx.getSystemService(UsageStatsManager.class);
            long end = System.currentTimeMillis();
            Map<String, UsageStats> stats = usm.queryAndAggregateUsageStats(end - 3 * 3600_000L, end);
            List<UsageStats> sorted = new ArrayList<>(stats.values());
            Collections.sort(sorted, (x, y) -> Long.compare(y.getTotalTimeInForeground(), x.getTotalTimeInForeground()));

            Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
            ComponentName launcher = home.resolveActivity(ctx.getPackageManager());
            String launcherPkg = launcher != null ? launcher.getPackageName() : "";

            int added = 0;
            for (UsageStats u : sorted) {
                String pkg = u.getPackageName();
                if (u.getTotalTimeInForeground() < 1000 || added >= 12) break;
                if (pkg.equals(ctx.getPackageName()) || pkg.equals(launcherPkg) || pkg.equals("com.android.systemui")) continue;
                JSObject p = new JSObject();
                p.put("key", pkg);
                p.put("name", pkg);
                p.put("title", label(pkg));
                p.put("path", pkg);
                p.put("pids", new JSArray());
                p.put("cpu", 0);
                p.put("mem", 0);
                p.put("disk", 0);
                p.put("critical", false);
                p.put("usageMs", u.getTotalTimeInForeground());
                p.put("lastUsed", u.getLastTimeUsed());
                list.put(p);
                added++;
            }
        } catch (Exception ignored) {
            // The list stays empty and the UI asks for the permission.
        }
        return list;
    }

    private String label(String pkg) {
        String cached = labelCache.get(pkg);
        if (cached != null) return cached;
        String res = pkg;
        try {
            PackageManager pm = getContext().getPackageManager();
            res = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception ignored) {
        }
        labelCache.put(pkg, res);
        return res;
    }

    @PluginMethod
    public void appIcon(PluginCall call) {
        String pkg = call.getString("packageName", "");
        async(call, () -> {
            JSObject o = new JSObject();
            String cached = iconCache.get(pkg);
            if (cached == null) {
                try {
                    Drawable d = getContext().getPackageManager().getApplicationIcon(pkg);
                    int size = 72;
                    Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
                    Canvas canvas = new Canvas(bmp);
                    d.setBounds(0, 0, size, size);
                    d.draw(canvas);
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.PNG, 90, out);
                    cached = "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                } catch (Exception e) {
                    cached = "";
                }
                iconCache.put(pkg, cached);
            }
            o.put("icon", cached.isEmpty() ? JSObject.NULL : cached);
            return o;
        });
    }

    // ---- memory ----
    @PluginMethod
    public void memory(PluginCall call) {
        async(call, () -> {
            Context ctx = getContext();
            ActivityManager am = ctx.getSystemService(ActivityManager.class);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            long installed = Build.VERSION.SDK_INT >= 34 && mi.advertisedMem > 0 ? mi.advertisedMem : mi.totalMem;
            String detected = detectRamType();

            JSObject o = new JSObject();
            o.put("platform", "android");
            o.put("installed", installed);
            o.put("type", detected != null ? detected : "LPDDR");
            o.put("typeNote", detected != null
                ? detected + " memory, soldered to the board next to the processor."
                : "Android doesn't expose the exact memory generation. Phones use LPDDR memory soldered to the board.");
            o.put("speed", 0);
            o.put("slotsTotal", 0);
            o.put("slotsUsed", 0);
            o.put("maxCapacity", JSObject.NULL);
            o.put("dualChannel", JSObject.NULL);
            o.put("modules", new JSArray());

            JSArray details = new JSArray();
            details.put("On phones, memory is soldered to the board or built into the processor package.");
            details.put("Capacity can't be increased. Virtual RAM features use storage, which is far slower than real RAM.");
            JSObject upgrade = new JSObject();
            upgrade.put("verdict", "no");
            upgrade.put("title", "This RAM can't be upgraded");
            upgrade.put("details", details);
            o.put("upgrade", upgrade);
            return o;
        });
    }

    private String detectRamType() {
        String[] props = {"ro.boot.ddr_type", "ro.boot.hardware.ddr", "ro.vendor.boot.ddr_type", "ro.boot.ddrtype", "ro.ddr_type", "ro.boot.ddr.type"};
        for (String p : props) {
            String v = systemProp(p);
            if (v != null && v.toUpperCase(Locale.ROOT).contains("DDR")) {
                int i = v.toUpperCase(Locale.ROOT).indexOf("LPDDR");
                String t = (i >= 0 ? v.substring(i) : v).split("[,;\\s]")[0];
                return t.toUpperCase(Locale.ROOT).replace("X", "X");
            }
        }
        return null;
    }

    private static String systemProp(String name) {
        try {
            Class<?> c = Class.forName("android.os.SystemProperties");
            String v = (String) c.getMethod("get", String.class).invoke(null, name);
            return v == null || v.isEmpty() ? null : v;
        } catch (Exception e) {
            return null;
        }
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void freeRam(PluginCall call) {
        async(call, () -> {
            Context ctx = getContext();
            ActivityManager am = ctx.getSystemService(ActivityManager.class);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            long before = mi.availMem;
            int trimmed = 0;
            // Since Android 14 this call only affects the app making it, so it is skipped there.
            boolean restricted = Build.VERSION.SDK_INT >= 34;
            if (!restricted) {
                PackageManager pm = ctx.getPackageManager();
                for (ApplicationInfo a : pm.getInstalledApplications(0)) {
                    if ((a.flags & ApplicationInfo.FLAG_SYSTEM) != 0 || a.packageName.equals(ctx.getPackageName())) continue;
                    am.killBackgroundProcesses(a.packageName);
                    trimmed++;
                }
            }
            System.gc();
            Thread.sleep(600);
            am.getMemoryInfo(mi);
            JSObject o = new JSObject();
            o.put("before", before);
            o.put("after", mi.availMem);
            o.put("freed", Math.max(0, mi.availMem - before));
            o.put("trimmed", trimmed);
            o.put("denied", 0);
            o.put("standbyPurged", false);
            o.put("standbyError", JSObject.NULL);
            o.put("elevated", false);
            o.put("restricted", restricted);
            return o;
        });
    }

    // ---- storage ----
    @PluginMethod
    public void disks(PluginCall call) {
        async(call, () -> {
            StorageStatsManager ssm = getContext().getSystemService(StorageStatsManager.class);
            long total = ssm.getTotalBytes(StorageManager.UUID_DEFAULT);
            long free = ssm.getFreeBytes(StorageManager.UUID_DEFAULT);
            JSObject v = new JSObject();
            v.put("path", "/");
            v.put("letter", "");
            v.put("label", "Internal storage");
            v.put("fs", "");
            v.put("total", total);
            v.put("free", free);
            v.put("removable", false);
            v.put("system", true);
            v.put("model", JSObject.NULL);
            v.put("media", "Flash");
            v.put("bus", JSObject.NULL);
            JSArray volumes = new JSArray();
            volumes.put(v);
            JSObject o = new JSObject();
            o.put("platform", "android");
            o.put("volumes", volumes);
            return o;
        });
    }

    private long storageAt = 0;
    private JSObject storageCache = null;

    @PluginMethod
    public void storage(PluginCall call) {
        asyncHeavy(call, this::buildStorage);
    }

    private JSObject buildStorage() throws Exception {
        long now = SystemClock.elapsedRealtime();
        boolean usage = hasUsageAccess();
        boolean files = hasAllFiles();
        // Permissions can change between calls, so the cache takes them into account.
        if (storageCache != null && now - storageAt < 60000
            && storageCache.getBool("usageAccess") == usage && storageCache.getBool("allFiles") == files) {
            return storageCache;
        }

        Context ctx = getContext();
        StorageStatsManager ssm = ctx.getSystemService(StorageStatsManager.class);
        UUID uuid = StorageManager.UUID_DEFAULT;
        long total = ssm.getTotalBytes(uuid);
        long free = ssm.getFreeBytes(uuid);

        JSObject o = new JSObject();
        o.put("total", total);
        o.put("free", free);
        o.put("system", 0);
        o.put("usageAccess", usage);
        o.put("allFiles", files);

        JSArray apps = new JSArray();
        Object media = JSObject.NULL;
        if (usage) {
            PackageManager pm = ctx.getPackageManager();
            List<JSObject> rows = new ArrayList<>();
            for (ApplicationInfo a : pm.getInstalledApplications(0)) {
                try {
                    StorageStats s = ssm.queryStatsForPackage(uuid, a.packageName, Process.myUserHandle());
                    long sum = s.getAppBytes() + s.getDataBytes();
                    if (sum <= 0) continue;
                    JSObject r = new JSObject();
                    r.put("packageName", a.packageName);
                    r.put("label", label(a.packageName));
                    r.put("appBytes", s.getAppBytes());
                    r.put("dataBytes", s.getDataBytes());
                    r.put("cacheBytes", s.getCacheBytes());
                    r.put("totalBytes", sum);
                    r.put("system", (a.flags & ApplicationInfo.FLAG_SYSTEM) != 0);
                    rows.add(r);
                } catch (Exception ignored) {
                    // The package was uninstalled meanwhile or has no data.
                }
            }
            Collections.sort(rows, (x, y) -> Long.compare(y.optLong("totalBytes"), x.optLong("totalBytes")));
            for (JSObject r : rows) apps.put(r);

            try {
                android.app.usage.ExternalStorageStats ext = ssm.queryExternalStatsForUser(uuid, Process.myUserHandle());
                JSObject m = new JSObject();
                m.put("images", ext.getImageBytes());
                m.put("video", ext.getVideoBytes());
                m.put("audio", ext.getAudioBytes());
                m.put("documents", 0);
                m.put("downloads", 0);
                media = m;
            } catch (Exception ignored) {
            }
        }
        o.put("apps", apps);
        o.put("media", media);
        o.put("largest", files ? largestFiles() : new JSArray());

        storageCache = o;
        storageAt = now;
        return o;
    }

    private JSArray largestFiles() {
        JSArray out = new JSArray();
        try {
            ContentResolver cr = getContext().getContentResolver();
            Uri uri = MediaStore.Files.getContentUri("external");
            String[] cols = {MediaStore.Files.FileColumns.DISPLAY_NAME, MediaStore.Files.FileColumns.DATA, MediaStore.Files.FileColumns.SIZE};
            Bundle args = new Bundle();
            args.putStringArray(ContentResolver.QUERY_ARG_SORT_COLUMNS, new String[] {MediaStore.Files.FileColumns.SIZE});
            args.putInt(ContentResolver.QUERY_ARG_SORT_DIRECTION, ContentResolver.QUERY_SORT_DIRECTION_DESCENDING);
            args.putInt(ContentResolver.QUERY_ARG_LIMIT, 30);
            try (Cursor c = cr.query(uri, cols, args, null)) {
                if (c == null) return out;
                while (c.moveToNext()) {
                    long size = c.getLong(2);
                    if (size <= 0) continue;
                    JSObject f = new JSObject();
                    String path = c.getString(1);
                    String name = c.getString(0);
                    f.put("name", name != null ? name : (path != null ? new File(path).getName() : "file"));
                    f.put("path", path != null ? path : "");
                    f.put("size", size);
                    out.put(f);
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    // ---- health ----
    @PluginMethod
    public void health(PluginCall call) {
        async(call, () -> {
            Context ctx = getContext();
            StorageStatsManager ssm = ctx.getSystemService(StorageStatsManager.class);
            long total = ssm.getTotalBytes(StorageManager.UUID_DEFAULT);

            JSObject disk = new JSObject();
            disk.put("index", 0);
            disk.put("model", "Internal storage");
            disk.put("size", total);
            disk.put("bus", JSObject.NULL);
            disk.put("media", "Flash");
            disk.put("status", JSObject.NULL);
            disk.put("letters", new JSArray());
            Integer used = flashWear();
            if (used != null) {
                JSObject smart = new JSObject();
                smart.put("source", "android");
                smart.put("percentUsed", used);
                disk.put("smart", smart);
                disk.put("smartReason", JSObject.NULL);
            } else {
                disk.put("smart", JSObject.NULL);
                disk.put("smartReason", "os");
            }
            JSArray disks = new JSArray();
            disks.put(disk);

            JSObject o = new JSObject();
            o.put("platform", "android");
            o.put("disks", disks);
            o.put("battery", batteryHealth());
            o.put("hardwareErrors", JSObject.NULL);
            o.put("unexpectedShutdowns", JSObject.NULL);
            o.put("uptimeSec", SystemClock.elapsedRealtime() / 1000);
            return o;
        });
    }

    // On some phones the eMMC/UFS wear files are readable. The value comes in 10% steps.
    private Integer flashWear() {
        String[] paths = {
            "/sys/class/block/mmcblk0/device/life_time",
            "/sys/block/mmcblk0/device/life_time",
            "/sys/devices/platform/soc/1d84000.ufshc/health_descriptor/life_time_estimation_a",
            "/sys/block/sda/device/health_descriptor/life_time_estimation_a",
        };
        for (String p : paths) {
            String v = readString(p);
            if (v == null) continue;
            try {
                String first = v.trim().split("\\s+")[0].replace("0x", "");
                int step = Integer.parseInt(first, 16);
                if (step >= 1 && step <= 11) return Math.min(100, (step - 1) * 10);
            } catch (NumberFormatException ignored) {
            }
        }
        return null;
    }

    private Object batteryHealth() {
        Intent b = batteryIntent();
        if (b == null) return JSObject.NULL;
        Context ctx = getContext();
        BatteryManager bm = ctx.getSystemService(BatteryManager.class);
        boolean present = b.getBooleanExtra(BatteryManager.EXTRA_PRESENT, true);
        int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
        int temp = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
        int mv = b.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0);
        String tech = b.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY);

        Long design = designCapacityMah();
        Long full = null;
        boolean estimated = false;
        long fullSys = readLong("/sys/class/power_supply/battery/charge_full");
        if (fullSys > 0) {
            full = fullSys / 1000;
        } else {
            // Estimate: the charge counter divided by the current percentage. Only above 20%, where the error is small.
            long counter = bm.getLongProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER);
            if (counter > 0 && counter != Long.MIN_VALUE && level >= 20) {
                full = Math.round(counter / 1000.0 / (level * 1.0 / scale));
                estimated = true;
            }
        }
        Object healthPct = JSObject.NULL;
        if (design != null && full != null && full > design * 0.2 && full < design * 1.25) {
            healthPct = Math.round(Math.min(100.0, full * 100.0 / design) * 10) / 10.0;
        } else {
            full = null;
        }

        Object cycles = JSObject.NULL;
        if (Build.VERSION.SDK_INT >= 34) {
            int cc = b.getIntExtra(BatteryManager.EXTRA_CYCLE_COUNT, -1);
            if (cc >= 0) cycles = cc;
        }
        if (cycles == JSObject.NULL) {
            long cc = readLong("/sys/class/power_supply/battery/cycle_count");
            if (cc > 0) cycles = cc;
        }

        JSObject o = new JSObject();
        o.put("present", present);
        o.put("designCapacity", design != null ? (Object) design : JSObject.NULL);
        o.put("fullCapacity", full != null ? (Object) full : JSObject.NULL);
        o.put("unit", "mAh");
        o.put("healthPct", healthPct);
        o.put("estimated", estimated);
        o.put("cycles", cycles);
        o.put("chemistry", tech != null ? tech : JSObject.NULL);
        o.put("status", healthLabel(b.getIntExtra(BatteryManager.EXTRA_HEALTH, 0)));
        o.put("tempC", temp != Integer.MIN_VALUE ? (Object) (temp / 10.0) : JSObject.NULL);
        o.put("voltage", mv > 0 ? (Object) (mv / 1000.0) : JSObject.NULL);
        return o;
    }

    private Long designCapacityMah() {
        long sys = readLong("/sys/class/power_supply/battery/charge_full_design");
        if (sys > 0) return sys / 1000;
        try {
            Class<?> c = Class.forName("com.android.internal.os.PowerProfile");
            Object p = c.getConstructor(Context.class).newInstance(getContext());
            double cap = (double) c.getMethod("getBatteryCapacity").invoke(p);
            if (cap > 100) return Math.round(cap);
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String healthLabel(int h) {
        switch (h) {
            case BatteryManager.BATTERY_HEALTH_GOOD: return "The system reports the battery as good.";
            case BatteryManager.BATTERY_HEALTH_OVERHEAT: return "The system reports the battery as overheated.";
            case BatteryManager.BATTERY_HEALTH_DEAD: return "The system reports the battery as dead.";
            case BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE: return "The system reports an over-voltage condition.";
            case BatteryManager.BATTERY_HEALTH_COLD: return "The system reports the battery as too cold.";
            default: return "This phone doesn't report the battery's real capacity.";
        }
    }

    // ---- cleanup ----
    @PluginMethod
    public void cleanScan(PluginCall call) {
        JSObject o = new JSObject();
        o.put("platform", "android");
        o.put("categories", new JSArray());
        o.put("elevated", false);
        call.resolve(o);
    }

    @PluginMethod
    public void clearOwnCache(PluginCall call) {
        async(call, () -> {
            Context ctx = getContext();
            long freed = deleteContents(ctx.getCacheDir()) + deleteContents(ctx.getCodeCacheDir());
            File ext = ctx.getExternalCacheDir();
            if (ext != null) freed += deleteContents(ext);
            JSObject o = new JSObject();
            o.put("freed", freed);
            return o;
        });
    }

    private long deleteContents(File dir) {
        long freed = 0;
        File[] files = dir == null ? null : dir.listFiles();
        if (files == null) return 0;
        for (File f : files) {
            if (f.isDirectory()) freed += deleteContents(f);
            long size = f.length();
            if (f.delete() && !f.isDirectory()) freed += size;
        }
        return freed;
    }

    // ---- permissions and system screens ----
    private boolean hasUsageAccess() {
        AppOpsManager ops = getContext().getSystemService(AppOpsManager.class);
        int mode = Build.VERSION.SDK_INT >= 29
            ? ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), getContext().getPackageName())
            : ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), getContext().getPackageName());
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    private boolean hasAllFiles() {
        return Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager();
    }

    @PluginMethod
    public void permissions(PluginCall call) {
        JSObject o = new JSObject();
        o.put("usageAccess", hasUsageAccess());
        o.put("allFiles", hasAllFiles());
        o.put("canClearAllCaches", hasAllFiles());
        o.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(o);
    }

    private void openSettings(PluginCall call, Intent intent) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("The settings screen couldn't be opened.");
        }
    }

    @PluginMethod
    public void requestUsageAccess(PluginCall call) {
        openSettings(call, new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS));
    }

    @PluginMethod
    public void requestAllFiles(PluginCall call) {
        if (Build.VERSION.SDK_INT < 30) {
            call.resolve();
            return;
        }
        Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        openSettings(call, i);
    }

    @PluginMethod
    public void openAppInfo(PluginCall call) {
        String pkg = call.getString("packageName", "");
        openSettings(call, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)));
    }

    @PluginMethod
    public void openStorageSettings(PluginCall call) {
        openSettings(call, new Intent(Settings.ACTION_INTERNAL_STORAGE_SETTINGS));
    }

    // The system dialog that clears every app cache (Android 11+, needs all-files access).
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void clearAllCaches(PluginCall call) {
        JSObject o = new JSObject();
        if (Build.VERSION.SDK_INT < 30) {
            o.put("launched", false);
            o.put("reason", "unsupported");
            call.resolve(o);
            return;
        }
        if (!hasAllFiles()) {
            o.put("launched", false);
            o.put("reason", "needsAllFiles");
            call.resolve(o);
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                // Must be startActivityForResult: the dialog checks which app asked for it.
                getActivity().startActivityForResult(new Intent(StorageManager.ACTION_CLEAR_APP_CACHE), 7301);
                o.put("launched", true);
            } catch (Exception e) {
                o.put("launched", false);
                o.put("reason", "unavailable");
            }
            call.resolve(o);
        });
    }

    // ---- battery screen ----
    @PluginMethod
    public void batteryInfo(PluginCall call) {
        async(call, () -> {
            Context ctx = getContext();
            Intent b = batteryIntent();
            BatteryManager bm = ctx.getSystemService(BatteryManager.class);
            PowerManager pm = ctx.getSystemService(PowerManager.class);
            ContentResolver cr = ctx.getContentResolver();

            JSObject o = new JSObject();
            int plugged = 0;
            if (b != null) {
                int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                int temp = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
                plugged = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                o.put("percent", level >= 0 ? (Object) Math.round(level * 100f / scale) : JSObject.NULL);
                o.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING);
                o.put("tempC", temp != Integer.MIN_VALUE ? (Object) (temp / 10.0) : JSObject.NULL);
            }
            String source = plugged == BatteryManager.BATTERY_PLUGGED_AC ? "ac"
                : plugged == BatteryManager.BATTERY_PLUGGED_USB ? "usb"
                : plugged == BatteryManager.BATTERY_PLUGGED_WIRELESS ? "wireless" : null;
            o.put("plugged", source != null ? source : JSObject.NULL);
            Object power = power();
            o.put("watts", power instanceof JSObject ? ((JSObject) power).opt("watts") : JSObject.NULL);
            Object chargeTime = JSObject.NULL;
            if (Build.VERSION.SDK_INT >= 28) {
                long ms = bm.computeChargeTimeRemaining();
                if (ms > 0) chargeTime = ms / 1000;
            }
            o.put("chargeTimeSec", chargeTime);
            o.put("powerSave", pm.isPowerSaveMode());
            o.put("canWrite", Settings.System.canWrite(ctx));
            int raw = Settings.System.getInt(cr, Settings.System.SCREEN_BRIGHTNESS, -1);
            o.put("brightness", raw >= 0 ? (Object) Math.round(raw * 100f / 255) : JSObject.NULL);
            o.put("adaptiveBrightness", Settings.System.getInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE, 0) == Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC);
            int timeout = Settings.System.getInt(cr, Settings.System.SCREEN_OFF_TIMEOUT, -1);
            o.put("screenTimeoutSec", timeout > 0 ? (Object) (timeout / 1000) : JSObject.NULL);
            o.put("health", batteryHealth());
            return o;
        });
    }

    @PluginMethod
    public void batterySet(PluginCall call) {
        String key = call.getString("key", "");
        Double value = call.getDouble("value");
        async(call, () -> {
            Context ctx = getContext();
            if (!Settings.System.canWrite(ctx)) throw new Exception("Android hasn't granted permission to change this yet.");
            if (value == null) throw new Exception("Missing value.");
            ContentResolver cr = ctx.getContentResolver();
            switch (key) {
                case "brightness":
                    // A manual level only sticks with automatic brightness off.
                    Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
                    Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS, Math.max(1, Math.min(255, (int) Math.round(value * 255 / 100))));
                    break;
                case "adaptive":
                    Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE, value > 0 ? Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC : Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
                    break;
                case "screenTimeout":
                    Settings.System.putInt(cr, Settings.System.SCREEN_OFF_TIMEOUT, (int) Math.round(value * 1000));
                    break;
                default:
                    throw new Exception("Unknown setting.");
            }
            JSObject o = new JSObject();
            o.put("ok", true);
            return o;
        });
    }

    @PluginMethod
    public void openSystemScreen(PluginCall call) {
        String screen = call.getString("screen", "");
        String pkg = getContext().getPackageName();
        Intent i;
        switch (screen) {
            case "batterySaver": i = new Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS); break;
            case "batteryUsage": i = new Intent(Intent.ACTION_POWER_USAGE_SUMMARY); break;
            case "batteryOptimization": i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS); break;
            case "display": i = new Intent(Settings.ACTION_DISPLAY_SETTINGS); break;
            case "location": i = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS); break;
            case "wifi": i = new Intent(Settings.ACTION_WIFI_SETTINGS); break;
            case "bluetooth": i = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS); break;
            case "dataSaver": i = new Intent(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS); break;
            case "writeSettings": i = new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:" + pkg)); break;
            default: i = new Intent(Settings.ACTION_SETTINGS);
        }
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            // Some phones don't have every screen, so fall back to the main settings.
            openSettings(call, new Intent(Settings.ACTION_SETTINGS));
        }
    }

    // Opens the phone's browser.
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) {
            call.reject("Invalid link.");
            return;
        }
        openSettings(call, new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    // ---- components ----
    @PluginMethod
    public void components(PluginCall call) {
        asyncHeavy(call, () -> {
            String detected = detectRamType();
            return DeviceInventory.build(getContext(), batteryHealth(), detected != null ? detected : "LPDDR");
        });
    }

    // ---- background monitor ----
    @PluginMethod
    public void monitorGet(PluginCall call) {
        async(call, () -> {
            Context ctx = getContext();
            org.json.JSONObject cfg = MonitorStore.config(ctx);
            org.json.JSONArray events = MonitorStore.events(ctx);
            JSArray recent = new JSArray();
            for (int i = events.length() - 1; i >= 0 && recent.length() < 40; i--) recent.put(events.opt(i));
            JSObject o = new JSObject();
            o.put("config", cfg);
            o.put("running", cfg.optBoolean("enabled", true));
            o.put("autostart", cfg.optBoolean("startWithSystem", true));
            o.put("elevated", false);
            o.put("events", recent);
            o.put("canCloseApps", Build.VERSION.SDK_INT < 34);
            o.put("notificationsAllowed", androidx.core.app.NotificationManagerCompat.from(ctx).areNotificationsEnabled());
            return o;
        });
    }

    @PluginMethod
    public void monitorSet(PluginCall call) {
        JSObject config = call.getObject("config");
        if (config == null) {
            call.reject("Missing settings.");
            return;
        }
        Context ctx = getContext();
        MonitorStore.save(ctx, config);
        try {
            if (config.optBoolean("enabled", true)) MonitorService.start(ctx);
            else MonitorService.stop(ctx);
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    @PluginMethod
    public void monitorHistory(PluginCall call) {
        async(call, () -> {
            JSObject o = new JSObject();
            o.put("points", MonitorStore.history(getContext()));
            return o;
        });
    }

    @PluginMethod
    public void monitorAutostart(PluginCall call) {
        Context ctx = getContext();
        org.json.JSONObject cfg = MonitorStore.config(ctx);
        try {
            cfg.put("startWithSystem", call.getBoolean("on", true));
            MonitorStore.save(ctx, cfg);
            call.resolve();
        } catch (org.json.JSONException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33) {
            androidx.core.app.ActivityCompat.requestPermissions(getActivity(), new String[] {android.Manifest.permission.POST_NOTIFICATIONS}, 7302);
        }
        call.resolve();
    }

    // ---- phone trash ----
    // Android only gives apps what's still in its trash. Permanently deleted files need root to reach.
    private static Uri mediaUri(int type) {
        switch (type) {
            case MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE: return MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
            case MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO: return MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
            case MediaStore.Files.FileColumns.MEDIA_TYPE_AUDIO: return MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
            default: return MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL);
        }
    }

    @PluginMethod
    public void trashList(PluginCall call) {
        async(call, () -> {
            JSObject o = new JSObject();
            JSArray items = new JSArray();
            boolean supported = Build.VERSION.SDK_INT >= 30;
            o.put("supported", supported);
            if (supported) {
                Bundle query = new Bundle();
                query.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_ONLY);
                query.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, MediaStore.MediaColumns.DATE_EXPIRES + " DESC");
                String[] columns = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_EXPIRES, MediaStore.Files.FileColumns.MEDIA_TYPE};
                try (Cursor cursor = getContext().getContentResolver().query(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL), columns, query, null)) {
                    while (cursor != null && cursor.moveToNext()) {
                        JSObject item = new JSObject();
                        item.put("uri", android.content.ContentUris.withAppendedId(mediaUri(cursor.getInt(4)), cursor.getLong(0)).toString());
                        item.put("name", cursor.getString(1));
                        item.put("size", cursor.getLong(2));
                        item.put("expiresMs", cursor.getLong(3) * 1000);
                        items.put(item);
                    }
                }
            }
            o.put("items", items);
            return o;
        });
    }

    @PluginMethod
    public void trashRestore(PluginCall call) {
        if (Build.VERSION.SDK_INT < 30) {
            call.reject("This needs Android 11 or newer.");
            return;
        }
        try {
            JSArray uris = call.getArray("uris");
            List<Uri> list = new ArrayList<>();
            for (int i = 0; uris != null && i < uris.length(); i++) {
                String uri = uris.getString(i);
                if (uri.startsWith("content://media/")) list.add(Uri.parse(uri));
            }
            if (list.isEmpty()) {
                call.reject("Nothing selected.");
                return;
            }
            // Android asks the user to confirm, then moves the files out of its trash.
            android.app.PendingIntent request = MediaStore.createTrashRequest(getContext().getContentResolver(), list, false);
            getActivity().startIntentSenderForResult(request.getIntentSender(), 7310, null, 0, 0, 0);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Android refused the restore." : e.getMessage());
        }
    }

    // ---- app updates ----
    private static final String LATEST_RELEASE = "https://api.github.com/repos/Manvex/G-Ultra/releases/latest";
    private volatile String updateUrl;
    private volatile String updateDigest;

    private static HttpURLConnection connect(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "G-Ultra");
        return c;
    }

    private static boolean isNewer(String version, String current) {
        try {
            String[] a = version.split("\\.");
            String[] b = current.split("\\.");
            for (int i = 0; i < Math.max(a.length, b.length); i++) {
                int x = i < a.length ? Integer.parseInt(a[i]) : 0;
                int y = i < b.length ? Integer.parseInt(b[i]) : 0;
                if (x != y) return x > y;
            }
        } catch (NumberFormatException ignored) {
        }
        return false;
    }

    @PluginMethod
    public void updateCheck(PluginCall call) {
        async(call, () -> {
            HttpURLConnection c = connect(LATEST_RELEASE);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            org.json.JSONObject release;
            try {
                if (c.getResponseCode() != 200) throw new Exception("GitHub answered " + c.getResponseCode());
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                try (InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[8192];
                    for (int n; (n = in.read(buf)) > 0; ) body.write(buf, 0, n);
                }
                release = new org.json.JSONObject(body.toString("UTF-8"));
            } finally {
                c.disconnect();
            }

            String version = release.optString("tag_name", "").replaceFirst("^v", "");
            String current = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
            org.json.JSONArray assets = release.optJSONArray("assets");
            org.json.JSONObject apk = null;
            for (int i = 0; assets != null && i < assets.length(); i++) {
                org.json.JSONObject a = assets.getJSONObject(i);
                if (a.optString("name").endsWith(".apk")) apk = a;
            }
            boolean available = apk != null && isNewer(version, current);
            updateUrl = available ? apk.getString("browser_download_url") : null;
            updateDigest = available ? apk.optString("digest", "") : null;

            JSObject o = new JSObject();
            o.put("supported", true);
            o.put("available", available);
            o.put("current", current);
            o.put("version", version);
            o.put("size", apk != null ? (Object) apk.optLong("size") : JSObject.NULL);
            o.put("page", release.optString("html_url", ""));
            return o;
        });
    }

    // Android always shows its own confirmation, and refuses an APK signed with a different key.
    @PluginMethod
    public void updateInstall(PluginCall call) {
        String url = updateUrl;
        String digest = updateDigest;
        if (url == null) {
            call.reject("Check for updates first.");
            return;
        }
        Context ctx = getContext();
        if (!ctx.getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
            allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(allow);
            JSObject o = new JSObject();
            o.put("needsPermission", true);
            call.resolve(o);
            return;
        }
        async(call, () -> {
            File dir = new File(ctx.getCacheDir(), "updates");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("No room for the update.");
            File apk = new File(dir, "G-Ultra.apk");
            MessageDigest sha = MessageDigest.getInstance("SHA-256");

            HttpURLConnection c = connect(url);
            try {
                if (c.getResponseCode() != 200) throw new Exception("GitHub answered " + c.getResponseCode());
                long total = c.getContentLengthLong();
                long done = 0;
                int shown = -1;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[64 * 1024];
                    for (int n; (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        sha.update(buf, 0, n);
                        done += n;
                        int percent = total > 0 ? (int) (done * 100 / total) : 0;
                        if (percent != shown) {
                            shown = percent;
                            JSObject p = new JSObject();
                            p.put("percent", percent);
                            notifyListeners("updateProgress", p);
                        }
                    }
                }
            } finally {
                c.disconnect();
            }

            if (digest != null && digest.startsWith("sha256:")) {
                StringBuilder hex = new StringBuilder();
                for (byte b : sha.digest()) hex.append(String.format("%02x", b));
                if (!digest.substring(7).equalsIgnoreCase(hex.toString())) {
                    apk.delete();
                    throw new Exception("The download was damaged.");
                }
            }

            Uri uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(install);

            JSObject o = new JSObject();
            o.put("started", true);
            return o;
        });
    }

    // ---- reading system files ----
    private static String readString(String path) {
        try (BufferedReader r = new BufferedReader(new FileReader(path))) {
            String line = r.readLine();
            return line == null ? null : line.trim();
        } catch (Exception e) {
            return null;
        }
    }

    private static long readLong(String path) {
        String s = readString(path);
        if (s == null) return Long.MIN_VALUE;
        try {
            return Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return Long.MIN_VALUE;
        }
    }

    private static Map<String, Long> readMeminfo() {
        Map<String, Long> m = new HashMap<>();
        try (BufferedReader r = new BufferedReader(new FileReader("/proc/meminfo"))) {
            String line;
            while ((line = r.readLine()) != null) {
                int i = line.indexOf(':');
                if (i < 0) continue;
                String[] parts = line.substring(i + 1).trim().split("\\s+");
                try {
                    m.put(line.substring(0, i), Long.parseLong(parts[0]) * 1024);
                } catch (NumberFormatException ignored) {
                }
            }
        } catch (Exception ignored) {
        }
        return m;
    }

    private static long get(Map<String, Long> m, String key) {
        Long v = m.get(key);
        return v == null ? 0 : v;
    }
}
