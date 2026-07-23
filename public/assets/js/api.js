// Centralized API Wrapper for JSB Fitness
// Phase 1: Launch Stabilization

class ApiService {
    constructor() {
        // [CAPACITOR] In the bundled APK the pages are served from the local
        // WebView origin (https://localhost) while the API lives on the remote
        // backend. capacitor-env.js (injected at build time, absent on the web)
        // sets window.API_BASE_URL so every call is rebased onto that origin.
        this.baseUrl = (window.API_BASE_URL || '') + '/api/v1';
        // Potential future addition: Cache store
        this.cache = new Map();
    }

    async fetch(endpoint, options = {}, _retried = false) {
        const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

        // `timeout` is a private option (ms) — pull it out so it never leaks into
        // the native fetch init.
        const { timeout, ...rest } = options;

        // Default options.
        // credentials:'include' guarantees the httpOnly `auth_token` cookie rides
        // with EVERY API call. On the web it's same-origin (harmless); inside the
        // Capacitor Android WebView the browser default does not reliably attach the
        // cookie, which left the app unauthenticated → subscription/plan data missing
        // → feature gating defaulted wrong. This makes session restoration identical
        // on desktop and in the app.
        // [CAPACITOR] In bundled APK mode the WebView origin is cross-origin to the
        // API backend, so httpOnly cookies are not sent. We use the Authorization
        // header with a token retrieved from Capacitor Secure Storage (not global window).
        let authToken = undefined;
        if (window.__NATIVE_SHELL__ && window.Capacitor) {
            // Retrieve token from Capacitor Secure Storage for native apps
            try {
                const { SecureStoragePlugin } = window.Capacitor.Plugins;
                if (SecureStoragePlugin) {
                    const result = await SecureStoragePlugin.get({ key: 'auth_token' });
                    authToken = result?.value;
                }
            } catch (e) {
                // Fallback to window.__AUTH_TOKEN__ if plugin not available (dev mode)
                authToken = window.__AUTH_TOKEN__;
            }
        } else {
            // Web: httpOnly cookie is sent automatically via credentials: 'include'
            // No need for Authorization header on web
        }

        const fetchOptions = {
            credentials: 'include',
            ...rest,
            headers: {
                'Content-Type': 'application/json',
                ...(authToken ? { 'Authorization': 'Bearer ' + authToken } : {}),
                ...options.headers
            }
        };

        // Timeout guard: a native fetch() never times out on its own, so a stalled
        // connection leaves this await pending forever — which is exactly what
        // freezes the dashboard's skeleton loaders. Abort past the deadline so the
        // promise ALWAYS settles and the caller's catch can run. 30s is generous
        // enough for large base64 photo uploads; override per call with
        // options.timeout.
        const timeoutMs = (typeof timeout === 'number' && timeout > 0) ? timeout : 30000;
        const controller = (typeof AbortController === 'function') ? new AbortController() : null;
        let timer = null;
        if (controller) {
            fetchOptions.signal = controller.signal;
            timer = setTimeout(() => controller.abort(), timeoutMs);
        }

        try {
            const response = await window.fetch(url, fetchOptions);

            // [IDENTITY] Access tokens are short-lived (1h) and rotated via the
            // httpOnly refresh cookie. A 401 on a page left open past the access TTL
            // means "expired", not "logged out": transparently refresh ONCE and
            // replay the original request, so the user never sees a spurious logout.
            // Skipped for the auth endpoints themselves (a 401 there is a real
            // credential/refresh failure, not an expiry to paper over).
            const isAuthFlow = endpoint.includes('/auth/refresh') || endpoint.includes('/auth/login') || endpoint.includes('/auth/logout');
            if (response.status === 401 && !_retried && !isAuthFlow) {
                const refreshed = await window.fetch(`${this.baseUrl}/auth/refresh`, {
                    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                    // Share the outer deadline so a hung refresh can't stall the replay.
                    ...(controller ? { signal: controller.signal } : {})
                });
                if (refreshed.ok) {
                    return this.fetch(endpoint, options, true);
                }
            }

            // [CAPACITOR] Bundled pages have no server-side page gate (the web
            // app redirects dead sessions to /login at the route level). When a
            // 401 survives the refresh replay above, hand off to the LOCAL login
            // page. Web behavior unchanged (__NATIVE_SHELL__ is never set there).
            if (response.status === 401 && !isAuthFlow && window.__NATIVE_SHELL__
                && !['/', '/login', '/login-alt', '/signup', '/forgot-password', '/reset-password', '/verify-email'].includes(location.pathname)) {
                location.replace('/login');
            }

            return response;
        } catch (error) {
            // Normalize an abort (timeout) into a legible, catchable error so
            // callers can distinguish "took too long" from a hard network drop.
            if (error && error.name === 'AbortError') {
                const e = new Error(`Request timed out after ${timeoutMs}ms: ${endpoint}`);
                e.name = 'TimeoutError';
                e.timeout = true;
                console.error(`[API Timeout] ${endpoint} (${timeoutMs}ms)`);
                throw e;
            }
            console.error(`[API Error] ${endpoint}:`, error);
            throw error;
        } finally {
            // Whatever the outcome — 2xx, 4xx, 5xx, network error or timeout —
            // release the deadline timer so it can't abort a later replayed call.
            if (timer) clearTimeout(timer);
        }
    }

    // [DATA-FLOW FIX] Convenience methods return PARSED JSON (their intended contract).
    // Previously they returned the raw Response, so callers that did
    // `const data = await api.get(...)` got a Response object — e.g. the Settings page
    // read `settings.gym_name` / `plans.forEach` off a Response, which silently failed
    // to hydrate forms and threw "forEach is not a function". Use `api.fetch()` when you
    // need the raw Response; use get/post/put/delete when you want the data.
    async _json(response) {
        try {
            return await response.json();
        } catch (e) {
            return null;
        }
    }

    async get(endpoint, options = {}) {
        return this._json(await this.fetch(endpoint, { ...options, method: 'GET' }));
    }

    async post(endpoint, data, options = {}) {
        return this._json(await this.fetch(endpoint, {
            ...options,
            method: 'POST',
            body: JSON.stringify(data)
        }));
    }

    async put(endpoint, data, options = {}) {
        return this._json(await this.fetch(endpoint, {
            ...options,
            method: 'PUT',
            body: JSON.stringify(data)
        }));
    }

    async delete(endpoint, options = {}) {
        return this._json(await this.fetch(endpoint, { ...options, method: 'DELETE' }));
    }
}

// Export a single instance to be used globally
window.api = new ApiService();
