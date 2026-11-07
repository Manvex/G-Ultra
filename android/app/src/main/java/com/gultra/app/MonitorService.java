package com.gultra.app;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.usage.StorageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.ServiceInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.storage.StorageManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Background monitoring on the phone. Android requires a visible notification for this, which
 * doubles as the live status. It wakes only at long intervals, so it costs very little battery.
 */
public class MonitorService extends Service {

    private boolean ramArmed = true;
    private static final int STATUS_ID = 7400;
    private static final int ALERT_ID = 7401;
    private static final String CHANNEL_STATUS = "gultra.status";
    private static final String CHANNEL_ALERT = "gultra.alerts";

    // The service shares a process with the app, so its work stays off the UI thread.
    private HandlerThread thread;
    private Handler handler;
    private final Runnable tick = this::tick;
    private boolean chargeAlerted = false;

    static void start(Context ctx) {
        ContextCompat.startForegroundService(ctx, new Intent(ctx, MonitorService.class));
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, MonitorService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        thread = new HandlerThread("gultra-monitor");
        thread.start();
        handler = new Handler(thread.getLooper());
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel status = new NotificationChannel(CHANNEL_STATUS, "Live status", NotificationManager.IMPORTANCE_MIN);
        status.setDescription("Memory, temperature and battery while G Ultra monitors in the background");
        nm.createNotificationChannel(status);
        NotificationChannel alert = new NotificationChannel(CHANNEL_ALERT, "Alerts", NotificationManager.IMPORTANCE_DEFAULT);
        alert.setDescription("Your rules: temperature, memory, storage and charge level");
        nm.createNotificationChannel(alert);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = status("Monitoring in the background");
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(STATUS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(STATUS_ID, n);
        }
        handler.removeCallbacks(tick);
        handler.post(tick);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        thread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification status(String text) {
        return new NotificationCompat.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(R.mipmap.ic_launcher_monochrome)
            .setContentTitle("G Ultra")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openApp())
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build();
    }

    private void alert(JSONObject cfg, String kind, String text) {
        MonitorStore.log(this, kind, text);
        if (!cfg.optBoolean("notifications", true)) return;
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(R.mipmap.ic_launcher_monochrome)
            .setContentTitle("G Ultra")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build();
        try {
            getSystemService(NotificationManager.class).notify(ALERT_ID + kind.hashCode() % 50, n);
        } catch (SecurityException ignored) {
            // Notifications weren't allowed. The event is still in the activity log.
        }
    }

    private static long intervalMs(String mode) {
        switch (mode) {
            case "realtime": return 60_000L;
            case "balanced": return 5 * 60_000L;
            default: return 15 * 60_000L;
        }
    }

    private void tick() {
        JSONObject cfg = MonitorStore.config(this);
        if (!cfg.optBoolean("enabled", true)) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }
        try {
            evaluate(cfg);
        } catch (Exception ignored) {
            // One failed reading shouldn't stop monitoring.
        }
        handler.postDelayed(tick, intervalMs(cfg.optString("mode", "economy")));
    }

    private void evaluate(JSONObject cfg) throws Exception {
        ActivityManager am = getSystemService(ActivityManager.class);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        int load = (int) Math.round((mi.totalMem - mi.availMem) * 100.0 / mi.totalMem);

        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int percent = -1;
        boolean plugged = false;
        Double temp = null;
        if (b != null) {
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            percent = level >= 0 ? Math.round(level * 100f / scale) : -1;
            plugged = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
            int t = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
            if (t != Integer.MIN_VALUE && t > 0) temp = t / 10.0;
        }

        MonitorStore.addPoint(this, load, temp);
        StringBuilder line = new StringBuilder("RAM ").append(load).append("%");
        if (temp != null) line.append(" · ").append(Math.round(temp)).append("°C");
        if (percent >= 0) line.append(" · battery ").append(percent).append("%");
        getSystemService(NotificationManager.class).notify(STATUS_ID, status(line.toString()));

        // ---- memory ----
        JSONObject ram = cfg.optJSONObject("ram");
        int ramLimit = ram != null ? ram.optInt("threshold", 85) : 85;
        if (load < ramLimit - 3) ramArmed = true;
        // With the timer: at most once per wait. Without it: each time memory goes over the limit.
        boolean ramDue = ram != null && ram.optBoolean("enabled") && load >= ramLimit
            && (ram.optBoolean("useTimer", true) ? MonitorStore.waited(this, "ramAt", ram.optLong("cooldownMin", 30)) : ramArmed);
        if (ramDue) {
            ramArmed = false;
            MonitorStore.mark(this, "ramAt");
            int closed = ram.optBoolean("closeApps") ? closeApps(cfg, am) : 0;
            if (Build.VERSION.SDK_INT >= 34) {
                alert(cfg, "ram", "Memory at " + load + "%. Android doesn't let apps close others, so check what's running.");
            } else {
                alert(cfg, "ram", "Memory at " + load + "%." + (closed > 0 ? " Stopped " + closed + " background apps." : ""));
            }
        }
        JSONObject timer = cfg.optJSONObject("ramTimer");
        if (timer != null && timer.optBoolean("enabled") && Build.VERSION.SDK_INT < 34 && MonitorStore.waited(this, "timerAt", timer.optLong("everyMin", 30))) {
            MonitorStore.mark(this, "timerAt");
            int closed = closeApps(cfg, am);
            if (closed > 0) MonitorStore.log(this, "timer", "Scheduled cleanup: stopped " + closed + " background apps.");
        }

        // ---- temperature ----
        JSONObject heat = cfg.optJSONObject("temp");
        if (heat != null && heat.optBoolean("enabled")) {
            PowerManager pm = getSystemService(PowerManager.class);
            boolean hotSystem = Build.VERSION.SDK_INT >= 29 && pm.getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE;
            boolean hotBattery = temp != null && temp >= heat.optDouble("threshold", 42);
            if ((hotSystem || hotBattery) && MonitorStore.waited(this, "tempAt", 15)) {
                MonitorStore.mark(this, "tempAt");
                alert(cfg, "temp", hotBattery ? "Battery at " + Math.round(temp) + "°C. Let the phone cool down, and stop charging if you can." : "The phone is running hot and may slow down.");
            }
        }

        // ---- storage: apps can't clear it here, so this is a nudge ----
        JSONObject clean = cfg.optJSONObject("clean");
        if (clean != null && clean.optBoolean("enabled") && MonitorStore.waited(this, "cleanAt", 24 * 60)) {
            StorageStatsManager ssm = getSystemService(StorageStatsManager.class);
            long free = ssm.getFreeBytes(StorageManager.UUID_DEFAULT);
            if (free < clean.optLong("freeGb", 5) * (1L << 30)) {
                MonitorStore.mark(this, "cleanAt");
                alert(cfg, "clean", "Only " + (free / (1L << 30)) + " GB of storage left. Open G Ultra to free some.");
            }
        }

        // ---- battery ----
        JSONObject battery = cfg.optJSONObject("battery");
        if (battery != null && percent >= 0) {
            if (battery.optBoolean("alert")) {
                int at = battery.optInt("alertPercent", 80);
                if (plugged && percent >= at && !chargeAlerted) {
                    chargeAlerted = true;
                    alert(cfg, "battery", "Battery at " + percent + "%. Unplug now to help it last longer.");
                }
                if (!plugged || percent < at - 3) chargeAlerted = false;
            }
            if (battery.optBoolean("efficiency")) {
                PowerManager pm = getSystemService(PowerManager.class);
                int low = battery.optInt("lowPercent", 20);
                if (!plugged && percent <= low && !pm.isPowerSaveMode() && MonitorStore.waited(this, "lowAt", 60)) {
                    MonitorStore.mark(this, "lowAt");
                    alert(cfg, "battery", "Battery at " + percent + "%. Turn on Battery saver to make it last.");
                }
            }
        }
    }

    // Only possible up to Android 13. Newer versions ignore this for other apps.
    @SuppressWarnings("deprecation")
    private int closeApps(JSONObject cfg, ActivityManager am) {
        if (Build.VERSION.SDK_INT >= 34) return 0;
        JSONArray list = cfg.optJSONArray("closeApps");
        int closed = 0;
        if (list == null) return 0;
        for (int i = 0; i < list.length(); i++) {
            String pkg = list.optString(i);
            if (pkg.isEmpty() || pkg.equals(getPackageName())) continue;
            try {
                ApplicationInfo info = getPackageManager().getApplicationInfo(pkg, 0);
                if ((info.flags & ApplicationInfo.FLAG_SYSTEM) != 0) continue;
                am.killBackgroundProcesses(pkg);
                closed++;
            } catch (Exception ignored) {
                // The app was uninstalled.
            }
        }
        return closed;
    }
}
