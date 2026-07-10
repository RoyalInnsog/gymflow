/* =====================================================================
 * Gym Flow — Subscription Tier Gate · "Wizard Mode"  (window.GymPlanGate)
 * ---------------------------------------------------------------------
 * Client half of the Free/Basic ⟷ Pro barrier. Rather than hiding premium
 * modules (which hides the value from prospects), it renders the locked
 * workspace INTACT in the DOM and lays a frosted mask + a centered upgrade
 * card over it — an interactive discovery "wizard" that drives conversion.
 *
 * Reads the plan's capability flags from /subscription/status (the same
 * PLAN_LIMITS the server enforces). The server (requireFeature / WhatsApp
 * quota / single-plan rule) remains the authoritative backstop. Fail-OPEN:
 * a failed status request never locks the user out.
 * ===================================================================== */
(function () {
  'use strict';
  if (window.GymPlanGate) return;

  // feature flag (from limits) → the module it guards + upsell copy.
  var LOCKS = [
    { flag: 'allowMarketing', paths: ['/marketing'],
      title: 'Marketing Ecosystem', icon: 'campaign',
      bullets: ['Bulk WhatsApp campaigns & festival offers',
                'Automated expiry, dues & win-back messages',
                'Delivery tracking, templates & segments'] },
    { flag: 'allowCRM', paths: ['/lead-crm'],
      title: 'Leads CRM', icon: 'person_add',
      bullets: ['Capture & organise every enquiry',
                'Visual new → trial → won pipeline',
                'Follow-up reminders & source analytics'] },
    { flag: 'allowAdvancedAnalytics',
      paths: ['/bi', '/business-dashboard', '/executive-dashboard', '/retention'],
      title: 'Analytics Ecosystem', icon: 'monitoring',
      bullets: ['Revenue, churn & retention dashboards',
                'Renewal forecasting & projections',
                'Member growth & cohort insights'] }
  ];

  function renderWizard(lock) {
    if (document.getElementById('gf-plan-gate-overlay')) return;

    var bullets = lock.bullets.map(function (b) {
      return '<li style="display:flex;gap:10px;align-items:flex-start;margin:0 0 10px">' +
        '<span class="material-symbols-outlined" style="font-size:18px;color:#50e3a4;flex-shrink:0">check_circle</span>' +
        '<span style="font-size:13.5px;line-height:1.45;color:#c2c7d4">' + b + '</span></li>';
    }).join('');

    // Fixed, non-bypassable frosted mask over the whole viewport (the locked
    // workspace stays rendered underneath) + a centered upsell card. The wrapper
    // itself captures pointer events so the blurred module can't be used.
    var wrap = document.createElement('div');
    wrap.id = 'gf-plan-gate-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;' +
      'padding:24px;background:rgba(255,255,255,.40);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
      'font-family:inherit;';

    wrap.innerHTML =
      '<div style="max-width:460px;width:100%;background:rgba(18,20,28,.98);border:1px solid rgba(140,170,255,.4);' +
      'border-radius:22px;padding:30px;box-shadow:0 28px 80px rgba(0,0,0,.55);text-align:center">' +
        '<div style="width:66px;height:66px;border-radius:18px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(140,170,255,.14);border:1px solid rgba(140,170,255,.34)">' +
          '<span class="material-symbols-outlined" style="font-size:34px;color:#8caaff">' + lock.icon + '</span>' +
        '</div>' +
        '<h2 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#eef0f6">✨ Unlock Pro ' + lock.title + '</h2>' +
        '<p style="margin:0 0 18px;font-size:13.5px;line-height:1.5;color:#aab2c4">' +
          'This workspace is part of the Pro plan. Here\'s what you unlock:</p>' +
        '<ul style="list-style:none;padding:0;margin:0 0 22px;text-align:left">' + bullets + '</ul>' +
        '<a href="/settings#subscription-plan" style="display:flex;align-items:center;justify-content:center;gap:8px;' +
        'text-decoration:none;background:#5b7cff;color:#fff;font-weight:700;font-size:14.5px;padding:13px 22px;border-radius:13px;box-sizing:border-box">' +
          '<span class="material-symbols-outlined" style="font-size:19px">rocket_launch</span> Upgrade to Pro Tier Subscription</a>' +
        '<a href="/dashboard" style="display:block;margin-top:14px;text-decoration:none;font-size:13px;color:#8b93a7">Back to Dashboard</a>' +
      '</div>';

    var mount = function () {
      document.body.appendChild(wrap);
      // Freeze background scroll while the wizard is up.
      document.body.style.overflow = 'hidden';
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }

  function apply(limits) {
    if (!limits) return;
    var path = (window.location.pathname || '').replace(/\/+$/, '') || '/';
    for (var i = 0; i < LOCKS.length; i++) {
      var lock = LOCKS[i];
      if (limits[lock.flag]) continue;          // feature allowed
      if (lock.paths.indexOf(path) !== -1) { renderWizard(lock); return; }
    }
  }

  function load() {
    if (!window.api || !window.api.get) return;
    window.api.get('/subscription/status').then(function (data) {
      window.__gymPlan = data || null;
      apply(data && data.limits);
    }).catch(function () { /* fail-open — never lock the user out on error */ });
  }

  window.GymPlanGate = { reload: load, apply: apply };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
