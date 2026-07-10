/* =====================================================================
 * Gym Flow — Geofenced Auto Check-in engine  (window.GymGeofence)
 * ---------------------------------------------------------------------
 * Background-capable geolocation tracker that fires an automated, silent
 * check-in when a member's device crosses INTO the gym's configured
 * geofence perimeter.
 *
 * Division of responsibility (anti-spoof):
 *   • Client: reports RAW coordinates only. The local distance check here is
 *     purely for UX (deciding when to bother calling the server); it is never
 *     trusted as proof.
 *   • Server (/attendance/geo-check-in): recomputes the Haversine distance and
 *     enforces the radius. It is the sole authority on "inside".
 *
 * Providers (framework hook for background tracking):
 *   • Default: navigator.geolocation.watchPosition (foreground / PWA).
 *   • Native: a Capacitor background-geolocation plugin can call
 *     GymGeofence.pushPosition({latitude, longitude, accuracy}) to feed fixes
 *     while the app is backgrounded — no other code changes needed.
 * ===================================================================== */
window.GymGeofence = (function () {
  'use strict';

  var cfg = null;          // { enabled, latitude, longitude, radiusMeters }
  var opts = { memberId: null, phone: null, onStatus: null };
  var watchId = null;
  var running = false;
  var lastAttempt = 0;     // throttle server calls
  var THROTTLE_MS = 60000; // at most one check-in attempt per minute

  function emit(status, detail) {
    try { if (opts.onStatus) opts.onStatus(status, detail || {}); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('gf:geofence', { detail: Object.assign({ status: status }, detail || {}) })); } catch (e) {}
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Dedupe: at most one auto check-in per member per calendar day.
  function dayKey() {
    var id = opts.memberId || opts.phone || 'self';
    var d = new Date();
    var day = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    return 'gf_geo_checkin_' + id + '_' + day;
  }
  function alreadyCheckedInToday() {
    try { return localStorage.getItem(dayKey()) === '1'; } catch (e) { return false; }
  }
  function markCheckedIn() {
    try { localStorage.setItem(dayKey(), '1'); } catch (e) {}
  }

  function loadConfig() {
    if (!window.api || !window.api.get) return Promise.resolve(null);
    return window.api.get('/attendance/geofence').then(function (c) { cfg = c; return c; }).catch(function () { return null; });
  }

  // Send raw coords to the server; the server decides "inside" and records it.
  function attemptCheckIn(lat, lon, accuracy) {
    var now = Date.now();
    if (now - lastAttempt < THROTTLE_MS) return;
    lastAttempt = now;

    var body = { latitude: lat, longitude: lon, accuracy: accuracy };
    if (opts.memberId) body.member_id = opts.memberId;
    if (opts.phone) body.phone = opts.phone;

    emit('checking', { latitude: lat, longitude: lon });
    window.api.fetch('/attendance/geo-check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
    }).then(function (res) {
      if (res.ok && res.data && res.data.within) {
        markCheckedIn();
        emit('checked-in', res.data);
        stop(); // job done for today
      } else if (res.status === 422) {
        emit('outside', res.data); // legitimately outside — keep watching
      } else {
        emit('error', res.data || {});
      }
    }).catch(function () { emit('error', {}); });
  }

  // A single position fix from any provider (watchPosition or native bridge).
  function onPosition(pos) {
    if (!running || !cfg || !cfg.enabled) return;
    if (cfg.latitude == null || cfg.longitude == null) return;
    if (alreadyCheckedInToday()) { stop(); return; }

    var lat = pos.latitude != null ? pos.latitude : (pos.coords && pos.coords.latitude);
    var lon = pos.longitude != null ? pos.longitude : (pos.coords && pos.coords.longitude);
    var acc = pos.accuracy != null ? pos.accuracy : (pos.coords && pos.coords.accuracy) || 0;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;

    var dist = haversineMeters(cfg.latitude, cfg.longitude, lat, lon);
    emit('position', { distanceMeters: Math.round(dist), radiusMeters: cfg.radiusMeters, accuracy: acc });

    // Only bother the server when the local estimate says we've likely entered
    // (radius + accuracy slack). The server still makes the real decision.
    if (dist <= (cfg.radiusMeters + Math.min(acc, 50))) {
      attemptCheckIn(lat, lon, acc);
    }
  }

  function startWatch() {
    if (watchId != null) return;
    if (!('geolocation' in navigator)) { emit('unsupported'); return; }
    watchId = navigator.geolocation.watchPosition(
      onPosition,
      function (err) { emit('geo-error', { code: err && err.code, message: err && err.message }); },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
  }
  function stopWatch() {
    if (watchId != null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(watchId); } catch (e) {}
    }
    watchId = null;
  }

  function start() {
    if (running) return Promise.resolve();
    running = true;
    return loadConfig().then(function (c) {
      if (!c || !c.enabled) { running = false; emit('disabled'); return; }
      if (c.latitude == null || c.longitude == null) { running = false; emit('unconfigured'); return; }
      if (alreadyCheckedInToday()) { running = false; emit('already-checked-in'); return; }
      emit('started', { radiusMeters: c.radiusMeters });
      startWatch();
    });
  }

  function stop() {
    running = false;
    stopWatch();
    emit('stopped');
  }

  return {
    configure: function (o) { opts = Object.assign(opts, o || {}); return this; },
    start: start,
    stop: stop,
    isRunning: function () { return running; },
    getConfig: function () { return cfg; },
    // Native background provider hook.
    pushPosition: function (p) { onPosition(p || {}); },
    // Utility exposed for UIs (e.g. the admin "test my location" button).
    haversineMeters: haversineMeters,
    reloadConfig: loadConfig
  };
})();
