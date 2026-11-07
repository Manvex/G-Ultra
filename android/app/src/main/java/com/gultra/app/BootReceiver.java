package com.gultra.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/** Starts monitoring when the phone boots, and after an app update, if you left it on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        JSONObject cfg = MonitorStore.config(ctx);
        if (cfg.optBoolean("enabled", true) && cfg.optBoolean("startWithSystem", true)) {
            try {
                MonitorService.start(ctx);
            } catch (Exception ignored) {
                // Android can refuse this in rare states. Opening the app starts it again.
            }
        }
    }
}
