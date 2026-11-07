package com.gultra.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;

/** Settings, activity log and history for the background monitor. */
final class MonitorStore {
    private static final String PREFS = "gultra.monitor";
    private static final int MAX_EVENTS = 100;
    private static final long HISTORY_MS = 24 * 3600 * 1000L;
    private static final long POINT_EVERY_MS = 5 * 60 * 1000L;

    private MonitorStore() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // In its own file: Android rewrites a whole preferences file on each save, and can make
    // the app wait for that when it goes to the background.
    private static SharedPreferences historyPrefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS + ".history", Context.MODE_PRIVATE);
    }

    private static JSONObject defaults() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("enabled", true);
        o.put("startWithSystem", true);
        o.put("mode", "economy");
        o.put("notifications", true);
        o.put("ram", new JSONObject().put("enabled", false).put("threshold", 85).put("cooldownMin", 30).put("closeApps", false));
        o.put("ramTimer", new JSONObject().put("enabled", false).put("everyMin", 30).put("closeApps", false));
        o.put("closeApps", new JSONArray());
        o.put("temp", new JSONObject().put("enabled", true).put("threshold", 42));
        o.put("clean", new JSONObject().put("enabled", false).put("freeGb", 5));
        o.put("battery", new JSONObject().put("alert", false).put("alertPercent", 80).put("efficiency", false).put("lowPercent", 20));
        return o;
    }

    static synchronized JSONObject config(Context ctx) {
        try {
            JSONObject merged = defaults();
            String saved = prefs(ctx).getString("config", null);
            if (saved != null) {
                JSONObject s = new JSONObject(saved);
                for (Iterator<String> it = s.keys(); it.hasNext(); ) {
                    String key = it.next();
                    Object value = s.get(key);
                    JSONObject target = merged.optJSONObject(key);
                    if (value instanceof JSONObject && target != null) {
                        JSONObject section = (JSONObject) value;
                        for (Iterator<String> inner = section.keys(); inner.hasNext(); ) {
                            String k = inner.next();
                            target.put(k, section.get(k));
                        }
                    } else {
                        merged.put(key, value);
                    }
                }
            }
            return merged;
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static synchronized void save(Context ctx, JSONObject config) {
        prefs(ctx).edit().putString("config", config.toString()).apply();
    }

    static synchronized void log(Context ctx, String kind, String text) {
        try {
            JSONArray events = events(ctx);
            events.put(new JSONObject().put("ts", System.currentTimeMillis()).put("kind", kind).put("text", text));
            JSONArray kept = new JSONArray();
            for (int i = Math.max(0, events.length() - MAX_EVENTS); i < events.length(); i++) kept.put(events.get(i));
            prefs(ctx).edit().putString("events", kept.toString()).apply();
        } catch (JSONException ignored) {
        }
    }

    static synchronized JSONArray events(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString("events", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static synchronized void addPoint(Context ctx, int mem, Double temp) {
        try {
            long now = System.currentTimeMillis();
            if (prefs(ctx).contains("history")) prefs(ctx).edit().remove("history").apply();
            if (now - historyPrefs(ctx).getLong("at", 0) < POINT_EVERY_MS) return;
            JSONArray history = history(ctx);
            JSONArray kept = new JSONArray();
            for (int i = 0; i < history.length(); i++) {
                JSONObject p = history.getJSONObject(i);
                if (now - p.getLong("t") < HISTORY_MS) kept.put(p);
            }
            JSONObject point = new JSONObject().put("t", now).put("mem", mem);
            point.put("cpu", JSONObject.NULL);
            point.put("temp", temp == null ? JSONObject.NULL : temp);
            kept.put(point);
            historyPrefs(ctx).edit().putString("history", kept.toString()).putLong("at", now).apply();
        } catch (JSONException ignored) {
        }
    }

    static synchronized JSONArray history(Context ctx) {
        try {
            return new JSONArray(historyPrefs(ctx).getString("history", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static boolean waited(Context ctx, String key, long minutes) {
        return System.currentTimeMillis() - prefs(ctx).getLong(key, 0) >= minutes * 60000L;
    }

    static void mark(Context ctx, String key) {
        prefs(ctx).edit().putLong(key, System.currentTimeMillis()).apply();
    }
}
