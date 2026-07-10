/*
 * Gym Flow — Member App · Phase U4 · Native LLM bridge
 * window.GymMemberLLM  (+ window.GymNativeLLM)
 *
 * Option A only. WebGPU / WebLLM has been REMOVED (unstable in WebView, fails on
 * insecure HTTP dev contexts). Inference comes exclusively from the NATIVE
 * MediaPipe engine (Gemma 3n E2B) via the Capacitor plugin "GymLlm"
 * (see mobile/android/.../GymLlmPlugin.java). Nothing runs in JS; nothing opens
 * an external app.
 *
 * This module turns the native plugin into:
 *   • window.GymNativeLLM.generate(prompt, {onToken}) -> Promise<string>  (streaming)
 *   • a registered GymAI inference backend (so chat uses the real model)
 *   • the GymMemberLLM UI API (init/load/release/forget/status/on/...) unchanged
 *
 * Outside the native app (e.g. a desktop browser during dev), the plugin is
 * absent → supported() is false → GymAI falls back to its reasoning engine.
 * That is exactly why the old WebGPU path is gone: no more insecure-context
 * crashes; dev just runs "Quick mode".
 */
window.GymMemberLLM = (function () {
  'use strict';

  // The Gemma 3n E2B .task download URL. Gemma is license-gated, so the app
  // owner supplies this (host it yourself / your gated mirror). Empty by default;
  // set at runtime via GymMemberLLM.setModelUrl(url) or bake a default here.
  var MODEL_URL = '';
  var MODEL_SHA256 = null; // optional integrity check

  // Generation config forwarded to the native engine. These are the real
  // inference knobs — leaving them unset made the model default to shallow,
  // greedy "quick mode" output. maxTokens is applied at load (engine option);
  // temperature/topP/topK are applied per request (session options).
  var GEN = { maxTokens: 1024, temperature: 0.8, topP: 0.95, topK: 40 };
  function genConfig() {
    return { maxTokens: GEN.maxTokens, temperature: GEN.temperature, topP: GEN.topP, topK: GEN.topK };
  }

  var state = { status: 'idle', progress: 0, backendId: null, error: null };
  var listeners = [];
  function emit() { listeners.forEach(function (f) { try { f(state); } catch (e) {} }); }
  function on(f) { listeners.push(f); }
  function setState(p) { for (var k in p) state[k] = p[k]; emit(); }

  // Capacitor exposes plugins at window.Capacitor.Plugins.<Name>.
  function plugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.GymLlm) || null;
  }
  function isNative() { return !!plugin(); }

  // Hardware capability probe. The production engine is the NATIVE MediaPipe
  // runtime (the gemma-e2b.task bundle is a MediaPipe asset, not an ONNX/
  // Transformers.js model, so it can't be streamed into a WebGPU graph). We
  // still surface WebGPU/WASM availability so a future browser backend can be
  // slotted in, and so the UI can explain WHY it's in reasoning ("Quick") mode.
  function capabilities() {
    var webgpu = false;
    try { webgpu = (typeof navigator !== 'undefined' && !!navigator.gpu); } catch (e) {}
    var wasm = false;
    try { wasm = (typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'); } catch (e) {}
    return { webgpu: webgpu, wasm: wasm, native: isNative() };
  }

  // ── streaming request registry (native events → per-request promises) ──
  var reqSeq = 0, reqs = {}, wired = false;
  function wireEvents() {
    if (wired) return;
    var pl = plugin();
    if (!pl || !pl.addListener) { wired = true; return; }
    pl.addListener('llmToken', function (ev) {
      var r = reqs[ev && ev.requestId]; if (!r) return;
      var tok = (ev && ev.token) || '';
      r.full += tok; if (r.onToken) r.onToken(tok, r.full);
    });
    pl.addListener('llmDone', function (ev) {
      var r = reqs[ev && ev.requestId]; if (!r) return;
      r.resolve(r.full); delete reqs[ev.requestId];
    });
    pl.addListener('llmError', function (ev) {
      var r = reqs[ev && ev.requestId]; if (!r) return;
      r.reject(new Error((ev && ev.message) || 'inference error')); delete reqs[ev.requestId];
    });
    pl.addListener('downloadProgress', function (ev) {
      setState({ status: 'downloading', progress: (ev && ev.progress != null) ? ev.progress : state.progress });
    });
    wired = true;
  }

  function nativeGenerate(prompt, opts) {
    opts = opts || {};
    var pl = plugin();
    if (!pl) return Promise.reject(new Error('The on-device model runs only inside the Gym Flow app.'));
    wireEvents();
    var id = 'r' + (++reqSeq);
    // Per-request sampling overrides fall back to the shared GEN config so the
    // native engine always receives a complete, non-truncated configuration.
    var payload = {
      requestId: id,
      prompt: prompt,
      temperature: opts.temperature != null ? opts.temperature : GEN.temperature,
      topP: opts.topP != null ? opts.topP : GEN.topP,
      topK: opts.topK != null ? opts.topK : GEN.topK
    };
    return new Promise(function (resolve, reject) {
      reqs[id] = { full: '', onToken: opts.onToken, resolve: resolve, reject: reject };
      Promise.resolve(pl.generate(payload)).catch(function (e) {
        if (reqs[id]) { reqs[id].reject(e); delete reqs[id]; }
      });
    });
  }

  function registerBackend() {
    if (!window.GymAI) return;
    window.GymNativeLLM = { generate: nativeGenerate };
    window.GymAI.models.registerBackend({ id: 'native-gemma-e2b', name: 'Gemma 3n E2B · native', ready: true, generate: nativeGenerate });
    setState({ status: 'ready', backendId: 'native-gemma-e2b' });
  }

  function init() {
    if (!isNative()) { setState({ status: 'unsupported' }); return; }
    wireEvents();
    var pl = plugin();
    Promise.resolve(pl.status ? pl.status() : { status: 'idle' }).then(function (s) {
      if (s && (s.ready || s.status === 'ready')) registerBackend();
      else setState({ status: (s && s.modelPresent) ? 'downloaded' : 'available' });
    }).catch(function () { setState({ status: 'available' }); });
  }

  // ── Local model asset ──────────────────────────────────────────────
  // The engine loads the localized model file served at public/models/gemma-e2b.task
  // (Express serves /public at the web root, so it resolves at /models/gemma-e2b.task).
  var MODEL_ASSET_PATH = '/models/gemma-e2b.task';
  function modelAssetUrl() {
    // The native DownloadManager and Range fetches need an ABSOLUTE url; resolve
    // the canonical asset path against the origin the app is served from.
    try { return new URL(MODEL_ASSET_PATH, self.location && self.location.origin).href; }
    catch (e) { return MODEL_ASSET_PATH; }
  }

  // ── IndexedDB Model Cache & Slice Loader ───────────────────────────
  var DB_NAME = 'gymflow_model_cache';
  var STORE_NAME = 'models';
  var MODEL_KEY = 'gemma-e2b.task';
  var CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB chunks

  function getCacheDB() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = function (e) { resolve(e.target.result); };
      request.onerror = function (e) { reject(e.target.error); };
    });
  }

  function checkCachedModel() {
    return getCacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var req = store.get(MODEL_KEY);
        req.onsuccess = function (e) { resolve(e.target.result || null); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    }).catch(function () { return null; });
  }

  function saveModelToCache(blob) {
    return getCacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var req = store.put(blob, MODEL_KEY);
        req.onsuccess = function () { resolve(); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function downloadModelInSlices(onProgress) {
    var url = MODEL_ASSET_PATH;
    return fetch(url, { method: 'HEAD' }).then(function (res) {
      var totalBytes = parseInt(res.headers.get('content-length'), 10) || 2003697664;
      var chunksCount = Math.ceil(totalBytes / CHUNK_SIZE);
      var loadedChunks = [];
      
      function downloadNextSlice(chunkIdx) {
        if (chunkIdx >= chunksCount) {
          var finalBlob = new Blob(loadedChunks, { type: 'application/octet-stream' });
          return Promise.resolve(finalBlob);
        }

        var start = chunkIdx * CHUNK_SIZE;
        var end = Math.min(start + CHUNK_SIZE - 1, totalBytes - 1);
        
        return fetch(url, {
          headers: { 'Range': 'bytes=' + start + '-' + end }
        }).then(function (sliceRes) {
          if (!sliceRes.ok && sliceRes.status !== 206) {
            return fetch(url).then(function (r) { return r.blob(); });
          }
          return sliceRes.blob();
        }).then(function (blob) {
          loadedChunks.push(blob);
          var progress = Math.min(((chunkIdx + 1) / chunksCount), 1);
          if (onProgress) onProgress(progress);
          return downloadNextSlice(chunkIdx + 1);
        });
      }

      return downloadNextSlice(0);
    });
  }

  // Download (if needed) → load into RAM → register as the AI backend.
  function load(onProgress) {
    var pl = plugin();
    if (!pl) return Promise.reject(new Error('The on-device model runs only inside the Gym Flow Android app.'));
    wireEvents();

    // Preferred path: the native plugin's DownloadManager fetches the exact
    // /models/gemma-e2b.task asset STRAIGHT to the file that loadModel() reads
    // (resume-friendly, no 2 GB round-trip through JS memory). Download progress
    // arrives via the "downloadProgress" event already wired above. loadModel()
    // reads the on-disk file, so we must go through downloadModel — a blob URL
    // would be ignored by the native engine.
    if (typeof pl.downloadModel === 'function') {
      setState({ status: 'downloading', progress: 0, error: null });
      return Promise.resolve(pl.downloadModel({ url: MODEL_URL || modelAssetUrl(), sha256: MODEL_SHA256 }))
        .then(function () {
          setState({ status: 'loading' });
          return pl.loadModel ? pl.loadModel(genConfig()) : {};
        })
        .then(function () { registerBackend(); if (onProgress) onProgress({ progress: 1 }); })
        .catch(function (e) { setState({ status: 'error', error: (e && e.message) || 'load failed' }); throw e; });
    }

    // Fallback for shells without downloadModel: slice-load the same asset in JS
    // and hand the plugin a blob URL.
    setState({ status: 'checking-cache', progress: 0, error: null });

    return checkCachedModel().then(function (cachedBlob) {
      if (cachedBlob) {
        console.log('[Health Model] Found cached model in IndexedDB.');
        setState({ status: 'loading' });
        var objectUrl = URL.createObjectURL(cachedBlob);
        return pl.loadModel ? pl.loadModel(Object.assign({ url: objectUrl }, genConfig())) : {};
      } else {
        console.log('[Health Model] Model not found in cache. Running dynamic slice loader...');
        setState({ status: 'downloading', progress: 0 });
        
        return downloadModelInSlices(function (progress) {
          setState({ status: 'downloading', progress: progress });
          if (onProgress) onProgress({ progress: progress });
        }).then(function (finalBlob) {
          setState({ status: 'caching' });
          return saveModelToCache(finalBlob).then(function () {
            setState({ status: 'loading' });
            var objectUrl = URL.createObjectURL(finalBlob);
            return pl.loadModel ? pl.loadModel(Object.assign({ url: objectUrl }, genConfig())) : {};
          });
        });
      }
    })
    .then(function () { 
      registerBackend(); 
      if (onProgress) onProgress({ progress: 1 }); 
    })
    .catch(function (e) { 
      setState({ status: 'error', error: (e && e.message) || 'load failed' }); 
      throw e; 
    });
  }

  function release() {
    var pl = plugin();
    if (pl && pl.unloadModel) { try { pl.unloadModel(); } catch (e) {} }
    if (window.GymAI) window.GymAI.models.unregisterBackend();
    setState({ status: isNative() ? 'available' : 'unsupported', backendId: null });
  }
  function forget() {
    var pl = plugin();
    if (pl && pl.deleteModel) { try { pl.deleteModel(); } catch (e) {} }
    release();
    setState({ status: isNative() ? 'available' : 'unsupported' });
  }

  return {
    init: init, load: load, release: release, forget: forget, on: on,
    status: function () { return state.status; },
    progress: function () { return state.progress; },
    supported: isNative,        // "supported" == running inside the native app
    hasNative: isNative,
    capabilities: capabilities,
    setModelUrl: function (u, sha) { MODEL_URL = u || ''; if (sha) MODEL_SHA256 = sha; },
    setGenConfig: function (cfg) { if (cfg && typeof cfg === 'object') { for (var k in GEN) if (cfg[k] != null) GEN[k] = cfg[k]; } return genConfig(); },
    getGenConfig: genConfig,
    state: function () { return { status: state.status, progress: state.progress, backendId: state.backendId, error: state.error }; }
  };
})();
