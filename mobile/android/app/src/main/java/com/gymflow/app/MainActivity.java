package com.gymflow.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the native on-device LLM plugin (Gemma via MediaPipe).
        registerPlugin(GymLlmPlugin.class);
        // Production wearables: Google Health Connect + BLE smartwatch heart-rate.
        registerPlugin(HealthConnectPlugin.class);
        registerPlugin(WearableBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
