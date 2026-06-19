// Centralized Utilities for JSB Fitness
// Phase 1: Launch Stabilization

// [C5] Global XSS-safe output helpers. ANY user-controlled value (member name,
// phone, notes, lead name, staff name, plan name, etc.) that is interpolated into
// innerHTML MUST be wrapped in esc(); image/link URLs from data MUST go through
// safeUrl(). Exposed as window.esc / window.safeUrl so every screen shares one
// audited implementation.
window.esc = function (s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};
window.safeUrl = function (u) {
    const s = String(u ?? '').trim();
    if (!s) return '';
    // Allow same-origin relative paths and data:image/ (base64 photos), block
    // javascript:, data:text/html, and other script-bearing schemes.
    if (s.startsWith('/') || /^data:image\//i.test(s)) return window.esc(s);
    try {
        const x = new URL(s, window.location.origin);
        return ['http:', 'https:'].includes(x.protocol) ? window.esc(x.href) : '';
    } catch (e) { return ''; }
};
// Back-compat alias for screens that referenced escapeHtml.
window.escapeHtml = window.esc;

window.utils = {
    /**
     * Format a number as currency (INR)
     * @param {number} amount - The amount to format
     * @returns {string} Formatted currency string
     */
    safeNumber: function(val, fallback = '0') {
        if (val === undefined || val === null || Number.isNaN(Number(val))) return fallback;
        return Number(val).toLocaleString('en-IN');
    },

    formatCurrency: function(amount) {
        if (amount === undefined || amount === null || Number.isNaN(Number(amount))) return '₹0';
        if (amount === undefined || amount === null) return '₹0';
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(amount);
    },

    /**
     * Format a date string into a standard readable format
     * @param {string|Date} dateString - The date to format
     * @returns {string} Formatted date (e.g., Nov 24, 2024)
     */
    formatDate: function(dateString) {
        if (!dateString) return 'N/A';
        const date = new Date(dateString);
        return new Intl.DateTimeFormat('en-IN', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        }).format(date);
    },

    /**
     * Get initials from a full name (used for avatars)
     * @param {string} name - The full name
     * @returns {string} Up to 2 initials
     */
    getInitials: function(name) {
        if (!name) return '?';
        // Trim + collapse whitespace and drop empty tokens so names like "John ",
        // "  Mary  Jane " or "   " don't yield undefined initials / blank avatars.
        const parts = String(name).trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) return '?';
        return parts
            .map(n => n[0])
            .join('')
            .toUpperCase()
            .substring(0, 2);
    },

    /**
     * Determine risk level color class based on member attendance/engagement
     * @param {string} level - 'High', 'Medium', 'Low'
     * @returns {string} Tailwind text color class
     */
    getRiskColorClass: function(level) {
        switch((level || '').toLowerCase()) {
            case 'high': return 'text-error';
            case 'medium': return 'text-tertiary';
            case 'low': return 'text-primary';
            default: return 'text-on-surface-variant';
        }
    }
};

// ─── TOASTS ────────────────────────────────────────────────────────────────
// Production notification system. Replaces native alert() everywhere: toasts are
// non-blocking, stacked, auto-dismissing, color-coded, and screen-reader friendly.
// New code should call window.toast(msg, type). Legacy alert() calls are routed
// through here automatically (see the shim at the bottom of this block).
(function () {
    var TOAST_ICONS = { success: 'check_circle', error: 'error', warning: 'warning', info: 'info' };

    function ensureContainer() {
        var el = document.getElementById('jsb-toast-container');
        if (!el) {
            el = document.createElement('div');
            el.id = 'jsb-toast-container';
            el.className = 'jsb-toast-container';
            el.setAttribute('aria-live', 'polite');
            el.setAttribute('aria-atomic', 'false');
            (document.body || document.documentElement).appendChild(el);
        }
        return el;
    }

    function dismiss(node) {
        if (!node || node.dataset.dismissed) return;
        node.dataset.dismissed = '1';
        node.classList.remove('show');
        node.classList.add('hide');
        setTimeout(function () { node.remove(); }, 260);
    }

    window.toast = function (message, type, opts) {
        opts = opts || {};
        type = TOAST_ICONS[type] ? type : 'info';
        var container = ensureContainer();
        var node = document.createElement('div');
        node.className = 'jsb-toast jsb-toast--' + type;
        node.setAttribute('role', type === 'error' ? 'alert' : 'status');
        node.innerHTML =
            '<span class="material-symbols-outlined jsb-toast__icon" style="font-variation-settings:\'FILL\' 1;">' + TOAST_ICONS[type] + '</span>' +
            '<span class="jsb-toast__msg"></span>';
        node.querySelector('.jsb-toast__msg').textContent = String(message == null ? '' : message);
        node.addEventListener('click', function () { dismiss(node); });
        container.appendChild(node);
        // next frame -> trigger enter transition
        requestAnimationFrame(function () { requestAnimationFrame(function () { node.classList.add('show'); }); });
        var ttl = opts.duration != null ? opts.duration : (type === 'error' ? 5500 : 3800);
        if (ttl > 0) setTimeout(function () { dismiss(node); }, ttl);
        return node;
    };

    // Promise-based replacement for window.confirm(). Returns true/false.
    window.confirmDialog = function (message, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'jsb-modal-overlay';
            var danger = !!opts.danger;
            overlay.innerHTML =
                '<div class="jsb-modal" role="dialog" aria-modal="true">' +
                    (opts.title ? '<h3 class="text-title-lg font-bold text-on-surface mb-2"></h3>' : '') +
                    '<p class="text-body-md text-on-surface-variant mb-6" style="line-height:1.5"></p>' +
                    '<div class="flex justify-end gap-3">' +
                        '<button type="button" data-act="cancel" class="px-4 py-2 rounded-lg text-body-md font-medium text-on-surface-variant hover:bg-white/5 transition-colors">' + (opts.cancelText || 'Cancel') + '</button>' +
                        '<button type="button" data-act="ok" class="px-4 py-2 rounded-lg text-body-md font-semibold transition-colors ' +
                            (danger ? 'bg-error/90 text-on-error hover:bg-error' : 'bg-primary text-on-primary hover:opacity-90') + '">' + (opts.confirmText || 'Confirm') + '</button>' +
                    '</div>' +
                '</div>';
            if (opts.title) overlay.querySelector('h3').textContent = opts.title;
            overlay.querySelector('p').textContent = String(message == null ? '' : message);
            (document.body || document.documentElement).appendChild(overlay);
            requestAnimationFrame(function () { requestAnimationFrame(function () { overlay.classList.add('show'); }); });

            function close(result) {
                overlay.classList.remove('show');
                setTimeout(function () { overlay.remove(); }, 200);
                document.removeEventListener('keydown', onKey);
                resolve(result);
            }
            function onKey(e) { if (e.key === 'Escape') close(false); if (e.key === 'Enter') close(true); }
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) return close(false);
                var act = e.target.closest('[data-act]');
                if (act) close(act.getAttribute('data-act') === 'ok');
            });
            document.addEventListener('keydown', onKey);
            var okBtn = overlay.querySelector('[data-act="ok"]');
            if (okBtn) okBtn.focus();
        });
    };

    // ─── LEGACY alert() UPGRADE ──────────────────────────────────────────────
    // 100+ existing screens call alert() for terminal status messages (mostly
    // errors after an awaited request). Re-pointing alert() at toast() upgrades
    // them all at once without touching each call site. The original blocking
    // dialog is preserved as window.nativeAlert in case anything truly needs it.
    window.nativeAlert = window.alert.bind(window);
    window.alert = function (message) {
        var msg = String(message == null ? '' : message);
        var t = 'error';
        if (/\b(success|successful|successfully|updated|saved|added|created|sent|upgraded|complete[d]?|approved|enabled|copied)\b/i.test(msg) &&
            !/\b(fail|failed|error|unable|could ?n.?t|cannot|can.?t|invalid|denied|offline)\b/i.test(msg)) {
            t = 'success';
        } else if (/\b(note|please|reminder|info)\b/i.test(msg) && !/\b(fail|error|invalid)\b/i.test(msg)) {
            t = 'info';
        }
        window.toast(msg, t);
    };
})();

// SaaS Hydration
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await window.fetch('/api/v1/settings/public');
        if (res.ok) {
            const settings = await res.json();
            const gymName = settings.gym_name || 'Kinetic Enterprise';
            const supportPhone = settings.support_phone || '';
            const supportEmail = settings.support_email || '';
            const gymAddress = settings.address || '';
            const themeColor = settings.theme_color || '#16c8ee';
            
            // Override window.APP_CONFIG.brand
            if (window.APP_CONFIG && window.APP_CONFIG.brand) {
                window.APP_CONFIG.brand.name = gymName;
                if (settings.logo_url) window.APP_CONFIG.brand.logo_url = settings.logo_url;
            }

            // Set custom theme color CSS variables dynamically
            if (settings.theme_color) {
                document.documentElement.style.setProperty('--color-primary', themeColor);
                
                // Calculate contrast text color (black or white)
                const getContrastColor = (hex) => {
                    if (!hex) return '#041012';
                    hex = hex.replace('#', '');
                    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
                    const r = parseInt(hex.substring(0, 2), 16);
                    const g = parseInt(hex.substring(2, 4), 16);
                    const b = parseInt(hex.substring(4, 6), 16);
                    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
                    return (yiq >= 128) ? '#041012' : '#ffffff';
                };
                
                // Calculate primary container color (dark version)
                const getContainerColor = (hex) => {
                    if (!hex) return '#0a3d4a';
                    return hex + '25'; // Adds transparency
                };

                document.documentElement.style.setProperty('--color-on-primary', getContrastColor(themeColor));
                document.documentElement.style.setProperty('--color-primary-container', getContainerColor(themeColor));
            }

            // Update title safely
            if (document.title.includes(window.APP_CONFIG?.brand?.name || 'Gym Flow')) {
                document.title = document.title.replace(window.APP_CONFIG?.brand?.name || 'Gym Flow', gymName);
            }
            
            // Update DOM Elements immediately
            document.querySelectorAll('.logo-text').forEach(el => el.innerText = gymName);
            document.querySelectorAll('.dynamic-gym-name').forEach(el => el.innerText = gymName);
            document.querySelectorAll('.dynamic-support-phone').forEach(el => el.innerText = supportPhone);
            document.querySelectorAll('.dynamic-support-email').forEach(el => el.innerText = supportEmail);
            document.querySelectorAll('.dynamic-gym-address').forEach(el => el.innerText = gymAddress);

            // Update custom logo image if logo_url is present
            if (settings.logo_url) {
                // In login/signup/general pages
                document.querySelectorAll('.dynamic-logo').forEach(el => {
                    el.outerHTML = `<img src="${settings.logo_url}" class="h-12 w-12 object-contain rounded-lg shrink-0" onerror="this.outerHTML='<span class=\'material-symbols-outlined text-4xl text-primary\'>hexagon</span>'">`;
                });
                
                // In sidebar
                const sidebarLogo = document.querySelector('.desktop-sidebar .logo-container span.material-symbols-outlined');
                if (sidebarLogo) {
                    sidebarLogo.outerHTML = `<img src="${settings.logo_url}" class="h-8 w-8 object-contain rounded shrink-0 mr-1" onerror="this.outerHTML='<span class=\'material-symbols-outlined text-primary text-[28px]\'>${window.APP_CONFIG?.brand?.icon || 'fitness_center'}</span>'">`;
                }

                // Mobile header logo hydration is disabled to preserve hardcoded Gym Flow logo
            }
            // Specialized element overrides
            document.querySelectorAll('h1, h2, p, span, div').forEach(el => {
                if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
                    if (el.innerText.includes(window.APP_CONFIG?.brand?.name || 'Gym Flow')) {
                        el.innerText = el.innerText.replace(window.APP_CONFIG?.brand?.name || 'Gym Flow', gymName);
                    }
                }
            });

            // NOTE: The full-screen premium "lock" overlay that covered /marketing,
            // /lead-crm and /bi for trial/basic plans was removed — it blocked
            // navigation and read as "Analytics/Marketing redirect to Settings".
            // These screens now render their real content for every plan. Any future
            // upsell should be a non-blocking banner, not a full-page interceptor.
        }
    } catch(e) {
        console.error('Failed to load SaaS settings', e);
    }
});

// ─── App shell loader ────────────────────────────────────────────────────
// The subscription status badge (Feature 1) and the guided product tour
// (Features 3–5) live in a dedicated module so this file stays focused on
// utilities. Loaded once, on every authenticated screen that includes utils.js.
(function () {
    if (window.__gymAppShellInjected) return;
    window.__gymAppShellInjected = true;
    var s = document.createElement('script');
    s.src = '/assets/js/appShell.js';
    s.defer = true;
    (document.head || document.documentElement).appendChild(s);
})();
