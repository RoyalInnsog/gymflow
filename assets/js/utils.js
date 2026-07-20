// Centralized Utilities for JSB Fitness
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
                '<div class="jsb-modal" role="dialog" aria-modal="true" style="text-align: left;">' +
                    (opts.title ? '<h3 class="text-title-lg font-bold text-on-surface mb-2" style="margin-top: 0; margin-bottom: 8px;"></h3>' : '') +
                    '<p class="text-body-md text-on-surface-variant" style="line-height:1.5; margin-bottom: 24px; color: var(--color-on-surface-variant, #9a9a9a);"></p>' +
                    '<div style="display: flex; justify-content: flex-end; gap: 12px;">' +
                        '<button type="button" data-act="cancel" class="px-4 py-2 rounded-lg text-body-md font-medium transition-colors" style="background: transparent; border: none; color: var(--color-on-surface-variant, #9a9a9a); cursor: pointer; outline: none;">' + (opts.cancelText || 'Cancel') + '</button>' +
                        '<button type="button" data-act="ok" class="px-4 py-2 rounded-lg text-body-md font-semibold transition-colors hover:opacity-90" style="' +
                            (danger ? 'background-color: var(--color-error, #bf2600) !important; color: var(--color-on-error, #ffffff) !important;' : 'background-color: var(--color-primary, #16c8ee) !important; color: var(--color-on-primary, #ffffff) !important;') + ' border: none; cursor: pointer; outline: none;">' + (opts.confirmText || 'Confirm') + '</button>' +
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

    // Promise-based replacement for window.prompt(). Resolves to the trimmed
    // string, or null if cancelled. Styled to match confirmDialog so the app
    // never falls back to the jarring native prompt on a premium dark UI.
    // opts: { title, placeholder, defaultValue, confirmText, cancelText,
    //         multiline, inputType, required }
    window.promptDialog = function (message, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'jsb-modal-overlay';
            var multiline = !!opts.multiline;
            var control = multiline
                ? '<textarea data-field rows="3" class="w-full bg-surface-container-lowest border border-outline-variant/40 rounded-lg px-3 py-2.5 text-body-md text-on-surface placeholder:text-on-surface-variant/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40 transition-colors resize-none" style="min-height:80px"></textarea>'
                : '<input data-field type="' + (opts.inputType || 'text') + '" class="w-full bg-surface-container-lowest border border-outline-variant/40 rounded-lg px-3 py-2.5 text-body-md text-on-surface placeholder:text-on-surface-variant/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40 transition-colors">';
            overlay.innerHTML =
                '<div class="jsb-modal" role="dialog" aria-modal="true">' +
                    (opts.title ? '<h3 class="text-title-lg font-bold text-on-surface mb-2"></h3>' : '') +
                    (message ? '<p class="text-body-md text-on-surface-variant mb-4" style="line-height:1.5"></p>' : '') +
                    control +
                    '<div class="flex justify-end gap-3 mt-6">' +
                        '<button type="button" data-act="cancel" class="px-4 py-2 rounded-lg text-body-md font-medium text-on-surface-variant hover:bg-white/5 transition-colors">' + (opts.cancelText || 'Cancel') + '</button>' +
                        '<button type="button" data-act="ok" class="px-4 py-2 rounded-lg text-body-md font-semibold bg-primary text-on-primary hover:opacity-90 transition-colors">' + (opts.confirmText || 'Confirm') + '</button>' +
                    '</div>' +
                '</div>';
            if (opts.title) overlay.querySelector('h3').textContent = String(opts.title);
            if (message) overlay.querySelector('p').textContent = String(message);
            var field = overlay.querySelector('[data-field]');
            if (opts.placeholder) field.setAttribute('placeholder', String(opts.placeholder));
            if (opts.defaultValue != null) field.value = String(opts.defaultValue);
            (document.body || document.documentElement).appendChild(overlay);
            requestAnimationFrame(function () { requestAnimationFrame(function () { overlay.classList.add('show'); }); });
            setTimeout(function () { field.focus(); field.select && field.select(); }, 60);

            function close(result) {
                overlay.classList.remove('show');
                setTimeout(function () { overlay.remove(); }, 200);
                document.removeEventListener('keydown', onKey);
                resolve(result);
            }
            function submit() {
                var val = String(field.value == null ? '' : field.value).trim();
                if (opts.required && !val) {
                    field.classList.add('input-invalid');
                    field.focus();
                    return;
                }
                close(val);
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); close(null); }
                // Enter submits single-line; textarea keeps Enter for newlines (Ctrl/⌘+Enter submits).
                else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
            }
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) return close(null);
                var act = e.target.closest('[data-act]');
                if (act) { act.getAttribute('data-act') === 'ok' ? submit() : close(null); }
            });
            field.addEventListener('input', function () { field.classList.remove('input-invalid'); });
            document.addEventListener('keydown', onKey);
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
    const publicPaths = ['/login', '/login-alt', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/verify-phone', '/select-role', '/member-coming-soon'];
    if (publicPaths.includes(window.location.pathname)) {
        document.querySelectorAll('.dynamic-gym-name').forEach(el => el.innerText = 'GYM FLOW');
        return;
    }
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
            // Specialized element overrides.
            // Perf: skipped entirely when the tenant name equals the default brand
            // (nothing would change), and uses textContent — innerText forces a
            // synchronous layout per element, which thrashed startup on big pages.
            const defaultBrand = window.APP_CONFIG?.brand?.name || 'Gym Flow';
            if (gymName !== defaultBrand) {
                document.querySelectorAll('h1, h2, p, span, div').forEach(el => {
                    if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
                        const txt = el.childNodes[0].nodeValue;
                        if (txt && txt.includes(defaultBrand)) {
                            el.childNodes[0].nodeValue = txt.replace(defaultBrand, gymName);
                        }
                    }
                });
            }

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
    const publicPaths = ['/login', '/login-alt', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/verify-phone', '/select-role', '/member-coming-soon'];
    if (publicPaths.includes(window.location.pathname)) return;

    if (window.__gymAppShellInjected) return;
    window.__gymAppShellInjected = true;
    // async=false preserves execution order for dynamically-injected scripts
    // (defer does not) — the membership engine must evaluate before appShell
    // so the badge/tour can rely on window.MembershipEngine.
    var head = document.head || document.documentElement;
    // Pages that compute dates inline include the engine via a static <script>
    // tag (deterministic ordering); only inject it here when they didn't.
    if (!window.MembershipEngine) {
        var eng = document.createElement('script');
        eng.src = '/assets/js/membershipEngine.js';
        eng.async = false;
        head.appendChild(eng);
    }
    var s = document.createElement('script');
    s.src = '/assets/js/appShell.js';
    s.async = false;
    head.appendChild(s);
})();

// ─── FORM ENHANCEMENT ENGINE ──────────────────────────────────────────
// Automatically enhances validation presentation, input states, phone formats,
// password strength/Caps Lock indicators, double-submit prevention, and accessibility.
(function () {
    'use strict';

    function initFormEnhancements() {
        enhanceAllForms();
        enhancePhoneFields();
        enhancePasswordFields();
    }

    function findLabelFor(input) {
        if (input.id) {
            const label = document.querySelector(`label[for="${input.id}"]`);
            if (label) return label;
        }
        let parent = input.parentElement;
        while (parent) {
            if (parent.tagName === 'LABEL') return parent;
            if (parent.tagName === 'FORM') break;
            parent = parent.parentElement;
        }
        return null;
    }

    function addCharacterCounter(input) {
        const maxlen = parseInt(input.getAttribute('maxlength'));
        let counterEl = document.createElement('div');
        counterEl.className = 'text-on-surface-variant/60 text-xs mt-1 text-right form-char-counter';
        counterEl.textContent = `${input.value.length}/${maxlen}`;
        
        let target = input;
        if (input.parentElement && input.parentElement.classList.contains('relative')) {
            target = input.parentElement;
        }
        target.insertAdjacentElement('afterend', counterEl);

        input.addEventListener('input', () => {
            counterEl.textContent = `${input.value.length}/${maxlen}`;
        });
    }

    function showInputValidationState(input, isValid, errorMessage) {
        let errorEl = document.getElementById(`error-${input.id || input.name}`);
        if (!errorEl && !isValid) {
            errorEl = document.createElement('div');
            errorEl.id = `error-${input.id || input.name}`;
            errorEl.className = 'text-error text-body-sm mt-1 flex items-center gap-1 font-medium form-error-msg';
            let container = input;
            if (input.parentElement && input.parentElement.classList.contains('relative')) {
                container = input.parentElement;
            }
            container.insertAdjacentElement('afterend', errorEl);
        }

        if (isValid) {
            if (errorEl) errorEl.remove();
            input.classList.remove('border-error', 'ring-error', 'ring-1', 'focus:border-error', 'focus:ring-error');
            if (input.value.trim() !== '') {
                input.classList.add('border-secondary');
                input.classList.remove('border-outline-variant/40');
            } else {
                input.classList.remove('border-secondary');
                input.classList.add('border-outline-variant/40');
            }
            input.setAttribute('aria-invalid', 'false');
            input.removeAttribute('aria-describedby');
        } else {
            input.classList.remove('border-secondary', 'border-outline-variant/40');
            input.classList.add('border-error');
            input.setAttribute('aria-invalid', 'true');
            input.setAttribute('aria-describedby', errorEl.id);
            errorEl.innerHTML = `<span class="material-symbols-outlined text-[16px] align-middle">error</span> <span class="align-middle">${errorMessage}</span>`;
        }
    }

    function validateInput(input) {
        if (input.type === 'hidden' || input.disabled || input.readOnly) return true;

        let isValid = true;
        let errorMessage = '';
        const value = input.value.trim();

        if (input.hasAttribute('required') && value === '') {
            isValid = false;
            errorMessage = 'This field is required.';
        } else if (isValid && input.type === 'email' && value !== '') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(value)) {
                isValid = false;
                errorMessage = 'Please enter a valid email address.';
            }
        } else if (isValid && input.hasAttribute('minlength')) {
            const minlen = parseInt(input.getAttribute('minlength'));
            if (value.length < minlen && value !== '') {
                isValid = false;
                errorMessage = `Must be at least ${minlen} characters.`;
            }
        } else if (isValid && input.id === 'confirm_password') {
            const mainPassword = document.getElementById('password');
            if (mainPassword && value !== mainPassword.value.trim()) {
                isValid = false;
                errorMessage = 'Passwords do not match.';
            }
        }

        showInputValidationState(input, isValid, errorMessage);
        return isValid;
    }

    function enhanceAllForms() {
        const forms = document.querySelectorAll('form');
        forms.forEach(form => {
            form.addEventListener('submit', (e) => {
                const inputs = form.querySelectorAll('input, textarea, select');
                let firstInvalid = null;
                let isValid = true;

                inputs.forEach(input => {
                    if (input.type !== 'password' && input.type !== 'file' && typeof input.value === 'string') {
                        input.value = input.value.trim();
                    }
                    if (!validateInput(input)) {
                        isValid = false;
                        if (!firstInvalid) firstInvalid = input;
                    }
                });

                if (!isValid) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (firstInvalid) {
                        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        firstInvalid.focus();
                    }
                    return false;
                }

                const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.classList.add('btn-loading');
                }
            }, true);

            const inputs = form.querySelectorAll('input, select, textarea');
            inputs.forEach(input => {
                if (input.hasAttribute('required')) {
                    let label = findLabelFor(input);
                    if (label && !label.querySelector('.required-asterisk')) {
                        const asterisk = document.createElement('span');
                        asterisk.className = 'text-error required-asterisk ml-0.5';
                        asterisk.ariaHidden = 'true';
                        asterisk.textContent = '*';
                        label.appendChild(asterisk);
                    }
                }

                if (input.hasAttribute('maxlength')) {
                    addCharacterCounter(input);
                }

                let hasBlurred = false;
                input.addEventListener('blur', () => {
                    if (input.type !== 'password' && input.type !== 'file' && typeof input.value === 'string') {
                        input.value = input.value.trim();
                    }
                    hasBlurred = true;
                    validateInput(input);
                });

                input.addEventListener('input', () => {
                    if (hasBlurred) {
                        validateInput(input);
                    }
                });

                if (!input.hasAttribute('autocomplete')) {
                    if (input.type === 'email') input.setAttribute('autocomplete', 'email');
                    else if (input.type === 'password') {
                        if (input.id === 'confirm_password') input.setAttribute('autocomplete', 'new-password');
                        else if (window.location.pathname.includes('/signup')) input.setAttribute('autocomplete', 'new-password');
                        else input.setAttribute('autocomplete', 'current-password');
                    }
                    else if (input.name === 'phone' || input.type === 'tel') input.setAttribute('autocomplete', 'tel');
                    else if (input.name === 'username' || input.name === 'email') input.setAttribute('autocomplete', 'username');
                }
            });
        });
    }

    function enhancePhoneFields() {
        const phoneFields = document.querySelectorAll('input[type="tel"], input[name*="phone"], input[id*="phone"]');
        phoneFields.forEach(field => {
            field.addEventListener('input', () => {
                let selectionStart = field.selectionStart;
                let originalLen = field.value.length;
                let digits = field.value.replace(/\D/g, '');
                let formatted = '';

                if (digits.startsWith('91') && digits.length > 10) {
                     formatted = '+91 ';
                     let rest = digits.substring(2, 12);
                     if (rest.length > 5) {
                          formatted += rest.slice(0, 5) + ' ' + rest.slice(5);
                     } else {
                          formatted += rest;
                     }
                } else {
                     let rest = digits.slice(0, 10);
                     if (rest.length > 5) {
                          formatted = rest.slice(0, 5) + ' ' + rest.slice(5);
                     } else {
                          formatted = rest;
                     }
                }

                field.value = formatted;
                let diff = formatted.length - originalLen;
                field.setSelectionRange(selectionStart + diff, selectionStart + diff);
            });
        });
    }

    function enhancePasswordFields() {
        const passwordFields = document.querySelectorAll('input[type="password"]');
        passwordFields.forEach(field => {
            let parent = field.parentElement;
            if (parent && parent.classList.contains('relative')) {
                let toggleBtn = parent.querySelector('button');
                if (!toggleBtn) {
                    toggleBtn = document.createElement('button');
                    toggleBtn.type = 'button';
                    toggleBtn.className = 'absolute right-4 text-on-surface-variant/70 hover:text-on-surface transition-colors focus:outline-none flex items-center justify-center';
                    toggleBtn.innerHTML = '<span class="material-symbols-outlined text-[20px]">visibility</span>';
                    parent.appendChild(toggleBtn);
                    field.style.paddingRight = '3rem';
                }

                toggleBtn.removeAttribute('onclick');
                toggleBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const isPassword = field.type === 'password';
                    field.type = isPassword ? 'text' : 'password';
                    toggleBtn.innerHTML = `<span class="material-symbols-outlined text-[20px]">${isPassword ? 'visibility_off' : 'visibility'}</span>`;
                    toggleBtn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
                });
                toggleBtn.setAttribute('aria-label', 'Show password');
            }

            let capswarn = document.createElement('div');
            capswarn.className = 'text-warning text-xs mt-1 hidden flex items-center gap-1 font-medium';
            capswarn.innerHTML = '<span class="material-symbols-outlined text-[16px] align-middle">keyboard_capslock</span> <span class="align-middle">Caps Lock is ON</span>';
            field.parentElement.insertAdjacentElement('afterend', capswarn);

            field.addEventListener('keydown', (e) => {
                if (e.getModifierState && e.getModifierState('CapsLock')) {
                    capswarn.classList.remove('hidden');
                } else {
                    capswarn.classList.add('hidden');
                }
            });
            field.addEventListener('blur', () => {
                capswarn.classList.add('hidden');
            });

            if (field.id === 'password' && (window.location.pathname.includes('/signup') || window.location.pathname.includes('/reset-password'))) {
                let strengthContainer = document.createElement('div');
                strengthContainer.className = 'mt-2';
                strengthContainer.innerHTML = `
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-xs text-on-surface-variant font-medium">Password Strength</span>
                        <span class="text-xs font-semibold strength-label text-error"></span>
                    </div>
                    <div class="h-1.5 w-full bg-surface-container rounded-full overflow-hidden flex gap-0.5">
                        <div class="h-full bg-error strength-bar-1 transition-all duration-300 w-0"></div>
                        <div class="h-full bg-warning strength-bar-2 transition-all duration-300 w-0"></div>
                        <div class="h-full bg-secondary strength-bar-3 transition-all duration-300 w-0"></div>
                    </div>
                `;
                field.parentElement.parentElement.appendChild(strengthContainer);

                const label = strengthContainer.querySelector('.strength-label');
                const bar1 = strengthContainer.querySelector('.strength-bar-1');
                const bar2 = strengthContainer.querySelector('.strength-bar-2');
                const bar3 = strengthContainer.querySelector('.strength-bar-3');

                field.addEventListener('input', () => {
                    const val = field.value;
                    let score = 0;
                    if (val.length >= 8) score++;
                    if (/[A-Z]/.test(val) && /[a-z]/.test(val)) score++;
                    if (/[0-9]/.test(val) || /[^A-Za-z0-9]/.test(val)) score++;

                    if (val.length === 0) {
                        label.textContent = '';
                        bar1.style.width = '0%';
                        bar2.style.width = '0%';
                        bar3.style.width = '0%';
                    } else if (score <= 1) {
                        label.textContent = 'Weak';
                        label.className = 'text-xs font-semibold strength-label text-error';
                        bar1.style.width = '33%';
                        bar2.style.width = '0%';
                        bar3.style.width = '0%';
                    } else if (score === 2) {
                        label.textContent = 'Medium';
                        label.className = 'text-xs font-semibold strength-label text-warning';
                        bar1.style.width = '33%';
                        bar2.style.width = '33%';
                        bar3.style.width = '0%';
                    } else {
                        label.textContent = 'Strong';
                        label.className = 'text-xs font-semibold strength-label text-secondary';
                        bar1.style.width = '33%';
                        bar2.style.width = '33%';
                        bar3.style.width = '34%';
                    }
                });
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initFormEnhancements);
    } else {
        initFormEnhancements();
    }
})();
