package com.gultra.app;

import android.app.ActivityManager;
import android.app.usage.StorageStatsManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.display.DisplayManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.util.DisplayMetrics;
import android.util.Size;
import android.util.SizeF;
import android.view.Display;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/** Everything inside the phone, with the details needed to find a replacement part. */
final class DeviceInventory {
    private DeviceInventory() {}

    // replace: tech = by a repair shop, no = soldered or part of the board
    private static JSObject item(String name, String replace, String note, String search, String... specs) {
        JSArray rows = new JSArray();
        for (int i = 0; i + 1 < specs.length; i += 2) {
            String v = specs[i + 1];
            if (v == null || v.trim().isEmpty() || v.equals(Build.UNKNOWN)) continue;
            JSArray row = new JSArray();
            row.put(specs[i]);
            row.put(v.trim());
            rows.put(row);
        }
        JSObject o = new JSObject();
        o.put("name", name);
        o.put("replace", replace == null ? JSObject.NULL : replace);
        o.put("note", note == null ? JSObject.NULL : note);
        o.put("search", search == null ? JSObject.NULL : search);
        o.put("specs", rows);
        return o;
    }

    private static void add(JSArray groups, String id, String title, List<JSObject> items) {
        if (items.isEmpty()) return;
        JSArray list = new JSArray();
        for (JSObject i : items) list.put(i);
        JSObject g = new JSObject();
        g.put("id", id);
        g.put("title", title);
        g.put("items", list);
        groups.put(g);
    }

    private static String read(String path) {
        try (BufferedReader r = new BufferedReader(new FileReader(path))) {
            String line = r.readLine();
            return line == null ? null : line.trim();
        } catch (Exception e) {
            return null;
        }
    }

    private static String gb(long bytes) {
        double g = bytes / 1073741824.0;
        return g >= 10 ? String.format(Locale.US, "%.0f GB", g) : String.format(Locale.US, "%.1f GB", g);
    }

    private static String cap(String s) {
        return s == null || s.isEmpty() ? "" : s.substring(0, 1).toUpperCase(Locale.ROOT) + s.substring(1);
    }

    static JSObject build(Context ctx, Object battery, String ramType) throws Exception {
        String device = Build.MODEL.toLowerCase(Locale.ROOT).startsWith(Build.MANUFACTURER.toLowerCase(Locale.ROOT)) ? Build.MODEL : cap(Build.MANUFACTURER) + " " + Build.MODEL;
        JSArray groups = new JSArray();
        List<JSObject> list;

        // ---- the phone itself ----
        list = new ArrayList<>();
        list.add(item(device, null, "Quote this exact model when ordering parts: models with similar names often differ.", device + " parts",
            "Manufacturer", cap(Build.MANUFACTURER), "Brand", cap(Build.BRAND), "Model", Build.MODEL, "Device code", Build.DEVICE, "Product", Build.PRODUCT,
            "Android", Build.VERSION.RELEASE, "Security patch", Build.VERSION.SECURITY_PATCH));
        add(groups, "system", "Phone", list);

        // ---- processor ----
        list = new ArrayList<>();
        String soc = Build.HARDWARE;
        String socMaker = "";
        if (Build.VERSION.SDK_INT >= 31 && !Build.SOC_MODEL.equals(Build.UNKNOWN)) {
            soc = Build.SOC_MODEL;
            socMaker = Build.SOC_MANUFACTURER.equals(Build.UNKNOWN) ? "" : cap(Build.SOC_MANUFACTURER);
        }
        int cores = Runtime.getRuntime().availableProcessors();
        Set<Long> maxFreqs = new TreeSet<>();
        for (int i = 0; i < cores; i++) {
            String f = read("/sys/devices/system/cpu/cpu" + i + "/cpufreq/cpuinfo_max_freq");
            if (f != null) {
                try {
                    maxFreqs.add(Long.parseLong(f) / 1000);
                } catch (NumberFormatException ignored) {
                }
            }
        }
        StringBuilder clusters = new StringBuilder();
        for (long f : maxFreqs) clusters.append(clusters.length() > 0 ? ", " : "").append(String.format(Locale.US, "%.2f GHz", f / 1000.0));
        list.add(item((socMaker + " " + soc).trim(), "no", "Part of the main board.", null,
            "Maker", socMaker, "Chip", soc, "Board", Build.BOARD, "Cores", String.valueOf(cores), "Top speeds", clusters.toString(),
            "Instruction sets", String.join(", ", Build.SUPPORTED_ABIS)));
        add(groups, "cpu", "Processor", list);

        // ---- memory ----
        ActivityManager am = ctx.getSystemService(ActivityManager.class);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        long installed = Build.VERSION.SDK_INT >= 34 && mi.advertisedMem > 0 ? mi.advertisedMem : mi.totalMem;
        list = new ArrayList<>();
        list.add(item(gb(installed) + " " + ramType, "no", "Soldered to the main board.", null, "Capacity", gb(installed), "Type", ramType));
        add(groups, "ram", "Memory", list);

        // ---- storage ----
        list = new ArrayList<>();
        StorageStatsManager ssm = ctx.getSystemService(StorageStatsManager.class);
        long total = ssm.getTotalBytes(StorageManager.UUID_DEFAULT);
        String kind = new File("/sys/block/sda").exists() ? "UFS" : new File("/sys/block/mmcblk0").exists() ? "eMMC" : null;
        String flashModel = read("/sys/block/sda/device/model");
        if (flashModel == null) flashModel = read("/sys/block/mmcblk0/device/name");
        list.add(item("Internal storage " + gb(total), "no", "Soldered to the main board.", null,
            "Capacity", gb(total), "Type", kind, "Chip", flashModel, "Maker", read("/sys/block/sda/device/vendor")));
        StorageManager sm = ctx.getSystemService(StorageManager.class);
        for (StorageVolume v : sm.getStorageVolumes()) {
            if (v.isRemovable()) list.add(item(v.getDescription(ctx), "yes", null, null, "Type", "Removable card"));
        }
        add(groups, "storage", "Storage", list);

        // ---- display ----
        list = new ArrayList<>();
        DisplayManager dm = ctx.getSystemService(DisplayManager.class);
        for (Display d : dm.getDisplays()) {
            DisplayMetrics m = new DisplayMetrics();
            d.getRealMetrics(m);
            double inches = Math.hypot(m.widthPixels / m.xdpi, m.heightPixels / m.ydpi);
            Set<Integer> rates = new TreeSet<>();
            for (Display.Mode mode : d.getSupportedModes()) rates.add(Math.round(mode.getRefreshRate()));
            StringBuilder hz = new StringBuilder();
            for (int r : rates) hz.append(hz.length() > 0 ? ", " : "").append(r).append(" Hz");
            boolean hdr = d.getHdrCapabilities() != null && d.getHdrCapabilities().getSupportedHdrTypes().length > 0;
            list.add(item(String.format(Locale.US, "%.1f inch screen", inches), "tech", "Usually sold as a full assembly with the glass and frame.", device + " screen replacement",
                "Resolution", m.widthPixels + " x " + m.heightPixels, "Pixel density", m.densityDpi + " dpi", "Refresh rates", hz.toString(), "HDR", hdr ? "Yes" : "No"));
        }
        add(groups, "display", "Display", list);

        // ---- battery ----
        list = new ArrayList<>();
        if (battery instanceof JSObject) {
            JSObject b = (JSObject) battery;
            list.add(item("Battery", "tech", "Replaced by a repair shop on most phones.", device + " battery replacement",
                "Chemistry", b.optString("chemistry", ""),
                "Factory capacity", b.has("designCapacity") && !b.isNull("designCapacity") ? b.optLong("designCapacity") + " mAh" : "",
                "Capacity now", b.has("fullCapacity") && !b.isNull("fullCapacity") ? b.optLong("fullCapacity") + " mAh" : "",
                "Cycles", b.has("cycles") && !b.isNull("cycles") ? String.valueOf(b.optLong("cycles")) : ""));
        }
        list.add(item("Charging port", "tech", "A common repair. Often sold with its small board.", device + " charging port replacement"));
        add(groups, "battery", "Battery and charging", list);

        // ---- cameras ----
        list = new ArrayList<>();
        try {
            CameraManager cm = ctx.getSystemService(CameraManager.class);
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics c = cm.getCameraCharacteristics(id);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                String where = facing == null ? "Camera" : facing == CameraCharacteristics.LENS_FACING_FRONT ? "Front camera" : facing == CameraCharacteristics.LENS_FACING_BACK ? "Rear camera" : "External camera";
                Size px = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
                String mp = px == null ? "" : String.format(Locale.US, "%.1f MP", px.getWidth() * px.getHeight() / 1e6);
                SizeF physical = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
                float[] focal = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                float[] aperture = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_APERTURES);
                Boolean flash = c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                list.add(item((where + " " + mp).trim(), "tech", null, device + " " + where.toLowerCase(Locale.ROOT) + " replacement",
                    "Resolution", px == null ? "" : mp + " (" + px.getWidth() + " x " + px.getHeight() + ")",
                    "Sensor size", physical == null ? "" : String.format(Locale.US, "%.1f x %.1f mm", physical.getWidth(), physical.getHeight()),
                    "Focal length", focal == null || focal.length == 0 ? "" : String.format(Locale.US, "%.1f mm", focal[0]),
                    "Aperture", aperture == null || aperture.length == 0 ? "" : String.format(Locale.US, "f/%.1f", aperture[0]),
                    "Flash", flash == null ? "" : flash ? "Yes" : "No"));
            }
        } catch (Exception ignored) {
            // Some phones refuse camera details; the rest of the list still works.
        }
        add(groups, "camera", "Cameras", list);

        // ---- connectivity ----
        PackageManager pm = ctx.getPackageManager();
        list = new ArrayList<>();
        WifiManager wifi = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (pm.hasSystemFeature(PackageManager.FEATURE_WIFI) && wifi != null) {
            StringBuilder bands = new StringBuilder("2.4 GHz");
            if (wifi.is5GHzBandSupported()) bands.append(", 5 GHz");
            if (Build.VERSION.SDK_INT >= 30 && wifi.is6GHzBandSupported()) bands.append(", 6 GHz");
            list.add(item("Wi-Fi", "no", null, null, "Bands", bands.toString()));
        }
        Object[][] features = {
            {PackageManager.FEATURE_BLUETOOTH, "Bluetooth"}, {PackageManager.FEATURE_BLUETOOTH_LE, "Bluetooth Low Energy"},
            {PackageManager.FEATURE_TELEPHONY, "Mobile network"}, {PackageManager.FEATURE_NFC, "NFC"}, {PackageManager.FEATURE_LOCATION_GPS, "GPS"},
            {PackageManager.FEATURE_CONSUMER_IR, "Infrared blaster"}, {PackageManager.FEATURE_USB_HOST, "USB host"},
        };
        for (Object[] f : features) if (pm.hasSystemFeature((String) f[0])) list.add(item((String) f[1], "no", null, null));
        add(groups, "network", "Connectivity", list);

        // ---- audio ----
        list = new ArrayList<>();
        AudioManager audio = ctx.getSystemService(AudioManager.class);
        Set<String> seen = new HashSet<>();
        for (AudioDeviceInfo a : audio.getDevices(AudioManager.GET_DEVICES_ALL)) {
            String label;
            switch (a.getType()) {
                case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: label = "Speaker"; break;
                case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: label = "Earpiece"; break;
                case AudioDeviceInfo.TYPE_BUILTIN_MIC: label = "Microphone"; break;
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: label = "Headphone jack"; break;
                default: label = null;
            }
            if (label != null && seen.add(label)) list.add(item(label, "tech", null, device + " " + label.toLowerCase(Locale.ROOT) + " replacement"));
        }
        add(groups, "audio", "Audio", list);

        // ---- sign-in hardware ----
        list = new ArrayList<>();
        if (pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)) list.add(item("Fingerprint reader", "tech", null, device + " fingerprint sensor replacement"));
        if (Build.VERSION.SDK_INT >= 29 && pm.hasSystemFeature(PackageManager.FEATURE_FACE)) list.add(item("Face recognition", "no", null, null));
        add(groups, "input", "Sign-in", list);

        // ---- sensors ----
        list = new ArrayList<>();
        SensorManager sensors = ctx.getSystemService(SensorManager.class);
        Set<String> names = new HashSet<>();
        for (Sensor s : sensors.getSensorList(Sensor.TYPE_ALL)) {
            if (!names.add(s.getName())) continue;
            list.add(item(s.getName(), "no", null, null, "Maker", s.getVendor(), "Type", s.getStringType().replace("android.sensor.", "").replace('_', ' '),
                "Power", s.getPower() > 0 ? String.format(Locale.US, "%.2f mA", s.getPower()) : ""));
        }
        add(groups, "sensors", "Sensors", list);

        JSObject o = new JSObject();
        o.put("platform", "android");
        o.put("device", device);
        o.put("groups", groups);
        return o;
    }
}
