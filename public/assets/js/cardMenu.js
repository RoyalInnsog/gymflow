/* =====================================================================
 * Gym Flow — Reusable Card Context Menu  (window.GymCardMenu)
 * ---------------------------------------------------------------------
 * A single, global handler for the 3-dot (more_vert / more_horiz) context
 * actions that appear on dashboard cards, list rows and table rows across
 * the app. Previously each of these buttons was inert — this makes every
 * one a proper dropdown with a single, consistent implementation.
 *
 * Markup convention (fully declarative — no per-page JS required):
 *
 *   <div class="gf-card-menu" data-card-menu>
 *     <button type="button" class="gf-card-menu-trigger" aria-haspopup="true"
 *             aria-expanded="false" aria-label="More actions">
 *       <span class="material-symbols-outlined">more_vert</span>
 *     </button>
 *     <div class="gf-card-menu-panel" role="menu">
 *       <button role="menuitem" onclick="...">…</button>
 *       <button role="menuitem" class="gf-danger" onclick="...">…</button>
 *     </div>
 *   </div>
 *
 * Design decisions:
 *  • The trigger is handled in the CAPTURE phase so stopPropagation() lands
 *    BEFORE any clickable ancestor card (e.g. KPI cards with an onclick
 *    drill-down) — a bubble-phase listener would fire the card first. This is
 *    the core of TASK 2 fix #2.
 *  • Only ONE menu is open at a time; opening one closes the rest (isOpen).
 *  • The panel is positioned with position:fixed computed from the trigger's
 *    rect, so it escapes any `overflow-hidden` card and every ancestor
 *    stacking context — it always paints above the card body (z-index).
 *  • Outside click, Escape, scroll and resize all dismiss the open menu.
 * ===================================================================== */
(function () {
  'use strict';
  if (window.GymCardMenu) return;

  var openMenu = null;

  function panelOf(menu) { return menu && menu.querySelector('.gf-card-menu-panel'); }
  function triggerOf(menu) { return menu && menu.querySelector('.gf-card-menu-trigger'); }

  function place(menu) {
    var trigger = triggerOf(menu);
    var panel = panelOf(menu);
    if (!trigger || !panel) return;
    // Measure while visible-but-transparent (class is already applied).
    var r = trigger.getBoundingClientRect();
    var pw = panel.offsetWidth || 200;
    var ph = panel.offsetHeight || 160;
    var gap = 6;
    var vw = window.innerWidth, vh = window.innerHeight;

    // Prefer right-aligned to the trigger; clamp into the viewport.
    var left = Math.min(Math.max(8, r.right - pw), vw - pw - 8);
    // Prefer below; flip above if it would overflow the bottom edge.
    var top = r.bottom + gap;
    if (top + ph > vh - 8 && r.top - gap - ph > 8) top = r.top - gap - ph;
    top = Math.min(Math.max(8, top), vh - ph - 8);

    panel.style.position = 'fixed';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function close(menu) {
    if (!menu) return;
    menu.classList.remove('gf-open');
    var t = triggerOf(menu);
    if (t) t.setAttribute('aria-expanded', 'false');
    if (openMenu === menu) openMenu = null;
  }

  function closeAll() { if (openMenu) close(openMenu); }

  function open(menu) {
    if (openMenu && openMenu !== menu) close(openMenu);
    menu.classList.add('gf-open');
    var t = triggerOf(menu);
    if (t) t.setAttribute('aria-expanded', 'true');
    openMenu = menu;
    // Place after the panel is laid out so measurements are correct.
    place(menu);
    // A second pass on the next frame catches late layout (fonts/icons).
    window.requestAnimationFrame(function () { if (openMenu === menu) place(menu); });
  }

  // ── Trigger: CAPTURE phase so we can stop the click before a parent card
  //    onclick (drill-down / navigation) ever sees it.
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest && e.target.closest('.gf-card-menu-trigger');
    if (!trigger) return;
    var menu = trigger.closest('[data-card-menu]');
    if (!menu) return;
    e.preventDefault();
    e.stopPropagation();
    if (menu.classList.contains('gf-open')) close(menu);
    else open(menu);
  }, true);

  // ── Bubble phase: outside-click dismissal + close-after-action.
  document.addEventListener('click', function (e) {
    var withinMenu = e.target.closest && e.target.closest('[data-card-menu]');
    if (withinMenu) {
      // A click on an actual menu item (inside the panel) runs its own handler
      // first (bubble), then we dismiss. Clicks elsewhere in the container
      // (e.g. the trigger, already handled in capture) are ignored here.
      if (e.target.closest('.gf-card-menu-panel')) closeAll();
      return;
    }
    closeAll();
  }, false);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') closeAll();
  });

  // Any scroll (capture — catches scrollable ancestors) or resize invalidates
  // the fixed position, so the simplest correct behaviour is to dismiss.
  window.addEventListener('scroll', function () { closeAll(); }, true);
  window.addEventListener('resize', function () { closeAll(); });

  window.GymCardMenu = { closeAll: closeAll, close: close, open: open, reposition: function () { if (openMenu) place(openMenu); } };
})();
