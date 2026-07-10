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
    // Centralized calendar math when the shared engine is loaded (utils.js
    // injects it ahead of this file); millisecond fallback keeps the badge
    // working if the engine script ever fails to load.
    var eng = window.MembershipEngine;
    if (eng && eng.daysUntil) return eng.daysUntil(future);
    return Math.ceil((new Date(future).getTime() - Date.now()) / 86400000);
  }

  // Shared keyframes (CSP-safe: injected as a <style>, not inline).
  (function injectStyle() {
    var s = document.createElement('style');
    s.textContent =
      '@keyframes gfPulse{0%,100%{opacity:1}50%{opacity:.55}}' +
      '@keyframes gfRing{0%{box-shadow:0 0 0 0 rgba(140,170,255,.55)}70%{box-shadow:0 0 0 12px rgba(140,170,255,0)}100%{box-shadow:0 0 0 0 rgba(140,170,255,0)}}' +
      '#gf-tour-tip{font-family:inherit}' +
      '@media (max-width:767px){#gf-tour-tip{left:12px!important;right:12px!important;width:auto!important;bottom:16px!important;top:auto!important}}' +
      // Badge sits to the LEFT of the header's notification bell (bell is
      // ~40px wide at right:16 on mobile / right:32 on desktop) so the bell
      // stays tappable. On phones the second line is dropped to keep the
      // badge clear of the header logo.
      '#gf-sub-badge{position:fixed;top:12px;right:64px;z-index:9500}' +
      '@media (min-width:768px){#gf-sub-badge{right:80px;top:14px}}' +
      '@media (max-width:520px){#gf-sub-badge .gf-badge-sub{display:none}}';
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
        +   '<span style="font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#ffce6b">' + esc(label) + ' Plan</span>'
        +   '<span class="gf-badge-sub" style="font-size:11px;color:#cfd2dc">Active</span>'
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
        +   (s.trialEnd ? '<span class="gf-badge-sub" style="font-size:10px;color:#aab2c4">Ends on ' + esc(fmtDate(s.trialEnd)) + '</span>' : '')
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
        p.style.cssText = 'position:fixed;z-index:9700;background:rgba(8,10,16,.74);backdrop-filter:blur(1.5px);transition:left .35s ease,top .35s ease,width .35s ease,height .35s ease;';
        document.body.appendChild(p);
        this.panes.push(p);
      }
      this.ring = document.createElement('div');
      this.ring.style.cssText = 'position:fixed;z-index:9701;border:2px solid #8caaff;border-radius:12px;pointer-events:none;transition:left .35s ease,top .35s ease,width .35s ease,height .35s ease;animation:gfRing 1.8s infinite;';
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
   * [ORG] Organization & Identity Graph — pending banner
   * A dismissible strip below the header prompting the user to review
   * pending staff invitations / member-profile matches on /join. Entirely
   * additive; never throws into the host page.
   * ================================================================= */
  var OrgBanner = {
    ID: 'gf-org-banner',
    maybeShow: async function () {
      try {
        // Don't show on the focused identity flows themselves. NOTE: gate on the
        // path, not window.__gymAppShellInjected / __gfOnboarding — those are the
        // per-script init guards utils.js / onboarding.js set on EVERY page, so
        // they are always truthy here and can't indicate shell suppression.
        var path = (window.location.pathname || '');
        if (path === '/join' || path === '/select-role') return;
        // Guard against double-injection (SPA re-entry / re-boot).
        if (document.getElementById(this.ID)) return;

        var ctx = await window.api.get('/org/context');
        if (!ctx) return;
        var invites = (ctx.pending_invitations && ctx.pending_invitations.length) || 0;
        var claims = (ctx.pending_claims && ctx.pending_claims.length) || 0;
        var total = invites + claims;
        if (total <= 0) return;

        this.render(total, invites, claims);
      } catch (e) { /* offline / no session — banner simply absent */ }
    },
    render: function (total, invites, claims) {
      if (document.getElementById(this.ID)) return;
      // Wording: prefer the dominant kind but stay accurate for the mix.
      var noun;
      if (invites > 0 && claims === 0) noun = total === 1 ? 'invitation' : 'invitations';
      else if (claims > 0 && invites === 0) noun = total === 1 ? 'member match' : 'member matches';
      else noun = 'invitation(s) & match(es)';
      var msg = 'You have ' + total + ' pending ' + noun + '.';

      var bar = document.createElement('div');
      bar.id = this.ID;
      bar.setAttribute('role', 'status');
      // Fixed below the header (header is ~64px), z-index 9450 — under the
      // subscription badge (9500) so it never overlaps. Full-width on mobile;
      // offset for the 280px sidebar on desktop, matching the badge behaviour.
      bar.style.cssText =
        'position:fixed;top:64px;left:0;right:0;z-index:9450;' +
        'display:flex;align-items:center;gap:10px;' +
        'padding:8px 14px;' +
        'background:rgba(24,26,34,.92);backdrop-filter:blur(10px);' +
        'border-bottom:1px solid rgba(140,170,255,.35);' +
        'box-shadow:0 6px 20px rgba(0,0,0,.28);font-family:inherit;';
      bar.innerHTML =
        '<span class="material-symbols-outlined" style="font-size:20px;color:#8caaff;flex-shrink:0" aria-hidden="true">group_add</span>' +
        '<span style="flex:1;min-width:0;font-size:13px;color:#dfe3ee;line-height:1.35">' + esc(msg) + '</span>' +
        '<a href="/join" style="flex-shrink:0;text-decoration:none;font-size:12px;font-weight:700;color:#fff;background:#5b7cff;padding:6px 12px;border-radius:8px">Review</a>' +
        '<button type="button" data-org-dismiss aria-label="Dismiss" style="flex-shrink:0;background:none;border:none;color:#8b93a7;cursor:pointer;font-size:20px;line-height:1;padding:2px 4px">&times;</button>';

      // Desktop: clear the fixed 280px sidebar like #gf-sub-badge does.
      var mq = window.matchMedia('(min-width:768px)');
      function applyOffset() { bar.style.left = mq.matches ? '280px' : '0'; }
      applyOffset();
      if (mq.addEventListener) mq.addEventListener('change', applyOffset);

      var self = this;
      bar.querySelector('[data-org-dismiss]').addEventListener('click', function () {
        var el = document.getElementById(self.ID);
        if (el) el.remove();
      });

      document.body.appendChild(bar);
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
          if (t.onboarding_completed) {
            // Auto-start (or resume) the guided tour for gyms that finished setup.
            setTimeout(function () { Tour.start(t.tutorial_step || 0); }, 700);
          } else {
            // Setup wizard (onboarding.js) owns the screen until setup is done;
            // start the tour only after it signals completion.
            window.addEventListener('gf:onboarding-complete', function () {
              setTimeout(function () { Tour.start(0); }, 500);
            }, { once: true });
          }
        }
      } catch (e) { /* no session / offline — skip tour */ }
    })();

    // [ORG] Organization & Identity Graph — pending invitation / member-match
    // banner. Additive and fully self-contained: it must never break the shell,
    // so it runs after (and independently of) the session/tour logic above and
    // swallows every error.
    OrgBanner.maybeShow();
  }


  /* =================================================================
   * FEATURE 6 — Dynamic Interactive Analytics Drill-down Modal
   * ================================================================= */
  window.openAnalyticsDrilldown = async function (type, title, clickedSegment) {
    // 1. Create Modal Container if not exists
    var modal = document.getElementById('analyticsDrilldownModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'analyticsDrilldownModal';
      // Backdrop wrapper — starts hidden; opacity & backdrop-blur animate independently
      modal.className = 'fixed inset-0 z-[9999] hidden';
      modal.innerHTML =
        // Backdrop layer (fades in/out independently)
        '<div class="drilldown-backdrop absolute inset-0 bg-black/60 backdrop-blur-md opacity-0 transition-opacity duration-300 ease-out"></div>' +
        // Centering container — flex layout, does not animate
        '<div class="relative z-10 flex items-center justify-center w-full h-full p-4" id="drilldownCenterWrap">' +
        // Content card — scales/translates/fades as a unit
        '<div class="drilldown-card glass-panel w-full max-w-4xl rounded-2xl border border-white/10 shadow-2xl p-6 overflow-y-auto max-h-[90vh] flex flex-col gap-6' +
        ' opacity-0 scale-95 translate-y-4 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]">' +
        '  <!-- Header -->' +
        '  <div class="flex justify-between items-start border-b border-white/5 pb-4">' +
        '    <div>' +
        '      <h3 id="drilldownTitle" class="font-headline-lg text-headline-lg text-on-surface">Analytics Detailed View</h3>' +
        '      <p id="drilldownSubtitle" class="font-body-md text-body-md text-on-surface-variant mt-1">Deep-dive business intelligence metrics</p>' +
        '    </div>' +
        '    <button id="closeDrilldownBtn" class="text-on-surface-variant hover:text-on-surface p-1.5 rounded-lg hover:bg-white/5 transition-colors">' +
        '      <span class="material-symbols-outlined">close</span>' +
        '    </button>' +
        '  </div>' +
        '  <!-- Filter & Actions -->' +
        '  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface-container-low p-4 rounded-xl border border-white/5">' +
        '    <div class="flex items-center gap-2">' +
        '      <span class="material-symbols-outlined text-on-surface-variant text-sm">filter_alt</span>' +
        '      <select id="drilldownTimeRange" class="bg-surface-container border border-outline-variant px-3 py-1.5 rounded-lg font-label-md text-label-md text-on-background focus:outline-none focus:ring-1 focus:ring-primary">' +
        '        <option value="30">Last 30 Days</option>' +
        '        <option value="7">Last 7 Days</option>' +
        '        <option value="90">Last 90 Days</option>' +
        '      </select>' +
        '    </div>' +
        '    <div class="flex items-center gap-2">' +
        '      <button id="drilldownExportBtn" class="bg-primary/10 border border-primary text-primary px-4 py-2 rounded-lg font-label-md text-label-md hover:bg-primary/20 transition-colors flex items-center gap-2">' +
        '        <span class="material-symbols-outlined text-[18px]">download</span> Export CSV' +
        '      </button>' +
        '    </div>' +
        '  </div>' +
        '  <!-- Summary Grid -->' +
        '  <div id="drilldownSummaryGrid" class="grid grid-cols-1 sm:grid-cols-4 gap-4"></div>' +
        '  <!-- Chart & Insights -->' +
        '  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">' +
        '    <div class="lg:col-span-2 bg-surface-container-low p-4 rounded-xl border border-white/5 flex flex-col gap-4">' +
        '      <div class="flex items-center justify-between">' +
        '        <h4 id="drilldownChartTitle" class="font-title-md text-on-surface font-semibold">Breakdown</h4>' +
        '      </div>' +
        '      <div class="h-80 relative flex items-center justify-center">' +
        '        <canvas id="drilldownMainChart"></canvas>' +
        '        <div id="drilldownChartLoading" class="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-10 rounded-xl">' +
        '          <span class="material-symbols-outlined animate-spin text-primary text-5xl">progress_activity</span>' +
        '        </div>' +
        '        <div id="drilldownChartEmpty" class="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-surface/30 backdrop-blur-sm hidden z-10">' +
        '          <span class="material-symbols-outlined text-primary text-4xl mb-2">analytics</span>' +
        '          <h5 class="font-title-md text-on-surface font-semibold mb-1">No data available</h5>' +
        '          <p class="text-on-surface-variant text-xs">Try selecting a different date range.</p>' +
        '        </div>' +
        '      </div>' +
        '    </div>' +
        '    <div class="bg-surface-container-low p-4 rounded-xl border border-white/5 flex flex-col gap-4">' +
        '      <h4 class="font-title-md text-on-surface font-semibold flex items-center gap-2">' +
        '        <span class="material-symbols-outlined text-secondary">insights</span> Key Insights' +
        '      </h4>' +
        '      <ul id="drilldownInsightsList" class="space-y-3 text-sm text-on-surface-variant flex-1 overflow-y-auto max-h-[300px]"></ul>' +
        '    </div>' +
        '  </div>' +
        '  <!-- Table area -->' +
        '  <div id="drilldownTableContainer" class="hidden flex flex-col gap-4">' +
        '    <h4 id="drilldownTableTitle" class="font-title-md text-on-surface font-semibold">Breakdown Data</h4>' +
        '    <div class="overflow-x-auto bg-surface-container-low rounded-xl border border-white/5">' +
        '      <table class="w-full text-left border-collapse text-sm">' +
        '        <thead id="drilldownTableHeader" class="border-b border-white/10 text-on-surface-variant font-medium bg-surface-container-high">' +
        '        </thead>' +
        '        <tbody id="drilldownTableBody" class="divide-y divide-white/5 text-on-surface">' +
        '        </tbody>' +
        '      </table>' +
        '    </div>' +
        '  </div>' +
        '</div>' +
        '</div>';
      document.body.appendChild(modal);

      // ─── Close handler (shared by button, backdrop click, Escape) ───
      var backdrop = modal.querySelector('.drilldown-backdrop');
      var card     = modal.querySelector('.drilldown-card');
      var centerWrap = document.getElementById('drilldownCenterWrap');

      function closeDrilldown() {
        // Phase 1 — animate out
        backdrop.classList.add('opacity-0');
        card.classList.add('opacity-0', 'scale-95', 'translate-y-4');
        card.classList.remove('opacity-100', 'scale-100', 'translate-y-0');
        // Phase 2 — hide after transition completes
        var onEnd = function () {
          card.removeEventListener('transitionend', onEnd);
          modal.classList.add('hidden');
        };
        card.addEventListener('transitionend', onEnd);
        // Safety fallback if transitionend doesn't fire
        setTimeout(function () { modal.classList.add('hidden'); }, 350);
      }

      document.getElementById('closeDrilldownBtn').onclick = closeDrilldown;

      // Click outside the card to close
      centerWrap.addEventListener('click', function (e) {
        if (e.target === centerWrap) closeDrilldown();
      });

      // Escape key to close
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
          closeDrilldown();
        }
      });
    }

    // 2. Open Modal — two-phase animation via rAF
    var backdrop = modal.querySelector('.drilldown-backdrop');
    var card     = modal.querySelector('.drilldown-card');

    // Reset to initial hidden state
    backdrop.classList.add('opacity-0');
    card.classList.add('opacity-0', 'scale-95', 'translate-y-4');
    card.classList.remove('opacity-100', 'scale-100', 'translate-y-0');

    // Unhide the wrapper (no visual yet — both layers are at opacity-0)
    modal.classList.remove('hidden');

    // Next frame: trigger the transitions
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        // Backdrop fades in
        backdrop.classList.remove('opacity-0');
        // Card pops up with spring easing (slight delay for depth effect)
        card.classList.remove('opacity-0', 'scale-95', 'translate-y-4');
        card.classList.add('opacity-100', 'scale-100', 'translate-y-0');
      });
    });

    document.getElementById('drilldownTitle').innerText = title;
    var loading = document.getElementById('drilldownChartLoading');
    var empty = document.getElementById('drilldownChartEmpty');
    var grid = document.getElementById('drilldownSummaryGrid');
    var insightsList = document.getElementById('drilldownInsightsList');
    var tableContainer = document.getElementById('drilldownTableContainer');
    var tableHeader = document.getElementById('drilldownTableHeader');
    var tableBody = document.getElementById('drilldownTableBody');
    var tableTitle = document.getElementById('drilldownTableTitle');

    loading.classList.remove('hidden');
    empty.classList.add('hidden');
    tableContainer.classList.add('hidden');
    grid.innerHTML = '';
    insightsList.innerHTML = '';

    // 3. Lazy Load Chart.js CDN if not globally loaded
    if (!window.Chart) {
      await new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js';
        s.onload = resolve;
        document.head.appendChild(s);
      });
    }

    // 4. Fetch detailed statistics
    var data = null;
    try {
      data = await window.api.get('/analytics/drilldown/' + type);
    } catch (e) {
      console.error('Failed to load drilldown data:', e);
      loading.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.querySelector('h5').innerText = 'Connection Error';
      empty.querySelector('p').innerText = 'Could not fetch data from the server. Check your network.';
      return;
    }

    loading.classList.add('hidden');

    if (!data) {
      empty.classList.remove('hidden');
      return;
    }

    // Setup Export Button Handler
    var exportBtn = document.getElementById('drilldownExportBtn');
    exportBtn.onclick = function () {
      var csvContent = "data:text/csv;charset=utf-8,";
      csvContent += "Metric,Value\r\n";
      Object.keys(data).forEach(function (key) {
        if (Array.isArray(data[key])) {
          data[key].forEach(function (row) {
            csvContent += Object.keys(row).map(function (k) { return k + ':' + row[k]; }).join(",") + "\r\n";
          });
        }
      });
      var encodedUri = encodeURI(csvContent);
      var link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", type + "_drilldown_report.csv");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    function fmt(val) {
      return '₹' + Number(val || 0).toLocaleString('en-IN');
    }

    if (window._drilldownChart) {
      window._drilldownChart.destroy();
    }

    var chartCanvas = document.getElementById('drilldownMainChart');
    var chartCtx = chartCanvas.getContext('2d');
    var chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: '#b3b3b3' } }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#b3b3b3' } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#b3b3b3' } }
      },
      onHover: function (event, chartElement) {
        event.native.target.style.cursor = chartElement.length ? 'pointer' : 'default';
      }
    };

    if (type === 'revenue') {
      var dailyData = data.daily || [];
      var methodData = data.paymentMethods || [];
      var topPaying = data.topPaying || [];
      var dues = data.outstandingDues || [];

      var totalRev = dailyData.reduce(function (acc, curr) { return acc + (curr.amount || 0); }, 0);
      var upiAmt = (methodData.find(function (m) { return m.label.toLowerCase() === 'upi'; }) || {}).amount || 0;
      var cashAmt = (methodData.find(function (m) { return m.label.toLowerCase() === 'cash'; }) || {}).amount || 0;
      var dueAmt = dues.reduce(function (acc, curr) { return acc + (curr.total_due || 0); }, 0);

      grid.innerHTML = 
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">30D Revenue</span>' +
        '  <span class="text-xl font-bold text-secondary">' + fmt(totalRev) + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">UPI Collection</span>' +
        '  <span class="text-xl font-bold text-[#81c995]">' + fmt(upiAmt) + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Cash Collection</span>' +
        '  <span class="text-xl font-bold text-[#ffb95f]">' + fmt(cashAmt) + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Outstanding Dues</span>' +
        '  <span class="text-xl font-bold text-error">' + fmt(dueAmt) + '</span>' +
        '</div>';

      if (dailyData.length === 0) {
        empty.classList.remove('hidden');
      } else {
        window._drilldownChart = new Chart(chartCtx, {
          type: 'line',
          data: {
            labels: dailyData.map(function (d) { return d.date.substring(5); }),
            datasets: [{
              label: 'Daily Collection',
              data: dailyData.map(function (d) { return d.amount; }),
              borderColor: '#81c995',
              backgroundColor: 'rgba(129,201,149,0.1)',
              fill: true,
              tension: 0.3
            }]
          },
          options: chartOptions
        });
      }

      var upiPct = totalRev > 0 ? Math.round((upiAmt / totalRev) * 100) : 0;
      insightsList.innerHTML = 
        '<li class="flex gap-2"><span class="material-symbols-outlined text-[#81c995] text-[18px]">check_circle</span> UPI is the most popular payment channel, driving ' + upiPct + '% of total transactions.</li>' +
        '<li class="flex gap-2"><span class="material-symbols-outlined text-[#ffb95f] text-[18px]">info</span> Unpaid invoices have accumulated ' + fmt(dueAmt) + ' in outstanding dues.</li>' +
        '<li class="flex gap-2"><span class="material-symbols-outlined text-[#d0bcff] text-[18px]">trending_up</span> Rolling revenue indicates steady MoM growth with high customer conversion.</li>';

      tableContainer.classList.remove('hidden');
      tableTitle.innerText = "Outstanding Dues List";
      tableHeader.innerHTML = '<tr class="text-on-surface-variant font-medium"><th class="py-2 px-4">Member Name</th><th class="py-2 px-4">Outstanding Due</th></tr>';
      tableBody.innerHTML = dues.map(function (d) { 
        return '<tr><td class="py-2 px-4 font-semibold">' + esc(d.name) + '</td><td class="py-2 px-4 text-error font-bold">' + fmt(d.total_due) + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="py-4 text-center text-on-surface-variant">No outstanding dues.</td></tr>';

    } else if (type === 'members') {
      var joins = data.dailyJoins || [];
      var genders = data.genders || [];
      var plans = data.plans || [];
      var ageGroups = data.ageGroups || [];
      var expired = data.expiredList || [];

      var totalJoins = joins.reduce(function (acc, curr) { return acc + (curr.count || 0); }, 0);
      var maleCount = (genders.find(function (g) { return g.label.toLowerCase() === 'male'; }) || {}).count || 0;
      var femaleCount = (genders.find(function (g) { return g.label.toLowerCase() === 'female'; }) || {}).count || 0;
      var activeWithPlan = plans.reduce(function (acc, curr) { return acc + (curr.label !== 'No Active Plan' ? curr.count : 0); }, 0);

      grid.innerHTML = 
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">30D New Joins</span>' +
        '  <span class="text-xl font-bold text-primary">' + totalJoins + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Active members</span>' +
        '  <span class="text-xl font-bold text-secondary">' + activeWithPlan + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Male Members</span>' +
        '  <span class="text-xl font-bold text-[#ffb95f]">' + maleCount + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Female Members</span>' +
        '  <span class="text-xl font-bold text-[#d0bcff]">' + femaleCount + '</span>' +
        '</div>';

      if (plans.length === 0) {
        empty.classList.remove('hidden');
      } else {
        window._drilldownChart = new Chart(chartCtx, {
          type: 'doughnut',
          data: {
            labels: plans.map(function (p) { return p.label; }),
            datasets: [{
              data: plans.map(function (p) { return p.count; }),
              backgroundColor: ['#81c995', '#d0bcff', '#ffb95f', '#ff8a80']
            }]
          },
          options: chartOptions
        });
      }

      insightsList.innerHTML = 
        '<li class="flex gap-2"><span class="material-symbols-outlined text-primary text-[18px]">group</span> Roster split stands at ' + maleCount + ' male and ' + femaleCount + ' female members.</li>' +
        '<li class="flex gap-2"><span class="material-symbols-outlined text-[#81c995] text-[18px]">check_circle</span> Active plans show solid subscriptions.</li>' +
        '<li class="flex gap-2"><span class="material-symbols-outlined text-error text-[18px]">person_off</span> Expired members list contains ' + expired.length + ' accounts waiting for billing follow-up.</li>';

      tableContainer.classList.remove('hidden');
      tableTitle.innerText = "Recent Expired Members";
      tableHeader.innerHTML = '<tr class="text-on-surface-variant font-medium"><th class="py-2 px-4">Member Name</th><th class="py-2 px-4">Expired Date</th></tr>';
      tableBody.innerHTML = expired.map(function (e) { 
        return '<tr><td class="py-2 px-4 font-semibold">' + esc(e.name) + '</td><td class="py-2 px-4 text-on-surface-variant">' + esc(e.date) + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="py-4 text-center text-on-surface-variant">No recently expired members.</td></tr>';

    } else if (type === 'finance') {
      var txs = data.transactions || [];
      var pends = data.pending || [];
      var colls = data.collectionsByPlan || [];

      var totalCollected = txs.reduce(function (acc, curr) { return acc + (curr.total_amount || 0); }, 0);
      var totalPending = pends.reduce(function (acc, curr) { return acc + (curr.total_amount || 0); }, 0);
      var cardCount = txs.filter(function (t) { return (t.payment_method || '').toLowerCase() === 'card'; }).length;

      grid.innerHTML = 
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Total Received</span>' +
        '  <span class="text-xl font-bold text-secondary">' + fmt(totalCollected) + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Pending Dues</span>' +
        '  <span class="text-xl font-bold text-error">' + fmt(totalPending) + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Card Transactions</span>' +
        '  <span class="text-xl font-bold text-primary">' + cardCount + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Unpaid Count</span>' +
        '  <span class="text-xl font-bold text-[#ffb95f]">' + pends.length + '</span>' +
        '</div>';

      if (colls.length === 0) {
        empty.classList.remove('hidden');
      } else {
        window._drilldownChart = new Chart(chartCtx, {
          type: 'bar',
          data: {
            labels: colls.map(function (c) { return c.label; }),
            datasets: [{
              label: 'Total Collections',
              data: colls.map(function (c) { return c.amount; }),
              backgroundColor: '#ffb95f'
            }]
          },
          options: chartOptions
        });
      }

      insightsList.innerHTML = 
        '<li class="flex gap-2"><span class="material-symbols-outlined text-[#81c995] text-[18px]">currency_rupee</span> Outstanding due invoices equal ' + fmt(totalPending) + '.</li>' +
        '<li class="flex gap-2"><span class="material-symbols-outlined text-secondary text-[18px]">insights</span> Plan-wise segmentation shows high conversions for primary tiers.</li>';

      tableContainer.classList.remove('hidden');
      tableTitle.innerText = "Recent Paid Transactions";
      tableHeader.innerHTML = '<tr class="text-on-surface-variant font-medium"><th class="py-2 px-4">Invoice</th><th class="py-2 px-4">Member</th><th class="py-2 px-4">Amount</th><th class="py-2 px-4">Method</th></tr>';
      tableBody.innerHTML = txs.map(function (t) { 
        return '<tr><td class="py-2 px-4">' + esc(t.invoice_number) + '</td><td class="py-2 px-4 font-semibold">' + esc(t.name) + '</td><td class="py-2 px-4 text-secondary font-bold">' + fmt(t.total_amount) + '</td><td class="py-2 px-4 text-xs">' + esc(t.payment_method) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="py-4 text-center text-on-surface-variant">No paid transactions.</td></tr>';

    } else if (type === 'attendance') {
      var hourly = data.hourly || [];
      var heatmap = data.heatmap || [];
      var absent = data.absent || [];
      var frequent = data.frequent || [];

      var totalVisits = hourly.reduce(function (acc, curr) { return acc + (curr.count || 0); }, 0);
      var maxHourRow = hourly.sort(function (a,b) { return b.count - a.count; })[0];
      var maxHour = maxHourRow ? maxHourRow.hour + ':00' : 'N/A';

      grid.innerHTML = 
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Total Checkins</span>' +
        '  <span class="text-xl font-bold text-secondary">' + totalVisits + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Peak Hour</span>' +
        '  <span class="text-xl font-bold text-[#ffb95f]">' + maxHour + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">At Risk Members</span>' +
        '  <span class="text-xl font-bold text-error">' + absent.length + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Loyalty Leader</span>' +
        '  <span class="text-xl font-bold text-primary truncate block">' + (frequent[0] ? esc(frequent[0].name) : 'None') + '</span>' +
        '</div>';

      if (hourly.length === 0) {
        empty.classList.remove('hidden');
      } else {
        hourly.sort(function (a,b) { return Number(a.hour) - Number(b.hour); });
        window._drilldownChart = new Chart(chartCtx, {
          type: 'line',
          data: {
            labels: hourly.map(function (h) { return h.hour + ':00'; }),
            datasets: [{
              label: 'Checkins count',
              data: hourly.map(function (h) { return h.count; }),
              borderColor: '#d0bcff',
              backgroundColor: 'rgba(208,188,255,0.15)',
              fill: true,
              tension: 0.4
            }]
          },
          options: chartOptions
        });
      }

      insightsList.innerHTML = 
        '<li class="flex gap-2"><span class="material-symbols-outlined text-[#ffb95f] text-[18px]">schedule</span> The facility experiences maximum capacity at ' + maxHour + ' daily.</li>' +
        '<li class="flex gap-2"><span class="material-symbols-outlined text-[#d0bcff] text-[18px]">groups</span> Attendance is highest during early morning and late evening blocks.</li>' +
        '<li class="flex gap-2"><span class="material-symbols-outlined text-error text-[18px]">warning</span> ' + absent.length + ' active members haven\'t checked in for 20+ days.</li>';

      tableContainer.classList.remove('hidden');
      tableTitle.innerText = "Inactive / Absent Members (20+ Days)";
      tableHeader.innerHTML = '<tr class="text-on-surface-variant font-medium"><th class="py-2 px-4">Member Name</th><th class="py-2 px-4">Last Check-in</th></tr>';
      tableBody.innerHTML = absent.map(function (a) { 
        return '<tr><td class="py-2 px-4 font-semibold">' + esc(a.name) + '</td><td class="py-2 px-4 text-error font-bold">' + (a.last_seen ? fmtDate(a.last_seen) : 'Never') + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="py-4 text-center text-on-surface-variant">No absent members.</td></tr>';

    } else if (type === 'tasks') {
      var status = data.statusCounts || [];
      var overdue = data.overdueCount || 0;
      var priorities = data.priorities || [];
      var history = data.completedHistory || [];

      var completedCount = (status.find(function (s) { return s.label === 'Completed'; }) || {}).count || 0;
      var pendingCount = (status.find(function (s) { return s.label === 'Pending'; }) || {}).count || 0;
      var highPriority = priorities.find(function (p) { return p.label === 'High' || p.label === 'Critical'; })?.count || 0;

      grid.innerHTML = 
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Completed</span>' +
        '  <span class="text-xl font-bold text-[#81c995]">' + completedCount + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Pending</span>' +
        '  <span class="text-xl font-bold text-[#ffb95f]">' + pendingCount + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">Overdue</span>' +
        '  <span class="text-xl font-bold text-error">' + overdue + '</span>' +
        '</div>' +
        '<div class="bg-surface-container p-4 rounded-xl border border-white/5">' +
        '  <span class="block text-[10px] text-on-surface-variant uppercase tracking-wider">High/Critical</span>' +
        '  <span class="text-xl font-bold text-error">' + highPriority + '</span>' +
        '</div>';

      if (status.length === 0) {
        empty.classList.remove('hidden');
      } else {
        window._drilldownChart = new Chart(chartCtx, {
          type: 'pie',
          data: {
            labels: status.map(function (s) { return s.label; }),
            datasets: [{
              data: status.map(function (s) { return s.count; }),
              backgroundColor: ['#81c995', '#ffb95f', '#8bc34a']
            }]
          },
          options: chartOptions
        });
      }

      insightsList.innerHTML = 
        '<li class="flex gap-2"><span class="material-symbols-outlined text-error text-[18px]">warning</span> There are ' + overdue + ' task(s) currently past their due dates.</li>' +
        '<li class="flex gap-2"><span class="material-symbols-outlined text-[#ffb95f] text-[18px]">pending_actions</span> ' + pendingCount + ' tasks are pending staff attention.</li>' +
        '<li class="flex gap-2"><span class="material-symbols-outlined text-[#81c995] text-[18px]">check_circle</span> Staff operations are running cleanly.</li>';

      tableContainer.classList.remove('hidden');
      tableTitle.innerText = "Recently Completed Tasks History";
      tableHeader.innerHTML = '<tr class="text-on-surface-variant font-medium"><th class="py-2 px-4">Task Name</th><th class="py-2 px-4">Details</th><th class="py-2 px-4">Completed Date</th></tr>';
      tableBody.innerHTML = history.map(function (h) { 
        return '<tr><td class="py-2 px-4 font-semibold">' + esc(h.title) + '</td><td class="py-2 px-4 text-xs text-on-surface-variant">' + esc(h.detail || 'No details') + '</td><td class="py-2 px-4 text-[#81c995] font-bold">' + esc(h.completed_at) + '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="py-4 text-center text-on-surface-variant">No completed tasks.</td></tr>';
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.gymTour = Tour;     // expose for manual restart / debugging
})();
