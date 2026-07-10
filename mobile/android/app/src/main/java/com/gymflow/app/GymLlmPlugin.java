package com.gymflow.app;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.mediapipe.tasks.genai.llminference.LlmInference;
import com.google.mediapipe.tasks.genai.llminference.LlmInference.LlmInferenceOptions;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession.LlmInferenceSessionOptions;
import com.google.mediapipe.tasks.genai.llminference.ProgressListener;

import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;

/**
 * Gym Flow — Native on-device LLM (Gemma 3n E2B via MediaPipe LLM Inference).
 *
 * Real production engine — NO mocks, NO static-string timeouts. Bridged to the
 * JS layer as the Capacitor plugin "GymLlm"; the web wrapper (memberLLM.js)
 * turns it into window.GymNativeLLM and registers it as the GymAI backend.
 *
 * Everything runs on-device; the only network use is the one-time model
 * download. No external app is ever launched.
 *
 * MediaPipe API version note (tasks-genai 0.10.x): the streaming callback is set
 * on the options via setResultListener((partial, done) -> ...). If your exact
 * version instead takes the listener on generateResponseAsync(prompt, listener),
 * move the reference at the single spot marked "STREAMING API".
 */
@CapacitorPlugin(name = "GymLlm")
public class GymLlmPlugin extends Plugin {

    private static final String MODEL_DIR = "llm";
    private static final String MODEL_FILE = "gemma-e2b.task";

    // Fully-specified generation defaults. Previously only MAX_TOKENS was set on
    // the engine and sampling was left unconfigured, so the model ran in an
    // effectively greedy "quick mode" (shallow/short completions). These are the
    // real knobs; all overridable from JS via loadModel({...}) / generate({...}).
    private static final int   DEFAULT_MAX_TOKENS  = 1024;   // full completion budget
    private static final int   DEFAULT_TOP_K       = 40;     // sampling breadth
    private static final float DEFAULT_TOP_P       = 0.95f;  // nucleus sampling
    private static final float DEFAULT_TEMPERATURE = 0.8f;   // creativity

    // Single-instance singleton kept warm while the app is active.
    private LlmInference llm;
    private volatile String activeRequestId;
    private long downloadId = -1;

    // Load-time generation config, reused when building each inference session.
    private int   genMaxTokens  = DEFAULT_MAX_TOKENS;
    private int   genTopK       = DEFAULT_TOP_K;
    private float genTopP       = DEFAULT_TOP_P;
    private float genTemperature = DEFAULT_TEMPERATURE;

    private File modelFile() {
        File dir = new File(getContext().getExternalFilesDir(null), MODEL_DIR);
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, MODEL_FILE);
    }

    // ── status ────────────────────────────────────────────────────────────
    @PluginMethod
    public void status(PluginCall call) {
        boolean ready = llm != null;
        JSObject r = new JSObject();
        r.put("ready", ready);
        r.put("status", ready ? "ready" : (modelFile().exists() ? "downloaded" : "idle"));
        r.put("modelPresent", modelFile().exists());
        r.put("path", modelFile().getAbsolutePath());
        call.resolve(r);
    }

    // 1) initializeNativeEngine — options mapping is prepared at load time.
    @PluginMethod
    public void initEngine(PluginCall call) { call.resolve(); }

    // 2) downloadModelWithProgress — Android DownloadManager + progress + checksum.
    @PluginMethod
    public void downloadModel(final PluginCall call) {
        final String url = call.getString("url", "");
        final String sha256 = call.getString("sha256", null);
        if (url == null || url.isEmpty()) { call.reject("Missing model url"); return; }
        final File dest = modelFile();
        // Resume-friendly: a completed file short-circuits (re-download not needed).
        if (dest.exists() && dest.length() > 0) { call.resolve(); return; }
        try {
            DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("Gym Flow AI model");
            req.setDescription("On-device Gemma model");
            req.setDestinationInExternalFilesDir(getContext(), MODEL_DIR, MODEL_FILE + ".part");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
            req.setAllowedOverMetered(true);
            req.setAllowedOverRoaming(true);
            downloadId = dm.enqueue(req);
            pollDownload(dm, downloadId, dest, sha256, call);
        } catch (Exception e) {
            call.reject("Download failed: " + e.getMessage());
        }
    }

    private void pollDownload(final DownloadManager dm, final long id, final File dest,
                             final String sha256, final PluginCall call) {
        final Handler h = new Handler(Looper.getMainLooper());
        h.post(new Runnable() {
            @Override public void run() {
                Cursor c = null;
                try {
                    c = dm.query(new DownloadManager.Query().setFilterById(id));
                    if (c != null && c.moveToFirst()) {
                        int st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        long soFar = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        if (total > 0) {
                            JSObject ev = new JSObject();
                            ev.put("progress", (double) soFar / (double) total);
                            ev.put("bytes", soFar);
                            ev.put("total", total);
                            notifyListeners("downloadProgress", ev);
                        }
                        if (st == DownloadManager.STATUS_SUCCESSFUL) {
                            File part = new File(dest.getParentFile(), MODEL_FILE + ".part");
                            if (part.exists()) { if (!part.renameTo(dest)) part.renameTo(dest); }
                            if (sha256 != null && !verifyChecksum(dest, sha256)) {
                                dest.delete();
                                call.reject("Checksum mismatch — download discarded");
                                return;
                            }
                            call.resolve();
                            return;
                        } else if (st == DownloadManager.STATUS_FAILED) {
                            call.reject("Download failed (status)");
                            return;
                        }
                    }
                } catch (Exception e) {
                    call.reject("Download poll error: " + e.getMessage());
                    return;
                } finally {
                    if (c != null) c.close();
                }
                h.postDelayed(this, 500);
            }
        });
    }

    private boolean verifyChecksum(File f, String expectedHex) {
        FileInputStream in = null;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            in = new FileInputStream(f);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            byte[] dig = md.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : dig) sb.append(String.format("%02x", b));
            return sb.toString().equalsIgnoreCase(expectedHex);
        } catch (Exception e) {
            return false;
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) {}
        }
    }

    // 3) loadModelToRAM — strict single-instance singleton on a background thread.
    @PluginMethod
    public void loadModel(final PluginCall call) {
        if (llm != null) { call.resolve(); return; }
        final File f = modelFile();
        if (!f.exists()) { call.reject("Model not downloaded"); return; }

        // Read the full generation config (with fully-initialised defaults — no
        // silent truncation). maxTokens + maxTopK belong on the ENGINE; the
        // per-sample topK/topP/temperature are applied on the session in
        // generate(). This is the tasks-genai 0.10.14 split.
        final int   maxTokens = call.getInt("maxTokens", DEFAULT_MAX_TOKENS);
        final int   topK      = call.getInt("topK", DEFAULT_TOP_K);
        final double topP     = call.getDouble("topP", (double) DEFAULT_TOP_P);
        final double temp     = call.getDouble("temperature", (double) DEFAULT_TEMPERATURE);

        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    LlmInferenceOptions options = LlmInferenceOptions.builder()
                            .setModelPath(f.getAbsolutePath())
                            .setMaxTokens(maxTokens)
                            // Engine ceiling for top-k; the session's topK must be <= this.
                            .setMaxTopK(Math.max(topK, DEFAULT_TOP_K))
                            .build();
                    synchronized (GymLlmPlugin.this) {
                        if (llm == null) llm = LlmInference.createFromOptions(getContext(), options);
                        genMaxTokens = maxTokens;
                        genTopK = topK;
                        genTopP = (float) topP;
                        genTemperature = (float) temp;
                    }
                    resolveOnUi(call, null);
                } catch (Throwable t) {
                    rejectOnUi(call, "Load failed: " + t.getMessage());
                }
            }
        }).start();
    }

    // 4) executeStreamingInference — streams tokens back to JS in real time.
    @PluginMethod
    public void generate(final PluginCall call) {
        final String prompt = call.getString("prompt", "");
        final String reqId = call.getString("requestId", "r0");
        if (llm == null) { call.reject("Model not loaded"); return; }
        if (prompt == null || prompt.isEmpty()) { call.reject("Empty prompt"); return; }

        // Per-request sampling overrides fall back to the load-time config.
        final int    topK = call.getInt("topK", genTopK);
        final double topP = call.getDouble("topP", (double) genTopP);
        final double temp = call.getDouble("temperature", (double) genTemperature);

        activeRequestId = reqId;
        try {
            // A fresh single-turn session carries the fully-specified sampling
            // config and keeps prompts stateless (no context bleed between
            // requests). Without this the model samples with unconfigured
            // defaults → the shallow "quick mode" completions this fixes.
            LlmInferenceSessionOptions sessionOptions = LlmInferenceSessionOptions.builder()
                    .setTopK(topK)
                    .setTopP((float) topP)
                    .setTemperature((float) temp)
                    .build();
            final LlmInferenceSession session = LlmInferenceSession.createFromOptions(llm, sessionOptions);
            session.addQueryChunk(prompt);
            // Stream tokens. `done` is MediaPipe's real end-of-sequence signal —
            // llmDone is emitted ONLY when done==true, never on an intermediate
            // chunk, so completion can't fire before the EOS token is parsed.
            // The session is closed once done to release its state.
            session.generateResponseAsync(new ProgressListener<String>() {
                @Override public void run(String partialResult, boolean done) {
                    onPartial(reqId, partialResult, done);
                    if (done) { try { session.close(); } catch (Throwable ignore) {} }
                }
            });
            call.resolve(); // accepted; the stream is asynchronous
        } catch (Throwable t) {
            JSObject e = new JSObject();
            e.put("requestId", reqId);
            e.put("message", t.getMessage());
            notifyListeners("llmError", e);
            call.reject("Inference failed: " + t.getMessage());
        }
    }

    // Streams one chunk to JS. reqId is captured per-request (not read from the
    // mutable activeRequestId) so overlapping requests can never be mislabelled,
    // and llmDone only fires on a true EOS (done==true).
    private void onPartial(String reqId, String partial, boolean done) {
        if (partial != null && !partial.isEmpty()) {
            JSObject t = new JSObject();
            t.put("requestId", reqId);
            t.put("token", partial);
            notifyListeners("llmToken", t);
        }
        if (done) {
            if (reqId != null && reqId.equals(activeRequestId)) activeRequestId = null;
            JSObject d = new JSObject();
            d.put("requestId", reqId);
            notifyListeners("llmDone", d);
        }
    }

    private void onError(Throwable err) {
        JSObject e = new JSObject();
        e.put("requestId", activeRequestId);
        e.put("message", err != null ? err.getMessage() : "inference error");
        notifyListeners("llmError", e);
    }

    // 5) unloadModel — release RAM immediately, drop the singleton, hint GC.
    @PluginMethod
    public void unloadModel(PluginCall call) {
        doUnload();
        if (call != null) call.resolve();
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        doUnload();
        try { File f = modelFile(); if (f.exists()) f.delete(); } catch (Exception ignored) {}
        call.resolve();
    }

    private synchronized void doUnload() {
        try { if (llm != null) llm.close(); } catch (Throwable ignored) {}
        llm = null;
        activeRequestId = null;
        System.gc();
    }

    // Kill native resources the moment the app is destroyed.
    @Override
    protected void handleOnDestroy() {
        doUnload();
        super.handleOnDestroy();
    }

    // ── UI-thread helpers for background callbacks ──
    private void resolveOnUi(final PluginCall call, final JSObject data) {
        if (getActivity() == null) { if (data != null) call.resolve(data); else call.resolve(); return; }
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() { if (data != null) call.resolve(data); else call.resolve(); }
        });
    }
    private void rejectOnUi(final PluginCall call, final String msg) {
        if (getActivity() == null) { call.reject(msg); return; }
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() { call.reject(msg); }
        });
    }
}
