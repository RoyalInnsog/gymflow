package com.gymflow.app;

import android.content.Intent;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.contract.ActivityResultContract;

import androidx.health.connect.client.HealthConnectClient;
import androidx.health.connect.client.PermissionController;
import androidx.health.connect.client.records.HeartRateRecord;
import androidx.health.connect.client.records.SleepSessionRecord;
import androidx.health.connect.client.records.StepsRecord;
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord;
import androidx.health.connect.client.records.WeightRecord;
import androidx.health.connect.client.request.ReadRecordsRequest;
import androidx.health.connect.client.response.ReadRecordsResponse;
import androidx.health.connect.client.time.TimeRangeFilter;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kotlin.coroutines.EmptyCoroutineContext;
import kotlin.jvm.JvmClassMappingKt;
import kotlinx.coroutines.BuildersKt;

/**
 * Gym Flow — Native Google Health Connect bridge (real data, no mocks).
 *
 * Exposed to the web layer as the Capacitor plugin "HealthConnect", matching the
 * method/shape the Progress "Wearables" gateway calls generically:
 *   • requestPermissions({ read: [scopeKey...] }) -> { granted, grantedPermissions:[scopeKey...] }
 *   • checkPermissions()                          -> { grantedPermissions:[scopeKey...] }
 *   • fetchData({ startDate, endDate, metrics })  -> { biometrics:[{ type, value, timestamp }] }
 *
 * Health Connect's read/aggregate APIs are Kotlin `suspend` functions; we bridge
 * them from Java via BuildersKt.runBlocking on a background thread (see readList()).
 */
@CapacitorPlugin(name = "HealthConnect")
public class HealthConnectPlugin extends Plugin {

    private static final String PROVIDER = "com.google.android.apps.healthdata";

    // scopeKey (web) -> Health Connect permission string.
    private static String permFor(String key) {
        switch (key) {
            case "steps":       return "android.permission.health.READ_STEPS";
            case "heart_rate":  return "android.permission.health.READ_HEART_RATE";
            case "sleep":       return "android.permission.health.READ_SLEEP";
            case "exercise":    return "android.permission.health.READ_EXERCISE";
            case "calories":    return "android.permission.health.READ_TOTAL_CALORIES_BURNED";
            case "weight":      return "android.permission.health.READ_WEIGHT";
            default:            return null;
        }
    }
    private static String keyFor(String perm) {
        if (perm == null) return null;
        if (perm.endsWith("READ_STEPS")) return "steps";
        if (perm.endsWith("READ_HEART_RATE")) return "heart_rate";
        if (perm.endsWith("READ_SLEEP")) return "sleep";
        if (perm.endsWith("READ_EXERCISE")) return "exercise";
        if (perm.endsWith("READ_TOTAL_CALORIES_BURNED")) return "calories";
        if (perm.endsWith("READ_WEIGHT")) return "weight";
        return null;
    }

    private boolean available() {
        try {
            return HealthConnectClient.getSdkStatus(getContext(), PROVIDER) == HealthConnectClient.SDK_AVAILABLE;
        } catch (Throwable t) {
            return false;
        }
    }
    private HealthConnectClient client() {
        return HealthConnectClient.getOrCreate(getContext());
    }

    // ── permissions ────────────────────────────────────────────────────────
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (!available()) { call.reject("Health Connect is not available on this device."); return; }
        Set<String> perms = new HashSet<>();
        JSArray read = call.getArray("read", null);
        try {
            List<String> keys = read != null ? read.toList() : new ArrayList<>();
            for (String k : keys) { String p = permFor(k); if (p != null) perms.add(p); }
        } catch (Exception e) { /* fall through with whatever parsed */ }
        if (perms.isEmpty()) { call.reject("No valid health scopes requested."); return; }

        ActivityResultContract<Set<String>, Set<String>> contract =
                PermissionController.createRequestPermissionResultContract();
        Intent intent = contract.createIntent(getContext(), perms);
        startActivityForResult(call, intent, "permissionCallback");
    }

    @ActivityCallback
    private void permissionCallback(PluginCall call, ActivityResult result) {
        if (call == null) return;
        ActivityResultContract<Set<String>, Set<String>> contract =
                PermissionController.createRequestPermissionResultContract();
        Set<String> granted;
        try {
            granted = contract.parseResult(result.getResultCode(), result.getData());
        } catch (Throwable t) {
            granted = Collections.emptySet();
        }
        JSArray arr = new JSArray();
        for (String p : granted) { String key = keyFor(p); if (key != null) arr.put(key); }
        JSObject ret = new JSObject();
        ret.put("granted", granted != null && !granted.isEmpty());
        ret.put("grantedPermissions", arr);
        call.resolve(ret);
    }

    // Open the Health Connect permission/settings screen so a user who denied
    // access (or revoked it later) can grant it without hunting through Android
    // settings. Falls back to this app's details page if HC has no settings UI.
    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent("androidx.health.ACTION_HEALTH_CONNECT_SETTINGS");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                fallback.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Could not open settings: " + e2.getMessage());
            }
        }
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        if (!available()) { call.reject("Health Connect is not available on this device."); return; }
        new Thread(() -> {
            try {
                @SuppressWarnings("unchecked")
                Set<String> granted = (Set<String>) BuildersKt.runBlocking(
                        EmptyCoroutineContext.INSTANCE,
                        (scope, cont) -> client().getPermissionController().getGrantedPermissions(cont));
                JSArray arr = new JSArray();
                for (String p : granted) { String key = keyFor(p); if (key != null) arr.put(key); }
                JSObject ret = new JSObject();
                ret.put("grantedPermissions", arr);
                resolveOnUi(call, ret);
            } catch (Throwable t) {
                rejectOnUi(call, "checkPermissions failed: " + t.getMessage());
            }
        }).start();
    }

    // ── read real biometrics, bucketed per calendar day ─────────────────────
    @PluginMethod
    public void fetchData(final PluginCall call) {
        if (!available()) { call.reject("Health Connect is not available on this device."); return; }
        final Instant start = parseInstant(call.getString("startDate"), Instant.now().minusSeconds(7L * 24 * 3600));
        final Instant end = parseInstant(call.getString("endDate"), Instant.now());
        final Set<String> metrics = new HashSet<>();
        JSArray m = call.getArray("metrics", null);
        try { if (m != null) metrics.addAll(m.toList()); } catch (Exception e) { /* read all */ }
        final boolean all = metrics.isEmpty();

        new Thread(() -> {
            try {
                HealthConnectClient c = client();
                TimeRangeFilter range = TimeRangeFilter.between(start, end);
                ZoneId zone = ZoneId.systemDefault();

                // day -> aggregated bucket
                Map<String, double[]> steps = new LinkedHashMap<>();   // [sum]
                Map<String, double[]> cals = new LinkedHashMap<>();    // [sum]
                Map<String, double[]> sleep = new LinkedHashMap<>();   // [minutes]
                Map<String, double[]> hr = new LinkedHashMap<>();      // [sum, count]
                Map<String, double[]> weight = new LinkedHashMap<>();  // [latestKg, latestTsMs]

                if (all || metrics.contains("steps")) {
                    for (StepsRecord r : readList(c, StepsRecord.class, range)) {
                        add1(steps, day(r.getStartTime(), zone), r.getCount());
                    }
                }
                if (all || metrics.contains("calories")) {
                    for (TotalCaloriesBurnedRecord r : readList(c, TotalCaloriesBurnedRecord.class, range)) {
                        add1(cals, day(r.getStartTime(), zone), r.getEnergy().getKilocalories());
                    }
                }
                if (all || metrics.contains("sleep")) {
                    for (SleepSessionRecord r : readList(c, SleepSessionRecord.class, range)) {
                        long mins = (r.getEndTime().toEpochMilli() - r.getStartTime().toEpochMilli()) / 60000L;
                        add1(sleep, day(r.getStartTime(), zone), mins);
                    }
                }
                if (all || metrics.contains("heart_rate")) {
                    for (HeartRateRecord r : readList(c, HeartRateRecord.class, range)) {
                        for (HeartRateRecord.Sample s : r.getSamples()) {
                            String d = day(s.getTime(), zone);
                            double[] v = hr.get(d);
                            if (v == null) { v = new double[]{0, 0}; hr.put(d, v); }
                            v[0] += s.getBeatsPerMinute();
                            v[1] += 1;
                        }
                    }
                }
                if (all || metrics.contains("weight")) {
                    for (WeightRecord r : readList(c, WeightRecord.class, range)) {
                        String d = day(r.getTime(), zone);
                        double ts = r.getTime().toEpochMilli();
                        double[] v = weight.get(d);
                        if (v == null || ts >= v[1]) weight.put(d, new double[]{ r.getWeight().getKilograms(), ts });
                    }
                }

                JSArray biometrics = new JSArray();
                pushSums(biometrics, steps, "steps", zone);
                pushSums(biometrics, cals, "calories", zone);
                pushSums(biometrics, sleep, "sleep", zone);
                for (Map.Entry<String, double[]> e : hr.entrySet()) {
                    if (e.getValue()[1] > 0) {
                        biometrics.put(biometric("heart_rate", Math.round(e.getValue()[0] / e.getValue()[1]), dayMs(e.getKey(), zone)));
                    }
                }
                for (Map.Entry<String, double[]> e : weight.entrySet()) {
                    biometrics.put(biometric("weight", round1(e.getValue()[0]), dayMs(e.getKey(), zone)));
                }

                JSObject ret = new JSObject();
                ret.put("biometrics", biometrics);
                resolveOnUi(call, ret);
            } catch (Throwable t) {
                rejectOnUi(call, "fetchData failed: " + t.getMessage());
            }
        }).start();
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    @SuppressWarnings("unchecked")
    private <T extends androidx.health.connect.client.records.Record> List<T> readList(
            HealthConnectClient c, Class<T> type, TimeRangeFilter range) throws InterruptedException {
        ReadRecordsRequest<T> req = new ReadRecordsRequest<>(
                JvmClassMappingKt.getKotlinClass(type), range,
                Collections.emptySet(), true, 5000, null);
        ReadRecordsResponse<T> resp = (ReadRecordsResponse<T>) BuildersKt.runBlocking(
                EmptyCoroutineContext.INSTANCE,
                (scope, cont) -> c.readRecords(req, cont));
        return resp != null ? resp.getRecords() : new ArrayList<>();
    }

    private static void add1(Map<String, double[]> map, String day, double v) {
        double[] cur = map.get(day);
        if (cur == null) { cur = new double[]{0}; map.put(day, cur); }
        cur[0] += v;
    }
    private void pushSums(JSArray out, Map<String, double[]> map, String type, ZoneId zone) {
        for (Map.Entry<String, double[]> e : map.entrySet()) {
            out.put(biometric(type, Math.round(e.getValue()[0]), dayMs(e.getKey(), zone)));
        }
    }
    private JSObject biometric(String type, Object value, long tsMs) {
        JSObject o = new JSObject();
        o.put("type", type);
        o.put("value", value);
        o.put("timestamp", tsMs);
        return o;
    }
    private static String day(Instant t, ZoneId zone) { return t.atZone(zone).toLocalDate().toString(); }
    private static long dayMs(String isoDay, ZoneId zone) {
        return LocalDate.parse(isoDay).atStartOfDay(zone).toInstant().toEpochMilli();
    }
    private static double round1(double v) { return Math.round(v * 10.0) / 10.0; }
    private static Instant parseInstant(String iso, Instant fallback) {
        try { return iso != null ? Instant.parse(iso) : fallback; } catch (Exception e) { return fallback; }
    }

    private void resolveOnUi(final PluginCall call, final JSObject data) {
        if (getActivity() == null) { call.resolve(data); return; }
        getActivity().runOnUiThread(() -> call.resolve(data));
    }
    private void rejectOnUi(final PluginCall call, final String msg) {
        if (getActivity() == null) { call.reject(msg); return; }
        getActivity().runOnUiThread(() -> call.reject(msg));
    }
}
