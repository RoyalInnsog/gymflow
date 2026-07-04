/* GYM Flow — first-run setup wizard + trial reminder/lock modals.
 * Runs standalone: designSystem.js injects this script INSIDE its own
 * DOMContentLoaded handler, so by the time this file executes the DOM is
 * already ready — a 'DOMContentLoaded' listener here would never fire.
 * Guard on document.readyState instead.
 */
(function () {
  'use strict';

  if (window.__gfOnboarding) return;
  window.__gfOnboarding = true;

  var STORAGE_TRIAL_REMINDER = 'trial_reminder_shown';
  var DRAFT_PREFIX = 'gf_setup_draft_';

  var PAYMENT_METHODS = [
    { id: 'cash', label: 'Cash', checked: true },
    { id: 'upi', label: 'UPI', checked: true },
    { id: 'card', label: 'Card', checked: true },
    { id: 'bank_transfer', label: 'Bank Transfer', checked: false }
  ];

  var CURRENCIES = [
    { value: '₹', label: 'INR (₹)' },
    { value: '$', label: 'USD ($)' },
    { value: '€', label: 'EUR (€)' },
    { value: '£', label: 'GBP (£)' }
  ];

  function escStr(s) {
    if (window.esc) return window.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toastMsg(msg, type) {
    try {
      if (window.toast) window.toast(msg, type);
      else if (type === 'error') console.error(msg);
    } catch (e) { /* never throw into host page */ }
  }

  // ---------------------------------------------------------------------
  // Wizard controller
  // ---------------------------------------------------------------------
  function Wizard(session) {
    this.session = session;
    this.tenantId = (session.tenant && session.tenant.id) || (session.user && session.user.tenant_id) || 'default';
    this.draftKey = DRAFT_PREFIX + this.tenantId;
    this.step = 1;
    this.totalSteps = 3;
    this.data = this._defaultData();
    this.saving = false;
    this.els = {};
    this._debounceTimer = null;
    this._onKeydown = this._onKeydown.bind(this);
    this._onCardClick = this._onCardClick.bind(this);
    this._onCardInput = this._onCardInput.bind(this);
    this._onCardChange = this._onCardChange.bind(this);
  }

  Wizard.prototype._defaultData = function () {
    var t = (this.session && this.session.tenant) || {};
    return {
      gym_name: t.gym_name || '',
      address: '',
      support_phone: '',
      support_email: '',
      logo_url: '',
      currency: '₹',
      tax_rate_percent: 18,
      opening_time: '06:00',
      closing_time: '22:00',
      payment_methods: ['cash', 'upi', 'card'],
      plan_name: '',
      duration_months: 1,
      duration_days: 0,
      price: '',
      joining_fee: 0
    };
  };

  Wizard.prototype._restoreDraft = function () {
    try {
      var raw = localStorage.getItem(this.draftKey);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.data && typeof parsed.data === 'object') {
          for (var k in parsed.data) {
            if (Object.prototype.hasOwnProperty.call(this.data, k)) this.data[k] = parsed.data[k];
          }
        }
        if (parsed.step >= 1 && parsed.step <= this.totalSteps) this.step = parsed.step;
      }
    } catch (e) { /* ignore corrupt draft */ }
  };

  Wizard.prototype._persistDraft = function () {
    if (this._draftDone) return; // completed — never resurrect the draft
    try {
      localStorage.setItem(this.draftKey, JSON.stringify({ step: this.step, data: this.data }));
    } catch (e) { /* storage may be full/unavailable — non-fatal */ }
  };

  Wizard.prototype._scheduleDraftSave = function () {
    var self = this;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(function () {
      self._debounceTimer = null;
      self._persistDraft();
    }, 150);
  };

  Wizard.prototype._clearDraft = function () {
    // Cancel any in-flight debounce first — a timer firing after removal
    // would silently re-write the draft we just cleared.
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
    this._draftDone = true;
    try { localStorage.removeItem(this.draftKey); } catch (e) { /* ignore */ }
  };

  // -- chrome (built once) ------------------------------------------------

  Wizard.prototype.mount = function () {
    this._restoreDraft();
    this._injectStyles();

    this._prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    var backdrop = document.createElement('div');
    backdrop.className = 'gf-wiz-backdrop';

    var card = document.createElement('div');
    card.className = 'gf-wiz-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'gf-wiz-step-label');

    card.innerHTML =
      '<div class="gf-wiz-header">' +
        '<div class="gf-wiz-brand"><span class="gf-wiz-brand-dot"></span><span class="gf-wiz-brand-name">GYM Flow</span></div>' +
        '<div class="gf-wiz-step-label" id="gf-wiz-step-label"></div>' +
        '<div class="gf-wiz-progress-track"><div class="gf-wiz-progress-bar"></div></div>' +
      '</div>' +
      '<div class="gf-wiz-content-outer"><div class="gf-wiz-content"></div></div>' +
      '<div class="gf-wiz-footer">' +
        '<button type="button" class="gf-wiz-btn gf-wiz-btn-ghost" data-action="back">Back</button>' +
        '<button type="button" class="gf-wiz-btn gf-wiz-btn-primary" data-action="continue"><span class="gf-wiz-btn-label">Continue</span></button>' +
      '</div>';

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    this.els.backdrop = backdrop;
    this.els.card = card;
    this.els.stepLabel = card.querySelector('#gf-wiz-step-label');
    this.els.progressBar = card.querySelector('.gf-wiz-progress-bar');
    this.els.contentOuter = card.querySelector('.gf-wiz-content-outer');
    this.els.content = card.querySelector('.gf-wiz-content');
    this.els.backBtn = card.querySelector('[data-action="back"]');
    this.els.continueBtn = card.querySelector('[data-action="continue"]');

    card.addEventListener('click', this._onCardClick);
    card.addEventListener('input', this._onCardInput);
    card.addEventListener('change', this._onCardChange);
    document.addEventListener('keydown', this._onKeydown, true);

    // Fade backdrop in.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        backdrop.classList.add('gf-wiz-visible');
      });
    });

    this._renderStep(false);
    this._focusFirstField();
  };

  Wizard.prototype.teardown = function (dispatchComplete) {
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
    document.removeEventListener('keydown', this._onKeydown, true);
    if (this.els.card) {
      this.els.card.removeEventListener('click', this._onCardClick);
      this.els.card.removeEventListener('input', this._onCardInput);
      this.els.card.removeEventListener('change', this._onCardChange);
    }
    var backdrop = this.els.backdrop;
    var self = this;
    document.body.style.overflow = this._prevBodyOverflow || '';
    if (backdrop) {
      backdrop.classList.remove('gf-wiz-visible');
      backdrop.classList.add('gf-wiz-fading');
      setTimeout(function () {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      }, 320);
    }
    this.els = {};
    if (dispatchComplete) {
      try { window.dispatchEvent(new CustomEvent('gf:onboarding-complete')); } catch (e) { /* no-op */ }
    }
  };

  // -- focus trap -----------------------------------------------------------

  Wizard.prototype._focusableEls = function () {
    if (!this.els.card) return [];
    var nodes = this.els.card.querySelectorAll(
      'input, select, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.filter.call(nodes, function (n) {
      return n.offsetParent !== null || n === document.activeElement;
    });
  };

  Wizard.prototype._focusFirstField = function () {
    var self = this;
    setTimeout(function () {
      var focusables = self._focusableEls();
      if (focusables.length) focusables[0].focus();
    }, 30);
  };

  Wizard.prototype._onKeydown = function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key !== 'Tab') return;
    var focusables = this._focusableEls();
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // -- event delegation -------------------------------------------------

  Wizard.prototype._onCardClick = function (e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn || !this.els.card || !this.els.card.contains(btn)) return;
    var action = btn.getAttribute('data-action');
    if (action === 'back') this._handleBack();
    else if (action === 'continue') this._handleContinue();
  };

  Wizard.prototype._onCardInput = function () {
    this._readStepIntoData();
    this._scheduleDraftSave();
  };

  Wizard.prototype._onCardChange = function () {
    this._readStepIntoData();
    this._scheduleDraftSave();
  };

  // -- rendering ----------------------------------------------------------

  Wizard.prototype._stepTitles = { 1: 'Gym profile', 2: 'Business setup', 3: 'First membership plan' };

  Wizard.prototype._renderStep = function (animate) {
    this.els.stepLabel.textContent = 'Step ' + this.step + ' of ' + this.totalSteps + ' — ' + this._stepTitles[this.step];
    var pct = (this.step - 1) / (this.totalSteps - 1 || 1);
    // step 1 -> 0%, step 3 -> 100%; use step/total for a filling feel instead.
    pct = this.step / this.totalSteps;
    this.els.progressBar.style.transform = 'scaleX(' + pct + ')';

    this.els.backBtn.style.visibility = this.step > 1 ? 'visible' : 'hidden';
    var labelEl = this.els.continueBtn.querySelector('.gf-wiz-btn-label');
    labelEl.textContent = this.step === this.totalSteps ? 'Complete setup' : 'Continue';

    var html = this.step === 1 ? this._renderStep1() : this.step === 2 ? this._renderStep2() : this._renderStep3();

    var contentEl = this.els.content;

    var doSwap = function () {
      contentEl.innerHTML = html;
    };

    if (!animate) {
      doSwap();
      contentEl.classList.remove('gf-wiz-anim-out', 'gf-wiz-anim-in-start');
      return;
    }

    contentEl.classList.add('gf-wiz-anim-out');
    var self = this;
    setTimeout(function () {
      doSwap();
      contentEl.classList.remove('gf-wiz-anim-out');
      contentEl.classList.add('gf-wiz-anim-in-start');
      // Force reflow then animate to resting state.
      void contentEl.offsetWidth;
      requestAnimationFrame(function () {
        contentEl.classList.remove('gf-wiz-anim-in-start');
      });
      self._focusFirstField();
    }, 220);
  };

  function field(opts) {
    var required = opts.required ? ' <span class="gf-wiz-req">*</span>' : '';
    return (
      '<div class="gf-wiz-field" data-field="' + opts.id + '">' +
        '<label class="gf-wiz-label" for="' + opts.id + '">' + escStr(opts.label) + required + '</label>' +
        opts.input +
        '<div class="gf-wiz-error-text"></div>' +
      '</div>'
    );
  }

  Wizard.prototype._renderStep1 = function () {
    var d = this.data;
    return (
      '<div class="gf-wiz-grid">' +
        field({
          id: 'gym_name', label: 'Gym name', required: true,
          input: '<input class="gf-wiz-input" type="text" id="gym_name" name="gym_name" value="' + escStr(d.gym_name) + '" autocomplete="off">'
        }) +
        field({
          id: 'address', label: 'Address',
          input: '<input class="gf-wiz-input" type="text" id="address" name="address" value="' + escStr(d.address) + '" autocomplete="off">'
        }) +
        field({
          id: 'support_phone', label: 'Support phone',
          input: '<input class="gf-wiz-input" type="text" id="support_phone" name="support_phone" value="' + escStr(d.support_phone) + '" autocomplete="off">'
        }) +
        field({
          id: 'support_email', label: 'Support email',
          input: '<input class="gf-wiz-input" type="email" id="support_email" name="support_email" value="' + escStr(d.support_email) + '" autocomplete="off">'
        }) +
        field({
          id: 'logo_url', label: 'Logo URL (optional)',
          input: '<input class="gf-wiz-input" type="url" id="logo_url" name="logo_url" placeholder="https://example.com/logo.png" value="' + escStr(d.logo_url) + '" autocomplete="off">'
        }) +
      '</div>'
    );
  };

  Wizard.prototype._renderStep2 = function () {
    var d = this.data;
    var currencyOpts = CURRENCIES.map(function (c) {
      var sel = c.value === d.currency ? ' selected' : '';
      return '<option value="' + escStr(c.value) + '"' + sel + '>' + escStr(c.label) + '</option>';
    }).join('');

    var payChecks = PAYMENT_METHODS.map(function (m) {
      var checked = d.payment_methods.indexOf(m.id) !== -1 ? ' checked' : '';
      return (
        '<label class="gf-wiz-check">' +
          '<input type="checkbox" id="pay_' + m.id + '" name="payment_methods" value="' + m.id + '"' + checked + '>' +
          '<span>' + escStr(m.label) + '</span>' +
        '</label>'
      );
    }).join('');

    return (
      '<div class="gf-wiz-grid">' +
        field({
          id: 'currency', label: 'Currency',
          input: '<select class="gf-wiz-input" id="currency" name="currency">' + currencyOpts + '</select>'
        }) +
        field({
          id: 'tax_rate_percent', label: 'Tax rate (%)',
          input: '<input class="gf-wiz-input" type="number" id="tax_rate_percent" name="tax_rate_percent" min="0" max="40" step="0.01" value="' + escStr(d.tax_rate_percent) + '">'
        }) +
        '<div class="gf-wiz-row-2">' +
          field({
            id: 'opening_time', label: 'Opening time',
            input: '<input class="gf-wiz-input" type="time" id="opening_time" name="opening_time" value="' + escStr(d.opening_time) + '">'
          }) +
          field({
            id: 'closing_time', label: 'Closing time',
            input: '<input class="gf-wiz-input" type="time" id="closing_time" name="closing_time" value="' + escStr(d.closing_time) + '">'
          }) +
        '</div>' +
        '<div class="gf-wiz-field" data-field="payment_methods">' +
          '<label class="gf-wiz-label">Payment methods</label>' +
          '<div class="gf-wiz-check-group">' + payChecks + '</div>' +
          '<div class="gf-wiz-error-text"></div>' +
        '</div>' +
      '</div>'
    );
  };

  Wizard.prototype._renderStep3 = function () {
    var d = this.data;
    return (
      '<div class="gf-wiz-grid">' +
        field({
          id: 'plan_name', label: 'Plan name', required: true,
          input: '<input class="gf-wiz-input" type="text" id="plan_name" name="plan_name" placeholder="e.g. Monthly Standard" value="' + escStr(d.plan_name) + '" autocomplete="off">'
        }) +
        '<div class="gf-wiz-row-2">' +
          field({
            id: 'duration_months', label: 'Duration (months)',
            input: '<input class="gf-wiz-input" type="number" id="duration_months" name="duration_months" min="0" value="' + escStr(d.duration_months) + '">'
          }) +
          field({
            id: 'duration_days', label: 'Duration (days)',
            input: '<input class="gf-wiz-input" type="number" id="duration_days" name="duration_days" min="0" value="' + escStr(d.duration_days) + '">'
          }) +
        '</div>' +
        field({
          id: 'price', label: 'Price', required: true,
          input: '<input class="gf-wiz-input" type="number" id="price" name="price" min="0" step="0.01" placeholder="1500" value="' + escStr(d.price) + '">'
        }) +
        field({
          id: 'joining_fee', label: 'Joining fee',
          input: '<input class="gf-wiz-input" type="number" id="joining_fee" name="joining_fee" min="0" step="0.01" value="' + escStr(d.joining_fee) + '">'
        }) +
      '</div>'
    );
  };

  // -- data read/validate --------------------------------------------------

  Wizard.prototype._readStepIntoData = function () {
    var c = this.els.content;
    if (!c) return;
    var d = this.data;
    function val(id) {
      var el = c.querySelector('#' + id);
      return el ? el.value : undefined;
    }
    if (this.step === 1) {
      if (val('gym_name') !== undefined) d.gym_name = val('gym_name');
      if (val('address') !== undefined) d.address = val('address');
      if (val('support_phone') !== undefined) d.support_phone = val('support_phone');
      if (val('support_email') !== undefined) d.support_email = val('support_email');
      if (val('logo_url') !== undefined) d.logo_url = val('logo_url');
    } else if (this.step === 2) {
      if (val('currency') !== undefined) d.currency = val('currency');
      if (val('tax_rate_percent') !== undefined) d.tax_rate_percent = val('tax_rate_percent');
      if (val('opening_time') !== undefined) d.opening_time = val('opening_time');
      if (val('closing_time') !== undefined) d.closing_time = val('closing_time');
      var methods = [];
      Array.prototype.forEach.call(c.querySelectorAll('input[name="payment_methods"]:checked'), function (cb) {
        methods.push(cb.value);
      });
      d.payment_methods = methods;
    } else if (this.step === 3) {
      if (val('plan_name') !== undefined) d.plan_name = val('plan_name');
      if (val('duration_months') !== undefined) d.duration_months = val('duration_months');
      if (val('duration_days') !== undefined) d.duration_days = val('duration_days');
      if (val('price') !== undefined) d.price = val('price');
      if (val('joining_fee') !== undefined) d.joining_fee = val('joining_fee');
    }
  };

  Wizard.prototype._clearFieldError = function (fieldId) {
    var wrap = this.els.content.querySelector('[data-field="' + fieldId + '"]');
    if (!wrap) return;
    wrap.classList.remove('gf-wiz-invalid');
    var t = wrap.querySelector('.gf-wiz-error-text');
    if (t) t.textContent = '';
  };

  Wizard.prototype._setFieldError = function (fieldId, message) {
    var wrap = this.els.content.querySelector('[data-field="' + fieldId + '"]');
    if (!wrap) return;
    wrap.classList.add('gf-wiz-invalid');
    var t = wrap.querySelector('.gf-wiz-error-text');
    if (t) t.textContent = message;
  };

  Wizard.prototype._validateStep = function () {
    this._readStepIntoData();
    var d = this.data;
    var c = this.els.content;
    var errors = [];

    // Clear previous errors for current step's fields.
    Array.prototype.forEach.call(c.querySelectorAll('.gf-wiz-field'), function (wrap) {
      wrap.classList.remove('gf-wiz-invalid');
      var t = wrap.querySelector('.gf-wiz-error-text');
      if (t) t.textContent = '';
    });

    if (this.step === 1) {
      if (!d.gym_name || !d.gym_name.trim()) errors.push({ field: 'gym_name', message: 'Gym name is required.' });
    } else if (this.step === 2) {
      var tax = parseFloat(d.tax_rate_percent);
      if (isNaN(tax) || tax < 0 || tax > 40) errors.push({ field: 'tax_rate_percent', message: 'Enter a tax rate between 0 and 40.' });
      if (!d.payment_methods || !d.payment_methods.length) errors.push({ field: 'payment_methods', message: 'Select at least one payment method.' });
    } else if (this.step === 3) {
      if (!d.plan_name || !d.plan_name.trim()) errors.push({ field: 'plan_name', message: 'Plan name is required.' });
      var months = parseFloat(d.duration_months) || 0;
      var days = parseFloat(d.duration_days) || 0;
      if (months <= 0 && days <= 0) {
        errors.push({ field: 'duration_months', message: 'Set months or days.' });
        errors.push({ field: 'duration_days', message: 'Set months or days.' });
      }
      var price = parseFloat(d.price);
      if (isNaN(price) || price <= 0) errors.push({ field: 'price', message: 'Enter a price greater than 0.' });
    }

    if (errors.length) {
      var self = this;
      errors.forEach(function (err) { self._setFieldError(err.field, err.message); });
      var firstWrap = c.querySelector('[data-field="' + errors[0].field + '"]');
      if (firstWrap) {
        var focusable = firstWrap.querySelector('input, select, textarea');
        if (focusable) focusable.focus();
      }
      return false;
    }
    return true;
  };

  Wizard.prototype._shakeContinue = function () {
    var btn = this.els.continueBtn;
    btn.classList.remove('gf-wiz-shake');
    void btn.offsetWidth;
    btn.classList.add('gf-wiz-shake');
    setTimeout(function () { btn.classList.remove('gf-wiz-shake'); }, 260);
  };

  // -- navigation -----------------------------------------------------------

  Wizard.prototype._handleBack = function () {
    if (this.step <= 1 || this.saving) return;
    this._readStepIntoData();
    this._persistDraft();
    this.step--;
    this._renderStep(true);
  };

  Wizard.prototype._handleContinue = function () {
    if (this.saving) return;
    if (!this._validateStep()) {
      this._shakeContinue();
      return;
    }
    this._persistDraft();
    if (this.step < this.totalSteps) {
      this.step++;
      this._renderStep(true);
      return;
    }
    this._submit();
  };

  Wizard.prototype._buildPayload = function () {
    var d = this.data;
    return {
      gym_name: (d.gym_name || '').trim(),
      logo_url: (d.logo_url || '').trim(),
      address: (d.address || '').trim(),
      support_phone: (d.support_phone || '').trim(),
      support_email: (d.support_email || '').trim(),
      currency: d.currency || '₹',
      tax_rate_percent: parseFloat(d.tax_rate_percent) || 0,
      payment_methods: d.payment_methods && d.payment_methods.length ? d.payment_methods : ['cash'],
      opening_time: d.opening_time || '06:00',
      closing_time: d.closing_time || '22:00',
      plans: [{
        name: (d.plan_name || '').trim(),
        duration_months: parseInt(d.duration_months, 10) || 0,
        duration_days: parseInt(d.duration_days, 10) || 0,
        price: parseFloat(d.price) || 0,
        joining_fee: parseFloat(d.joining_fee) || 0
      }]
    };
  };

  Wizard.prototype._setSaving = function (saving) {
    this.saving = saving;
    var btn = this.els.continueBtn;
    btn.disabled = saving;
    btn.classList.toggle('gf-wiz-loading', saving);
    this.els.backBtn.disabled = saving;
    var label = btn.querySelector('.gf-wiz-btn-label');
    if (saving) {
      label.textContent = 'Saving';
    } else {
      label.textContent = this.step === this.totalSteps ? 'Complete setup' : 'Continue';
    }
  };

  Wizard.prototype._submit = function () {
    var self = this;
    this._setSaving(true);
    var payload = this._buildPayload();

    window.api.fetch('/onboarding/complete-setup', {
      method: 'POST',
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      return res.json().catch(function () { return {}; });
    }).then(function () {
      self._clearDraft();
      self._showSuccess();
    }).catch(function (err) {
      self._setSaving(false);
      toastMsg('Could not save setup. Please try again.', 'error');
      try { console.error('onboarding complete-setup failed:', err); } catch (e) { /* no-op */ }
    });
  };

  Wizard.prototype._showSuccess = function () {
    this.els.backBtn.style.display = 'none';
    this.els.continueBtn.style.display = 'none';
    this.els.stepLabel.textContent = 'All set';
    this.els.progressBar.style.transform = 'scaleX(1)';

    this.els.content.innerHTML =
      '<div class="gf-wiz-success">' +
        '<div class="gf-wiz-success-icon"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>' +
        '<h3 class="gf-wiz-success-title">Workspace ready</h3>' +
        '<p class="gf-wiz-success-text">Your gym profile, business settings, and first membership plan are saved. Your 21-day trial has started.</p>' +
      '</div>';

    var self = this;
    setTimeout(function () {
      if (window.location.pathname !== '/dashboard') {
        window.location.href = '/dashboard';
      } else {
        self.teardown(true);
      }
    }, 900);
  };

  // -- styles ---------------------------------------------------------------

  Wizard.prototype._injectStyles = function () {
    if (document.getElementById('gf-wiz-styles')) return;
    var style = document.createElement('style');
    style.id = 'gf-wiz-styles';
    style.textContent =
      '.gf-wiz-backdrop{position:fixed;inset:0;z-index:99990;background:rgba(8,10,16,.78);' +
      '-webkit-backdrop-filter:blur(14px) saturate(.85);backdrop-filter:blur(14px) saturate(.85);' +
      'display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 260ms cubic-bezier(0.2,0,0,1);}' +
      '.gf-wiz-backdrop.gf-wiz-visible{opacity:1;}' +
      '.gf-wiz-backdrop.gf-wiz-fading{opacity:0;}' +
      '.gf-wiz-card{font-family:Inter,system-ui,sans-serif;background:#171717;color:#f1f1f1;' +
      'display:flex;flex-direction:column;width:100%;max-width:560px;max-height:100%;' +
      'border-radius:20px;border:1px solid rgba(255,255,255,.08);box-shadow:0 24px 80px rgba(0,0,0,.5);overflow:hidden;}' +
      '@media (max-width:767px){.gf-wiz-card{position:fixed;inset:0;max-width:none;max-height:none;height:100%;border-radius:0;border:none;}}' +
      '.gf-wiz-header{padding:20px 24px 16px;border-bottom:1px solid #33333a;background:#1f1f1f;flex-shrink:0;}' +
      '.gf-wiz-brand{display:flex;align-items:center;gap:8px;margin-bottom:10px;}' +
      '.gf-wiz-brand-dot{width:8px;height:8px;border-radius:50%;background:var(--color-primary,#16c8ee);flex-shrink:0;}' +
      '.gf-wiz-brand-name{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#c8c8cf;}' +
      '.gf-wiz-step-label{font-size:16px;font-weight:600;color:#f1f1f1;margin-bottom:12px;}' +
      '.gf-wiz-progress-track{height:4px;border-radius:2px;background:#292929;overflow:hidden;}' +
      '.gf-wiz-progress-bar{height:100%;width:100%;border-radius:2px;background:var(--color-primary,#16c8ee);' +
      'transform:scaleX(0);transform-origin:left;transition:transform 260ms cubic-bezier(0.2,0,0,1);}' +
      '.gf-wiz-content-outer{flex:1 1 auto;overflow:hidden;min-height:320px;position:relative;}' +
      '@media (min-width:768px){.gf-wiz-content-outer{min-height:360px;}}' +
      '.gf-wiz-content{padding:24px;overflow-y:auto;max-height:100%;height:100%;box-sizing:border-box;' +
      'transition:opacity 220ms cubic-bezier(0.2,0,0,1),transform 220ms cubic-bezier(0.2,0,0,1);' +
      'opacity:1;transform:translateX(0);}' +
      '.gf-wiz-content.gf-wiz-anim-out{opacity:0;transform:translateX(-12px);}' +
      '.gf-wiz-content.gf-wiz-anim-in-start{opacity:0;transform:translateX(12px);}' +
      '.gf-wiz-grid{display:flex;flex-direction:column;gap:16px;}' +
      '.gf-wiz-row-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}' +
      '@media (max-width:420px){.gf-wiz-row-2{grid-template-columns:1fr;}}' +
      '.gf-wiz-field{display:flex;flex-direction:column;gap:6px;min-width:0;}' +
      '.gf-wiz-label{font-size:12px;font-weight:600;color:#c8c8cf;text-transform:uppercase;letter-spacing:.03em;}' +
      '.gf-wiz-req{color:#ffaaa3;}' +
      '.gf-wiz-input{width:100%;box-sizing:border-box;background:#1f1f1f;border:1px solid #33333a;border-radius:10px;' +
      'padding:11px 14px;color:#f1f1f1;font-size:15px;font-family:inherit;outline:none;transition:border-color 160ms;}' +
      '.gf-wiz-input:focus{border-color:var(--color-primary,#16c8ee);}' +
      '.gf-wiz-field.gf-wiz-invalid .gf-wiz-input{border-color:#ffaaa3;}' +
      '.gf-wiz-error-text{font-size:12px;color:#ffaaa3;min-height:0;}' +
      '.gf-wiz-check-group{display:flex;flex-wrap:wrap;gap:12px 20px;}' +
      '.gf-wiz-check{display:flex;align-items:center;gap:8px;font-size:14px;color:#f1f1f1;cursor:pointer;}' +
      '.gf-wiz-check input{accent-color:var(--color-primary,#16c8ee);width:16px;height:16px;}' +
      '.gf-wiz-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
      'padding:16px 24px;border-top:1px solid #33333a;background:#1f1f1f;flex-shrink:0;}' +
      '@media (max-width:767px){.gf-wiz-footer{padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));}}' +
      '.gf-wiz-btn{appearance:none;border:none;border-radius:10px;font-family:inherit;font-size:14px;font-weight:600;' +
      'padding:11px 20px;cursor:pointer;white-space:nowrap;transition:transform 120ms,background-color 160ms,opacity 160ms;}' +
      '.gf-wiz-btn:active{transform:translateY(1px);}' +
      '.gf-wiz-btn:focus-visible{outline:2px solid var(--color-primary,#16c8ee);outline-offset:2px;transition:none;}' +
      '.gf-wiz-btn-ghost{background:transparent;color:#c8c8cf;}' +
      '.gf-wiz-btn-ghost:hover{background:#292929;color:#f1f1f1;}' +
      '.gf-wiz-btn-primary{background:var(--color-primary,#16c8ee);color:var(--color-on-primary,#041012);' +
      'display:inline-flex;align-items:center;gap:8px;min-width:112px;justify-content:center;}' +
      '.gf-wiz-btn-primary:hover{filter:brightness(1.08);}' +
      '.gf-wiz-btn-primary:disabled{opacity:.7;cursor:default;filter:none;}' +
      '.gf-wiz-btn.gf-wiz-shake{animation:gf-wiz-shake-kf 240ms cubic-bezier(0.2,0,0,1);}' +
      '@keyframes gf-wiz-shake-kf{0%{transform:translateX(0);}25%{transform:translateX(-6px);}' +
      '50%{transform:translateX(5px);}75%{transform:translateX(-3px);}100%{transform:translateX(0);}}' +
      '.gf-wiz-btn-primary.gf-wiz-loading .gf-wiz-btn-label{position:relative;padding-left:20px;}' +
      '.gf-wiz-btn-primary.gf-wiz-loading .gf-wiz-btn-label::before{content:"";position:absolute;left:0;top:50%;' +
      'width:14px;height:14px;margin-top:-7px;border-radius:50%;border:2px solid rgba(4,16,18,.35);' +
      'border-top-color:var(--color-on-primary,#041012);animation:gf-wiz-spin-kf 700ms linear infinite;}' +
      '@keyframes gf-wiz-spin-kf{to{transform:rotate(360deg);}}' +
      '.gf-wiz-success{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;' +
      'padding:32px 8px;gap:14px;animation:gf-wiz-success-kf 320ms cubic-bezier(0.2,0,0,1);}' +
      '@keyframes gf-wiz-success-kf{from{opacity:0;transform:scale(.9);}to{opacity:1;transform:scale(1);}}' +
      '.gf-wiz-success-icon{width:64px;height:64px;border-radius:50%;background:rgba(22,200,238,.14);' +
      'color:var(--color-primary,#16c8ee);display:flex;align-items:center;justify-content:center;}' +
      '.gf-wiz-success-title{font-size:20px;font-weight:700;color:#f1f1f1;margin:0;}' +
      '.gf-wiz-success-text{font-size:14px;color:#c8c8cf;max-width:380px;margin:0;}' +
      '@media (prefers-reduced-motion: reduce){' +
      '.gf-wiz-backdrop,.gf-wiz-progress-bar,.gf-wiz-content,.gf-wiz-btn,.gf-wiz-success{transition-duration:120ms!important;' +
      'animation-duration:1ms!important;}' +
      '.gf-wiz-content.gf-wiz-anim-out,.gf-wiz-content.gf-wiz-anim-in-start{transform:none!important;}' +
      '.gf-wiz-btn.gf-wiz-shake{animation:none!important;}' +
      '}';
    document.head.appendChild(style);
  };

  // ---------------------------------------------------------------------
  // Trial reminder / expired modals (retained, rewritten)
  // ---------------------------------------------------------------------

  function injectTrialStyles() {
    if (document.getElementById('gf-wiz-trial-styles')) return;
    var style = document.createElement('style');
    style.id = 'gf-wiz-trial-styles';
    style.textContent =
      '.gf-wiz-trial-backdrop{position:fixed;inset:0;z-index:99990;background:rgba(8,10,16,.78);' +
      '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);display:flex;align-items:center;' +
      'justify-content:center;padding:20px;opacity:0;transition:opacity 220ms cubic-bezier(0.2,0,0,1);}' +
      '.gf-wiz-trial-backdrop.gf-wiz-visible{opacity:1;}' +
      '.gf-wiz-trial-card{font-family:Inter,system-ui,sans-serif;width:100%;max-width:420px;background:#171717;' +
      'color:#f1f1f1;border-radius:18px;border:1px solid #33333a;box-shadow:0 24px 80px rgba(0,0,0,.5);' +
      'padding:28px 24px;text-align:center;}' +
      '.gf-wiz-trial-icon{width:56px;height:56px;border-radius:50%;margin:0 auto 16px;display:flex;' +
      'align-items:center;justify-content:center;background:rgba(255,170,163,.14);color:#ffaaa3;}' +
      '.gf-wiz-trial-title{font-size:19px;font-weight:700;margin:0 0 8px;}' +
      '.gf-wiz-trial-text{font-size:14px;color:#c8c8cf;margin:0 0 22px;line-height:1.5;}' +
      '.gf-wiz-trial-actions{display:flex;gap:10px;}' +
      '.gf-wiz-trial-actions .gf-wiz-btn{flex:1;}' +
      '@media (prefers-reduced-motion: reduce){.gf-wiz-trial-backdrop{transition-duration:120ms!important;}}';
    document.head.appendChild(style);
  }

  function computeDaysLeft(trialEnd) {
    if (window.MembershipEngine && typeof window.MembershipEngine.daysUntil === 'function') {
      return window.MembershipEngine.daysUntil(trialEnd);
    }
    return Math.ceil((new Date(trialEnd) - Date.now()) / 86400000);
  }

  function showTrialReminder(daysLeft) {
    injectTrialStyles();
    var backdrop = document.createElement('div');
    backdrop.className = 'gf-wiz-trial-backdrop';
    backdrop.innerHTML =
      '<div class="gf-wiz-trial-card" role="dialog" aria-modal="true">' +
        '<div class="gf-wiz-trial-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path></svg></div>' +
        '<h3 class="gf-wiz-trial-title">' + escStr(daysLeft) + (daysLeft === 1 ? ' day left' : ' days left') + '</h3>' +
        '<p class="gf-wiz-trial-text">Your free trial is ending soon. Subscribe now to keep uninterrupted access to your gym data.</p>' +
        '<div class="gf-wiz-trial-actions">' +
          '<button type="button" class="gf-wiz-btn gf-wiz-btn-ghost" data-action="later">Later</button>' +
          '<button type="button" class="gf-wiz-btn gf-wiz-btn-primary" data-action="upgrade"><span class="gf-wiz-btn-label">Upgrade now</span></button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(backdrop);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { backdrop.classList.add('gf-wiz-visible'); });
    });

    backdrop.addEventListener('click', function handler(e) {
      var btn = e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn) return;
      if (btn.getAttribute('data-action') === 'upgrade') {
        window.location.href = '/settings#subscription-plan';
        return;
      }
      backdrop.removeEventListener('click', handler);
      backdrop.classList.remove('gf-wiz-visible');
      setTimeout(function () {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      }, 240);
    });
  }

  function showTrialExpired() {
    injectTrialStyles();
    var backdrop = document.createElement('div');
    backdrop.className = 'gf-wiz-trial-backdrop';
    backdrop.innerHTML =
      '<div class="gf-wiz-trial-card" role="dialog" aria-modal="true">' +
        '<div class="gf-wiz-trial-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></div>' +
        '<h3 class="gf-wiz-trial-title">Trial expired</h3>' +
        '<p class="gf-wiz-trial-text">Your free trial has ended. Choose a subscription plan to regain access to your workspace and member data.</p>' +
        '<div class="gf-wiz-trial-actions">' +
          '<button type="button" class="gf-wiz-btn gf-wiz-btn-primary" data-action="upgrade" style="width:100%"><span class="gf-wiz-btn-label">View subscription plans</span></button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(backdrop);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { backdrop.classList.add('gf-wiz-visible'); });
    });

    backdrop.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-action]') : null;
      if (btn && btn.getAttribute('data-action') === 'upgrade') {
        window.location.href = '/settings#subscription-plan';
      }
    });
  }

  function runTrialModals(tenant) {
    if (!tenant || tenant.subscription_status !== 'trial' || !tenant.trial_end) return;
    var daysLeft = computeDaysLeft(tenant.trial_end);

    if (daysLeft < 0) {
      showTrialExpired();
      return;
    }

    if (daysLeft <= 5) {
      var today = new Date().toDateString();
      var last = null;
      try { last = localStorage.getItem(STORAGE_TRIAL_REMINDER); } catch (e) { /* ignore */ }
      if (last !== today) {
        showTrialReminder(daysLeft);
        try { localStorage.setItem(STORAGE_TRIAL_REMINDER, today); } catch (e) { /* ignore */ }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------

  function init() {
    if (!window.api || typeof window.api.fetch !== 'function') return;

    window.api.fetch('/api/v1/auth/session').then(function (res) {
      if (!res || !res.ok) return null;
      return res.json().catch(function () { return null; });
    }).then(function (session) {
      if (!session || !session.tenant) return;
      var tenant = session.tenant;

      if (!tenant.onboarding_completed) {
        var wizard = new Wizard(session);
        wizard.mount();
        return;
      }

      runTrialModals(tenant);
    }).catch(function () {
      // No session / network error on a public page — silently exit.
    });
  }

  function run() {
    try { init(); } catch (e) {
      try { console.error('onboarding init failed:', e); } catch (e2) { /* no-op */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
