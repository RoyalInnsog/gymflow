// ============================================================================
// Gym Flow — Offline layer :: netTransport.js
// The real network client. This is the ONLY thing that talks HTTP to the server.
// It preserves — byte-for-byte — the behavior of the original ApiService.fetch:
//   • credentials:'include' so the httpOnly auth cookie rides every request
//     (critical inside the Capacitor WebView),
//   • JSON content-type default,
//   • transparent 401 -> /auth/refresh -> replay ONCE (short-lived access tokens).
// The offline facade sits ABOVE this; the sync engine and outbox call into it.
// ============================================================================
(function () {
  'use strict';

  var BASE_URL = '/api/v1';

  // Hard ceiling for any single HTTP round-trip. This is the fix for the
  // "infinite spinner" defect: a native fetch() has NO built-in timeout, so a
  // stalled connection (flaky mobile data, a dozing free-tier server, a
  // half-open socket in the Android WebView) leaves its promise pending
  // forever. The awaiting loader never returns, its try/catch never fires, and
  // the page's skeleton loaders spin indefinitely. A deadline converts that
  // "hang forever" into an ordinary rejection that every existing catch already
  // knows how to handle (surface an error / fall back to cached data).
  // Generous enough for large base64 photo uploads; override per call with
  // options.timeout.
  var DEFAULT_TIMEOUT_MS = 30000;

  function fullUrl(endpoint) {
    return endpoint.indexOf('http') === 0 ? endpoint : (BASE_URL + endpoint);
  }

  // fetch() with a guaranteed settlement deadline. When the timer fires we
  // ABORT the in-flight request (releasing the socket) rather than merely
  // abandoning it, then reject with a legible, catchable TimeoutError.
  function timedFetch(url, options) {
    options = Object.assign({}, options || {});
    var ms = (typeof options.timeout === 'number' && options.timeout > 0) ? options.timeout : DEFAULT_TIMEOUT_MS;
    delete options.timeout; // private key — never forward it to native fetch

    function timeoutError() {
      var e = new Error('Request timed out after ' + ms + 'ms: ' + url);
      e.name = 'TimeoutError';
      e.timeout = true;
      return e;
    }

    if (typeof self.AbortController === 'function') {
      var controller = new self.AbortController();
      // Respect a caller-supplied signal: abort ours if theirs fires.
      if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', function () { controller.abort(); });
      }
      options.signal = controller.signal;
      var timer = setTimeout(function () { controller.abort(); }, ms);
      return self.fetch(url, options).then(function (res) {
        clearTimeout(timer);
        return res;
      }, function (err) {
        clearTimeout(timer);
        if (err && (err.name === 'AbortError' || controller.signal.aborted)) throw timeoutError();
        throw err;
      });
    }

    // Legacy WebView without AbortController: we can't cancel the socket, but we
    // can still unblock the UI by rejecting the awaited promise on deadline.
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () { if (!settled) { settled = true; reject(timeoutError()); } }, ms);
      self.fetch(url, options).then(function (res) {
        if (settled) return; settled = true; clearTimeout(timer); resolve(res);
      }, function (err) {
        if (settled) return; settled = true; clearTimeout(timer); reject(err);
      });
    });
  }

  // Returns the raw Response (never parsed). Throws only on genuine network
  // failure (offline / DNS / connection reset / timeout) — exactly like the old
  // client, so callers' existing try/catch and `.ok` checks keep working
  // unchanged.
  function rawFetch(endpoint, options, _retried) {
    options = options || {};
    var fetchOptions = Object.assign({ credentials: 'include' }, options, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {})
    });

    var isAuthFlow = endpoint.indexOf('/auth/refresh') !== -1 ||
                     endpoint.indexOf('/auth/login') !== -1 ||
                     endpoint.indexOf('/auth/logout') !== -1;

    return timedFetch(fullUrl(endpoint), fetchOptions).then(function (response) {
      if (response.status === 401 && !_retried && !isAuthFlow) {
        return timedFetch(BASE_URL + '/auth/refresh', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }
        }).then(function (refreshed) {
          if (refreshed.ok) return rawFetch(endpoint, options, true);
          return response;
        });
      }
      return response;
    });
  }

  self.GymNetTransport = {
    BASE_URL: BASE_URL,
    fetch: rawFetch
  };
})();
