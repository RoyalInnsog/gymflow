package com.gymflow.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Build;
import android.os.ParcelUuid;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Gym Flow — Native BLE smartwatch bridge (real hardware, no mocks).
 *
 * Exposed to the web layer as the Capacitor plugin "WearableBridge". It scans for
 * the standard Bluetooth Heart Rate service (0x180D), connects the chosen device's
 * GATT server, subscribes to the Heart Rate Measurement characteristic (0x2A37),
 * and streams every real notification back to JS as a "characteristicChanged" event.
 *
 * Methods (match the Progress "Wearables" gateway):
 *   startScan({ }) / stopScan()   → emits "deviceFound" { deviceId, name, rssi }
 *   connect({ deviceId })         → emits "connected" / "disconnected" and, live,
 *                                    "characteristicChanged" { heartRate, timestamp }
 *   disconnect()
 *   isConnected() / checkConnectionState() → { connected }
 */
@CapacitorPlugin(
    name = "WearableBridge",
    permissions = {
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT
        }),
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION
        })
    }
)
public class WearableBridgePlugin extends Plugin {

    private static final UUID HR_SERVICE = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb");
    private static final UUID HR_MEASUREMENT = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private BluetoothGatt gatt;
    private volatile boolean connected = false;
    private final Map<String, BluetoothDevice> found = new HashMap<>();

    private String scanAlias() { return Build.VERSION.SDK_INT >= 31 ? "bluetooth" : "location"; }

    private BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return bm != null ? bm.getAdapter() : null;
    }

    // ── scanning ─────────────────────────────────────────────────────────────
    @PluginMethod
    public void startScan(PluginCall call) {
        String alias = scanAlias();
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias, call, "scanPermsCallback");
        } else {
            doScan(call);
        }
    }

    @PermissionCallback
    private void scanPermsCallback(PluginCall call) {
        if (getPermissionState(scanAlias()) == PermissionState.GRANTED) doScan(call);
        else call.reject("Bluetooth permission was denied.");
    }

    private void doScan(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) { call.reject("Bluetooth is turned off."); return; }
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { call.reject("BLE scanner unavailable on this device."); return; }
        found.clear();

        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(new ParcelUuid(HR_SERVICE)).build());
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();

        scanCallback = new ScanCallback() {
            @Override public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice d = result.getDevice();
                if (d == null || d.getAddress() == null || found.containsKey(d.getAddress())) return;
                found.put(d.getAddress(), d);
                String name = null;
                try { name = d.getName(); } catch (SecurityException ignored) {}
                if (name == null && result.getScanRecord() != null) name = result.getScanRecord().getDeviceName();
                JSObject ev = new JSObject();
                ev.put("deviceId", d.getAddress());
                ev.put("name", name != null ? name : "Heart Rate Monitor");
                ev.put("rssi", result.getRssi());
                notifyListeners("deviceFound", ev);
            }
            @Override public void onScanFailed(int errorCode) {
                JSObject ev = new JSObject(); ev.put("error", "scan failed (" + errorCode + ")");
                notifyListeners("scanError", ev);
            }
        };

        try {
            scanner.startScan(filters, settings, scanCallback);
            call.resolve();
        } catch (SecurityException e) {
            call.reject("Missing Bluetooth scan permission.");
        }
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        stopScanInternal();
        call.resolve();
    }
    private void stopScanInternal() {
        try { if (scanner != null && scanCallback != null) scanner.stopScan(scanCallback); } catch (Exception ignored) {}
        scanCallback = null;
    }

    // ── connect / stream ──────────────────────────────────────────────────────
    @PluginMethod
    public void connect(final PluginCall call) {
        final String deviceId = call.getString("deviceId");
        if (deviceId == null || deviceId.isEmpty()) { call.reject("deviceId is required."); return; }
        BluetoothAdapter adapter = adapter();
        if (adapter == null) { call.reject("Bluetooth is unavailable."); return; }
        stopScanInternal();

        final BluetoothDevice device;
        try { device = adapter.getRemoteDevice(deviceId); }
        catch (IllegalArgumentException e) { call.reject("Invalid deviceId."); return; }

        try {
            gatt = device.connectGatt(getContext(), false, new BluetoothGattCallback() {
                @Override public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        try { g.discoverServices(); } catch (SecurityException ignored) {}
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        connected = false;
                        JSObject ev = new JSObject(); ev.put("deviceId", deviceId);
                        notifyListeners("disconnected", ev);
                        try { g.close(); } catch (Exception ignored) {}
                    }
                }
                @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
                    BluetoothGattService svc = g.getService(HR_SERVICE);
                    if (svc == null) { call.reject("Heart Rate service not found on device."); return; }
                    BluetoothGattCharacteristic ch = svc.getCharacteristic(HR_MEASUREMENT);
                    if (ch == null) { call.reject("Heart Rate characteristic not found."); return; }
                    try {
                        g.setCharacteristicNotification(ch, true);
                        BluetoothGattDescriptor cccd = ch.getDescriptor(CCCD);
                        if (cccd != null) {
                            if (Build.VERSION.SDK_INT >= 33) {
                                g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                            } else {
                                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                                g.writeDescriptor(cccd);
                            }
                        }
                        connected = true;
                        JSObject ev = new JSObject(); ev.put("deviceId", deviceId);
                        notifyListeners("connected", ev);
                        call.resolve(ev);
                    } catch (SecurityException e) {
                        call.reject("Missing Bluetooth connect permission.");
                    }
                }
                // API 33+ delivers the value directly.
                @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value) {
                    emitHeartRate(value);
                }
                // Pre-33 path.
                @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
                    emitHeartRate(ch.getValue());
                }
            });
        } catch (SecurityException e) {
            call.reject("Missing Bluetooth connect permission.");
        }
    }

    private void emitHeartRate(byte[] data) {
        if (data == null || data.length == 0) return;
        int flags = data[0] & 0xFF;
        int bpm;
        if ((flags & 0x01) != 0) { // 16-bit value
            if (data.length < 3) return;
            bpm = (data[1] & 0xFF) | ((data[2] & 0xFF) << 8);
        } else { // 8-bit value
            if (data.length < 2) return;
            bpm = data[1] & 0xFF;
        }
        if (bpm <= 0) return;
        JSObject ev = new JSObject();
        ev.put("heartRate", bpm);
        ev.put("timestamp", System.currentTimeMillis());
        notifyListeners("characteristicChanged", ev);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        try { if (gatt != null) { gatt.disconnect(); gatt.close(); } } catch (Exception ignored) {}
        gatt = null;
        connected = false;
        call.resolve();
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        JSObject r = new JSObject(); r.put("connected", connected); call.resolve(r);
    }
    @PluginMethod
    public void checkConnectionState(PluginCall call) { isConnected(call); }

    @Override
    protected void handleOnDestroy() {
        stopScanInternal();
        try { if (gatt != null) { gatt.disconnect(); gatt.close(); } } catch (Exception ignored) {}
        gatt = null;
        connected = false;
        super.handleOnDestroy();
    }
}
