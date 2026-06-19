/* =====================================================================
 * Gym Flow — App Shell
 * Loaded on every authenticated page (injected by utils.js). Provides:
 *   • FEATURE 1 — Subscription status badge (top-right): trial countdown
 *     with colour thresholds + paid "Premium" state.
 *   • FEATURES 3–5 — First-run guided product tour: spotlight overlay,
 *     floating tooltip, progress + step counter, keyboard navigation,
 *     click/scroll lockout, and DB-persisted resume.
 *
 * Depends on window.api (api.js) and window.esc (utils.js). Runs on
 * DOMContentLoaded so both are guaranteed available. Never throws into the
 * host page — every entry point is guarded.
 * ===================================================================== */
(function () {
  'use strict';
  if (window.__gymAppShell) return;            // guard against double-injection
  window.__gymAppShell = true;

  var esc = window.esc || function (s) { return String(s == null ? '' : s); };
  var PLAN_LABEL = { basic: 'Basic', pro: 'Pro', enterprise: 'Enterprise', trial: 'Trial' };

  function fmtDate(d) {
    try {
      return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) { return ''; }
  }
  function daysUntil(future) {
    return Math.ceil((new Date(future).getTime() - Date.now()) / 86400000);
  }

  // Shared keyframes (CSP-safe: injected as a <style>, not inline).
  (function injectStyle() {
    var s = document.createElement('style');
    s.textContent =
      '@keyframes gfPulse{0%,100%{opacity:1}50%{opacity:.55}}' +
      '@keyframes gfRing{0%{box-shadow:0 0 0 0 rgba(140,170,255,.55)}70%{box-shadow:0 0 0 12px rgba(140,170,255,0)}100%{box-shadow:0 0 0 0 rgba(140,170,255,0)}}' +
      '#gf-tour-tip{font-family:inherit}' +
      '@media (max-width:767px){#gf-tour-tip{left:12px!important;right:12px!important;width:auto!important;bottom:16px!important;top:auto!important}}';
    document.head.appendChild(s);
  })();

  /* =================================================================
   * FEATURE 1 — Subscription status badge
   * ================================================================= */
  var Badge = {
    el: null, timer: null, state: null,
    mount: function () {
      if (this.el) return;
      var el = document.createElement('div');
      el.id = 'gf-sub-badge';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = 'position:fixed;top:14px;right:16px;z-index:9500;';
      document.body.appendChild(el);
      this.el = el;
    },
    load: async function () {
      try {
        var r = await window.api.fetch('/subscription/status');
        if (!r.ok) return;
        this.state = await r.json();
        this.mount();
        this.render();
        if (this.timer) clearInterval(this.timer);
        // Recompute the countdown every minute so it stays current with no re-fetch.
        this.timer = setInterval(function () { Badge.render(); }, 60000);
      } catch (e) { /* offline — badge simply absent */ }
    },
    render: function () {
      if (!this.el || !this.state) return;
      var s = this.state;
      var plan = s.plan || 'trial';
      var status = s.status || 'trial';
      var isPaid = plan !== 'trial' && status !== 'trial' && status !== 'expired';
      this.el.innerHTML = isPaid ? this.paid(plan) : this.trial(s, status);
    },
    paid: function (plan) {
      var label = PLAN_LABEL[plan] || (plan.charAt(0).toUpperCase() + plan.slice(1));
      return '<div style="display:flex;align-items:center;gap:8px;background:rgba(20,22,30,.72);backdrop-filter:blur(10px);border:1px solid rgba(255,206,107,.35);border-radius:999px;padding:6px 14px 6px 10px;box-shadow:0 4px 18px rgba(0,0,0,.25)">'
        + '<span class="material-symbols-outlined" style="font-size:18px;color:#ffce6b;font-variation-settings:\'FILL\' 1">workspace_premium</span>'
        + '<span style="display:flex;flex-direction:column;line-height:1.15">'
        +   '<span style="font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#ffce6b">Premium</span>'
        +   '<span style="font-size:11px;color:#cfd2dc">Plan: ' + esc(label) + '</span>'
        + '</span></div>';
    },
    trial: function (s, status) {
      var left = s.trialEnd ? daysUntil(s.trialEnd) : (s.trialDaysLeft || 0);
      var expired = status === 'expired' || left <= 0;
      var c;
      if (expired || left <= 1)      c = { bg: 'rgba(244,67,54,.16)',  bd: 'rgba(244,67,54,.5)',  fg: '#ff6b6b', pulse: true };
      else if (left <= 3)            c = { bg: 'rgba(255,138,76,.16)', bd: 'rgba(255,138,76,.45)', fg: '#ff9f5a', pulse: false };
      else if (left <= 7)            c = { bg: 'rgba(255,193,95,.15)', bd: 'rgba(255,193,95,.45)', fg: '#ffce6b', pulse: false };
      else                           c = { bg: 'rgba(129,201,149,.14)',bd: 'rgba(129,201,149,.4)', fg: '#81c995', pulse: false };

      var anim = c.pulse ? 'animation:gfPulse 1.6s infinite;' : '';
      var wrap = 'text-decoration:none;display:flex;align-items:center;gap:8px;background:' + c.bg + ';backdrop-filter:blur(10px);border:1px solid ' + c.bd + ';border-radius:999px;padding:6px 14px 6px 10px;box-shadow:0 4px 18px rgba(0,0,0,.25);' + anim;

      if (expired) {
        return '<a href="/settings#subscription-plan" aria-label="Trial expired — view plans" style="' + wrap + '">'
          + '<span class="material-symbols-outlined" style="font-size:18px;color:' + c.fg + '">lock</span>'
          + '<span style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:' + c.fg + '">Trial Expired</span>'
          + '<span class="material-symbols-outlined" style="font-size:16px;color:' + c.fg + ';opacity:.7">arrow_forward</span></a>';
      }
      var word = left === 1 ? 'day' : 'days';
      return '<a href="/settings#subscription-plan" aria-label="Free trial, ' + left + ' ' + word + ' left" style="' + wrap + '">'
        + '<span class="material-symbols-outlined" style="font-size:18px;color:' + c.fg + '">timer</span>'
        + '<span style="display:flex;flex-direction:column;line-height:1.15">'
        +   '<span style="font-size:11px;font-weight:800;color:' + c.fg + '">Trial • ' + left + ' ' + word + ' left</span>'
        +   (s.trialEnd ? '<span style="font-size:10px;color:#aab2c4">Ends on ' + esc(fmtDate(s.trialEnd)) + '</span>' : '')
        + '</span></a>';
    }
  };

  /* =================================================================
   * FEATURES 3–5 — Guided product tour
   * ================================================================= */
  var STEPS = [
    { sel: 'a[href="/settings"]', title: 'Settings — start here', skippable: false,
      what: 'Your control centre for gym profile, branding, GST, UPI, business hours and plans.',
      why: 'A complete profile makes every receipt, reminder and payment link look professional.',
      rec: 'Fill in gym name, address, phone, email, UPI ID and logo before adding members.' },
    { sel: 'a[href="/dashboard"]', title: 'Dashboard',
      what: "A live view of revenue, active members, attendance and alerts.",
      why: 'It surfaces what needs attention today — expiring members, dues and absentees.',
      rec: 'Check it every morning.' },
    { sel: 'a[href="/members"]', title: 'Members',
      what: 'Add members, view profiles and track each active plan.',
      why: 'Accurate member records drive renewals, attendance and revenue reporting.',
      rec: 'Always capture a phone number — it powers WhatsApp reminders.' },
    { sel: 'a[href="/attendance"]', title: 'Attendance',
      what: 'Log daily check-ins and spot your most (and least) active members.',
      why: 'Absentees are your churn risk — catching them early saves the membership.',
      rec: 'Use phone/QR check-in at the front desk.' },
    { sel: 'a[href="/finance"],a[href="/payment-center"]', title: 'Payments',
      what: 'Collect dues, record cash/UPI/card payments and issue receipts.',
      why: 'Server-verified payments keep your revenue numbers trustworthy.',
      rec: 'Clear pending invoices daily.' },
    { sel: 'a[href="/notifications"]', title: 'Notifications',
      what: 'Automated expiry, payment-due and absentee alerts land here.',
      why: 'Nothing slips through — the system watches every member for you.',
      rec: 'Review the high-priority items first.' },
    { sel: 'a[href="/marketing"]', title: 'Marketing',
      what: 'Send WhatsApp campaigns and festival offers to member segments.',
      why: 'Re-engagement campaigns recover lapsed members at near-zero cost.',
      rec: 'Target "Expiring Soon" before month-end.' },
    { sel: 'a[href="/bi"],a[href="/daily-closing"]', title: 'Reports & Analytics',
      what: 'Revenue trends, churn, retention and renewal forecasts.',
      why: 'Decisions backed by data beat guesswork every time.',
      rec: 'Watch churn and renewal-rate weekly.' },
    { sel: 'a[href="/staff"]', title: 'Staff',
      what: 'Manage trainers and employees (Enterprise).',
      why: 'Delegate the front desk while keeping an audit trail.',
      rec: 'Available on the Enterprise plan.' },
    { sel: 'a[href="/settings"]', title: 'Subscription & Backup', last: true,
      what: 'Inside Settings you manage your subscription and export data backups.',
      why: 'Upgrade before your trial ends to avoid any interruption, and back up regularly.',
      rec: 'Set a monthly backup reminder.' }
  ];

  var Tour = {
    active: false, step: 0, panes: [], ring: null, tip: null, target: null,
    _reflow: null, _key: null, _block: null,

    start: function (resumeStep) {
      if (this.active) return;
      this.active = true;
      this.step = Math.min(Math.max(0, resumeStep || 0), STEPS.length - 1);

      // Build 4 dark panes (the frame around the spotlight hole) + a pulsing ring.
      for (var i = 0; i < 4; i++) {
        var p = document.createElement('div');
        p.style.cssText = 'position:fixed;z-index:9700;background:rgba(8,10,16,.74);backdrop-filter:blur(1.5px);transition:all .35s ease;';
        document.body.appendChild(p);
        this.panes.push(p);
      }
      this.ring = document.createElement('div');
      this.ring.style.cssText = 'position:fixed;z-index:9701;border:2px solid #8caaff;border-radius:12px;pointer-events:none;transition:all .35s ease;animation:gfRing 1.8s infinite;';
      document.body.appendChild(this.ring);

      this.tip = document.createElement('div');
      this.tip.id = 'gf-tour-tip';
      this.tip.setAttribute('role', 'dialog');
      this.tip.setAttribute('aria-modal', 'true');
      this.tip.style.cssText = 'position:fixed;z-index:9702;width:320px;max-width:92vw;background:rgba(18,20,28,.97);border:1px solid rgba(140,170,255,.35);border-radius:16px;padding:18px;box-shadow:0 18px 50px rgba(0,0,0,.5);transition:top .35s ease,left .35s ease;';
      document.body.appendChild(this.tip);

      // Lock the page: no scroll, no stray key navigation.
      document.body.style.overflow = 'hidden';
      this._block = function (e) { e.preventDefault(); e.stopPropagation(); };
      window.addEventListener('wheel', this._block, { passive: false });
      window.addEventListener('touchmove', this._block, { passive: false });
      this._key = function (e) { Tour.onKey(e); };
      window.addEventListener('keydown', this._key, true);
      this._reflow = function () { Tour.position(); };
      window.addEventListener('resize', this._reflow);
      window.addEventListener('scroll', this._reflow, true);

      this.render();
    },

    findTarget: function () {
      var step = STEPS[this.step];
      var el = null;
      try { el = document.querySelector(step.sel); } catch (e) {}
      return (el && el.getBoundingClientRect().width > 0) ? el : null;
    },

    render: function () {
      // We never SKIP a step whose target is missing/hidden (e.g. the desktop
      // sidebar is hidden on mobile). Instead that step's guidance is shown centred,
      // so every section is still explained and the resume index stays accurate.
      this.target = this.findTarget();
      this.position();
      this.renderTip();
    },

    position: function () {
      if (!this.active) return;
      var W = window.innerWidth, H = window.innerHeight;
      var tw = Math.min(320, Math.max(220, W - 24));
      var th = this.tip.offsetHeight || 240;

      if (!this.target) {
        // Nothing to highlight on this viewport — full dim + centred guidance card.
        this.setPane(0, 0, 0, W, H);
        this.setPane(1, 0, 0, 0, 0); this.setPane(2, 0, 0, 0, 0); this.setPane(3, 0, 0, 0, 0);
        this.ring.style.display = 'none';
        if (W >= 768) {
          this.tip.style.left = Math.max(8, (W - tw) / 2) + 'px';
          this.tip.style.top = Math.max(12, (H - th) / 2) + 'px';
        }
        return;
      }

      var pad = 8;
      var r = this.target.getBoundingClientRect();
      var x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
      var w = r.width + pad * 2, h = r.height + pad * 2;
      // Four dark panes forming a frame around the transparent spotlight hole.
      this.setPane(0, 0, 0, W, y);
      this.setPane(1, 0, y + h, W, H - (y + h));
      this.setPane(2, 0, y, x, h);
      this.setPane(3, x + w, y, W - (x + w), h);
      this.ring.style.top = y + 'px'; this.ring.style.left = x + 'px';
      this.ring.style.width = w + 'px'; this.ring.style.height = h + 'px';
      this.ring.style.display = 'block';

      // Tooltip beside the target: right if it fits, else left, else clamped.
      if (W >= 768) {
        var tl, tt;
        if (r.right + 16 + tw < W) tl = r.right + 16;
        else if (r.left - 16 - tw > 0) tl = r.left - 16 - tw;
        else tl = Math.min(Math.max(8, r.left), W - tw - 8);
        tt = Math.min(Math.max(12, r.top), H - th - 12);
        this.tip.style.left = tl + 'px';
        this.tip.style.top = tt + 'px';
      }
    },
    setPane: function (i, l, t, w, h) {
      var p = this.panes[i];
      p.style.left = l + 'px'; p.style.top = t + 'px';
      p.style.width = Math.max(0, w) + 'px'; p.style.height = Math.max(0, h) + 'px';
    },

    renderTip: function () {
      var s = STEPS[this.step];
      var n = STEPS.length;
      var pct = Math.round(((this.step + 1) / n) * 100);
      var isLast = this.step === n - 1 || s.last;
      var canSkip = s.skippable !== false;
      this.tip.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'
        + '<span style="font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#8caaff">Step ' + (this.step + 1) + ' of ' + n + '</span>'
        + (canSkip ? '<button data-act="skip" aria-label="Skip tour" style="background:none;border:none;color:#8b93a7;cursor:pointer;font-size:18px;line-height:1;padding:2px 4px">&times;</button>' : '')
        + '</div>'
        + '<div style="height:4px;background:rgba(255,255,255,.08);border-radius:99px;margin-bottom:14px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:#8caaff;border-radius:99px;transition:width .35s ease"></div></div>'
        + '<h3 style="margin:0 0 6px;font-size:17px;font-weight:700;color:#eef0f6">' + esc(s.title) + '</h3>'
        + '<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:#c2c7d4">' + esc(s.what) + '</p>'
        + (s.why ? '<p style="margin:0 0 4px;font-size:12px;line-height:1.45;color:#9aa2b5"><b style="color:#b9c0d2">Why it matters:</b> ' + esc(s.why) + '</p>' : '')
        + (s.rec ? '<p style="margin:0 0 14px;font-size:12px;line-height:1.45;color:#9aa2b5"><b style="color:#b9c0d2">Recommended:</b> ' + esc(s.rec) + '</p>' : '')
        + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">'
        + '<div>' + (canSkip ? '<button data-act="skip" style="background:none;border:none;color:#8b93a7;cursor:pointer;font-size:13px">Skip tour</button>' : '') + '</div>'
        + '<div style="display:flex;gap:8px">'
        + (this.step > 0 ? '<button data-act="prev" style="padding:7px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:none;color:#dfe3ee;cursor:pointer;font-size:13px">Previous</button>' : '')
        + '<button data-act="next" style="padding:7px 16px;border-radius:10px;border:none;background:#5b7cff;color:#fff;cursor:pointer;font-size:13px;font-weight:700">' + (isLast ? 'Finish' : 'Next') + '</button>'
        + '</div></div>';

      var self = this;
      Array.prototype.forEach.call(this.tip.querySelectorAll('[data-act]'), function (b) {
        b.addEventListener('click', function () {
          var a = b.getAttribute('data-act');
          if (a === 'next') self.next();
          else if (a === 'prev') self.prev();
          else if (a === 'skip') self.finish(true);
        });
      });
      this.tip.querySelector('[data-act="next"]').focus();
    },

    onKey: function (e) {
      if (!this.active) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); this.next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.prev(); }
      // Esc is intentionally ignored — the tour can't be dismissed by accident.
      else if (['ArrowUp', 'ArrowDown', ' ', 'PageUp', 'PageDown', 'Home', 'End', 'Tab'].indexOf(e.key) > -1) {
        e.preventDefault();
      }
    },

    saveStep: function () {
      try {
        window.api.fetch('/onboarding/tutorial-progress', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: this.step })
        });
      } catch (e) {}
    },

    next: function () {
      if (this.step >= STEPS.length - 1) return this.finish(false);
      this.step++; this.saveStep(); this.render();
    },
    prev: function () {
      if (this.step <= 0) return;
      this.step--; this.saveStep(); this.render();
    },

    finish: function () {
      if (!this.active) return;
      this.active = false;
      this.panes.forEach(function (p) { p.remove(); });
      this.panes = [];
      if (this.ring) this.ring.remove();
      if (this.tip) this.tip.remove();
      document.body.style.overflow = '';
      window.removeEventListener('wheel', this._block, { passive: false });
      window.removeEventListener('touchmove', this._block, { passive: false });
      window.removeEventListener('keydown', this._key, true);
      window.removeEventListener('resize', this._reflow);
      window.removeEventListener('scroll', this._reflow, true);
      try { window.api.fetch('/onboarding/complete-tour', { method: 'POST' }); } catch (e) {}
    }
  };

  /* =================================================================
   * Bootstrap
   * ================================================================= */
  function boot() {
    Badge.load();
    (async function () {
      try {
        var r = await window.api.fetch('/auth/session');
        if (!r.ok) return;
        var data = await r.json();
        var t = (data && data.tenant) || {};
        if (!t.tour_completed) {
          // Auto-start (or resume) the guided tour for gyms that haven't finished it.
          setTimeout(function () { Tour.start(t.tutorial_step || 0); }, 700);
        }
      } catch (e) { /* no session / offline — skip tour */ }
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.gymTour = Tour;     // expose for manual restart / debugging
})();
