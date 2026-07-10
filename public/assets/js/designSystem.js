/**
 * JSB Fitness — Design System & Application Configuration
 * ========================================================
 * SINGLE SOURCE OF TRUTH for: branding, navigation, currency,
 * Tailwind theme tokens, and shared UI rendering.
 *
 * Every page must load this file BEFORE tailwindcss CDN script.
 * Usage: <script src="/assets/js/designSystem.js"></script>
 */

(function () {
  'use strict';

  // Apply theme immediately to prevent FOUC
  (function initTheme() {
    const savedTheme = localStorage.getItem('gymflow-theme') || 'system';
    let themeToApply = savedTheme;
    if (savedTheme === 'system') {
      const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      themeToApply = systemPrefersDark ? 'dark' : 'light';
    }
    const docEl = document.documentElement;
    if (themeToApply === 'dark') {
      docEl.classList.add('dark');
      docEl.classList.remove('light');
    } else {
      docEl.classList.add('light');
      docEl.classList.remove('dark');
    }
    
    // Listen for OS preference changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
      if ((localStorage.getItem('gymflow-theme') || 'system') === 'system') {
        const applyDark = e.matches;
        if (applyDark) {
          docEl.classList.add('dark');
          docEl.classList.remove('light');
        } else {
          docEl.classList.add('light');
          docEl.classList.remove('dark');
        }
      }
    });
  })();

  // ─── BRAND CONFIG ──────────────────────────────────────
  const brand = {
    name: 'Gym Flow',
    nameUpper: 'GYM FLOW',
    facility: 'Gym Flow',
    tagline: 'Premium Gym Management',
    version: 'v4.2.1',
    icon: 'fitness_center',
    owner: 'Admin',
    ownerInitials: 'A',
    ownerRole: 'Admin',
    ownerPhoto: ''
  };

  // ─── CURRENCY CONFIG ───────────────────────────────────
  const currencyConfig = {
    code: 'INR',
    locale: 'en-IN',
    symbol: '₹'
  };

  const rupeeFormatter = new Intl.NumberFormat(currencyConfig.locale, {
    style: 'currency',
    currency: currencyConfig.code,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });

  const numberFormatter = new Intl.NumberFormat(currencyConfig.locale);

  const currency = {
    ...currencyConfig,
    format: function (value) {
      return rupeeFormatter.format(Number(value || 0));
    },
    formatCompact: function (value) {
      var amount = Number(value || 0);
      if (amount >= 10000000) return '₹' + (amount / 10000000).toFixed(1).replace('.0', '') + 'Cr';
      if (amount >= 100000) return '₹' + (amount / 100000).toFixed(1).replace('.0', '') + 'L';
      if (amount >= 1000) return '₹' + Math.round(amount / 1000) + 'k';
      return '₹' + numberFormatter.format(amount);
    },
    formatNumber: function (value) {
      return numberFormatter.format(Number(value || 0));
    }
  };

  // ─── NAVIGATION CONFIG ─────────────────────────────────
  // mobileSlot: 1-5 = fixed bottom bar position. 0 = inside "More" sheet.
  var NAV_ITEMS = [
    { id: 'nav-dashboard',  label: 'Dashboard',           icon: 'dashboard',    href: '/dashboard',     mobileSlot: 1,  aliases: ['/'] },
    { id: 'nav-members',    label: 'Members',             icon: 'group',        href: '/members',       mobileSlot: 2,  aliases: ['/member-profile','/member-timeline','/member-communication','/member-qr','/add-member','/add-member-step-1'] },
    { id: 'nav-crm',        label: 'Lead CRM',            icon: 'person_add',   href: '/lead-crm',      mobileSlot: 0 },
    // [NAV] Attendance promoted to first-class bottom-dock slot 4 (was overflow).
    { id: 'nav-attendance', label: 'Attendance',          icon: 'event_available', href: '/attendance',  mobileSlot: 4,  aliases: ['/attendance/logs', '/attendance/summary'] },
    { id: 'nav-finance',    label: 'Payments & Finance',  mobileLabel: 'Finance', icon: 'payments',   href: '/finance',       mobileSlot: 3,  aliases: ['/payment-center','/renew','/receipt'] },
    { id: 'nav-closing',    label: 'Closing Reports',     icon: 'receipt_long',  href: '/daily-closing', mobileSlot: 0 },
    { id: 'nav-marketing',  label: 'Marketing Center',    icon: 'campaign',     href: '/marketing',     mobileSlot: 0 },
    // [NAV] Tasks relocated out of the bottom dock into the "More" drawer (slot 0).
    { id: 'nav-tasks',      label: 'Tasks',               icon: 'assignment',   href: '/tasks',         mobileSlot: 0 },
    { id: 'nav-bi',          label: 'Analytics',           icon: 'monitoring',   href: '/bi',            mobileSlot: 0,  aliases: ['/business-dashboard','/executive-dashboard','/retention','/expiry-management'] },
    { id: 'nav-settings',   label: 'Settings',            icon: 'settings',     href: '/settings',      mobileSlot: 5,  aliases: ['/staff','/equipment','/notifications'] }
  ];

  // ─── TAILWIND CANONICAL CONFIG ─────────────────────────
  var tailwindConfig = {
    darkMode: 'class',
    theme: {
      extend: {
        colors: {
          'background':                'var(--background)',
          'surface':                   'var(--surface)',
          'surface-dim':               'var(--surface-dim)',
          'surface-bright':            'var(--surface-bright)',
          'surface-container-lowest':  'var(--surface-container-lowest)',
          'surface-container-low':     'var(--surface-container-low)',
          'surface-container':         'var(--surface-container)',
          'surface-container-high':    'var(--surface-container-high)',
          'surface-container-highest': 'var(--surface-container-highest)',
          'surface-variant':           'var(--surface-variant)',
          'surface-tint':              'var(--surface-tint)',
          'on-surface':                'var(--on-surface)',
          'on-surface-variant':        'var(--on-surface-variant)',
          'on-background':             'var(--on-background)',
          'outline':                   'var(--outline)',
          'outline-variant':           'var(--outline-variant)',
          'primary':                   'var(--color-primary, #16c8ee)',
          'primary-container':         'var(--color-primary-container, #0a3d4a)',
          'primary-fixed':             'var(--color-primary-fixed, #b5c4ff)',
          'primary-fixed-dim':         'var(--color-primary-fixed-dim, #8fa8ff)',
          'primary-strong':            'var(--color-primary-strong, #2f6bff)',
          'on-primary':                'var(--color-on-primary, #041012)',
          'on-primary-container':      'var(--color-on-primary-container, #c2efff)',
          'on-primary-fixed':          'var(--color-on-primary-fixed, #00164d)',
          'on-primary-fixed-variant':  'var(--color-on-primary-fixed-variant, #003cac)',
          'inverse-primary':           'var(--color-inverse-primary, #006880)',
          'secondary':                 'var(--color-secondary, #50e3a4)',
          'secondary-container':       'var(--color-secondary-container, #00a572)',
          'secondary-fixed':           'var(--color-secondary-fixed, #6ffbbe)',
          'secondary-fixed-dim':       'var(--color-secondary-fixed-dim, #4edea3)',
          'on-secondary':              'var(--color-on-secondary, #003824)',
          'on-secondary-container':    'var(--color-on-secondary-container, #c2ffe0)',
          'on-secondary-fixed':        'var(--color-on-secondary-fixed, #002113)',
          'on-secondary-fixed-variant':'var(--color-on-secondary-fixed-variant, #005236)',
          'tertiary':                  'var(--color-tertiary, #ffbf62)',
          'tertiary-container':        'var(--color-tertiary-container, #a66900)',
          'tertiary-fixed':            'var(--color-tertiary-fixed, #ffddb8)',
          'tertiary-fixed-dim':        'var(--color-tertiary-fixed-dim, #ffb95f)',
          'on-tertiary':               'var(--color-on-tertiary, #472a00)',
          'on-tertiary-container':     'var(--color-on-tertiary-container, #ffddb8)',
          'on-tertiary-fixed':         'var(--color-on-tertiary-fixed, #2a1700)',
          'on-tertiary-fixed-variant': 'var(--color-on-tertiary-fixed-variant, #653e00)',
          'error':                     'var(--color-error, #ffaaa3)',
          'error-container':           'var(--color-error-container, #93000a)',
          'on-error':                  'var(--color-on-error, #690005)',
          'on-error-container':        'var(--color-on-error-container, #ffdad6)',
          'inverse-surface':           'var(--color-inverse-surface, #e5e2e1)',
          'inverse-on-surface':        'var(--color-inverse-on-surface, #313030)'
        },
        borderRadius: {
          DEFAULT: '0.5rem',
          lg:      '0.5rem',
          xl:      '0.75rem',
          full:    '9999px'
        },
        spacing: {
          'stack-lg':      '24px',
          'stack-md':      '16px',
          'stack-sm':      '8px',
          'unit':          '4px',
          'margin':        '32px',
          'margin-mobile': '16px',
          'margin-desktop':'48px',
          'container-max': '1440px',
          'gutter':        '24px',
          'xs':            '8px',
          'sm':            '16px',
          'md':            '24px',
          'lg':            '40px',
          'xl':            '64px',
          'base':          '4px'
        },
        fontFamily: {
          body:     ['Inter', 'sans-serif'],
          headline: ['Inter', 'sans-serif'],
          mono:     ['JetBrains Mono', 'monospace']
        },
        fontSize: {
          'headline-xl':  ['36px', { lineHeight: '44px', letterSpacing: '-0.022em', fontWeight: '800' }],
          'headline-lg':  ['30px', { lineHeight: '38px', letterSpacing: '-0.019em', fontWeight: '800' }],
          // Mobile-sized page title. Screens pair it as:
          // class="text-headline-lg-mobile md:text-headline-lg"
          'headline-lg-mobile': ['24px', { lineHeight: '32px', letterSpacing: '-0.015em', fontWeight: '800' }],
          'headline-md':  ['24px', { lineHeight: '32px', letterSpacing: '-0.015em', fontWeight: '700' }],
          'headline-sm':  ['20px', { lineHeight: '28px', letterSpacing: '-0.012em', fontWeight: '700' }],
          'title-lg':     ['18px', { lineHeight: '26px', letterSpacing: '-0.01em',  fontWeight: '700' }],
          'title-md':     ['16px', { lineHeight: '24px', letterSpacing: '-0.006em', fontWeight: '600' }],
          'body-lg':      ['16px', { lineHeight: '24px', letterSpacing: '0',        fontWeight: '400' }],
          'body-md':      ['14px', { lineHeight: '22px', letterSpacing: '0',        fontWeight: '400' }],
          'body-sm':      ['13px', { lineHeight: '19px', letterSpacing: '0',        fontWeight: '400' }],
          'label-md':     ['12px', { lineHeight: '16px', letterSpacing: '0',        fontWeight: '600' }],
          'label-caps':   ['11px', { lineHeight: '16px', letterSpacing: '0.05em',   fontWeight: '600' }],
          'label-sm':     ['12px', { lineHeight: '16px', letterSpacing: '0',        fontWeight: '500' }],
          'display-lg':   ['48px', { lineHeight: '56px', letterSpacing: '-0.02em', fontWeight: '700' }],
          // KPI / stat values (dashboard cards). Sized to survive
          // ₹-lakh figures inside a ~340px card on phones.
          'display-md':   ['40px', { lineHeight: '48px', letterSpacing: '-0.02em', fontWeight: '800' }]
        },
        boxShadow: {
          panel: '0 20px 70px rgba(0, 0, 0, 0.32)'
        }
      }
    }
  };

  // Apply Tailwind config globally BEFORE CDN processes
  window.tailwind = window.tailwind || {};
  window.tailwind.config = tailwindConfig;

  // ─── NAVIGATION RENDERER ──────────────────────────────
  function getActiveNavId() {
    var path = window.location.pathname;
    for (var i = 0; i < NAV_ITEMS.length; i++) {
      var item = NAV_ITEMS[i];
      if (item.href === path) return item.id;
      if (item.aliases) {
        for (var j = 0; j < item.aliases.length; j++) {
          if (item.aliases[j] === path) return item.id;
        }
      }
    }
    return '';
  }

  function renderDesktopSidebar() {
    var activeId = getActiveNavId();
    var navLinksHtml = '';
    for (var i = 0; i < NAV_ITEMS.length; i++) {
      var item = NAV_ITEMS[i];
      var isActive = item.id === activeId;
      var activeClasses = isActive
        ? 'bg-primary/10 border-l-2 border-primary text-primary'
        : 'text-on-surface-variant hover:bg-surface-container-high';
      var fillStyle = isActive ? "font-variation-settings: 'FILL' 1;" : '';
      navLinksHtml += '<a class="nav-item flex items-center gap-3 px-4 py-3 rounded-lg transition-all group ' + activeClasses + '" href="' + item.href + '" id="' + item.id + '">'
        + '<span class="material-symbols-outlined group-hover:text-primary transition-colors" style="' + fillStyle + '">' + item.icon + '</span>'
        + '<span class="font-body-md text-body-md font-medium sidebar-text">' + item.label + '</span>'
        + '</a>';
    }

    return '<nav class="desktop-sidebar bg-surface-container-low h-full w-[280px] fixed left-0 top-0 z-[60] border-r border-white/10 shadow-2xl flex-col py-6 hidden md:flex">'
      + '<div class="flex items-center justify-between px-6 mb-8 logo-container">'
      // Brand mark is a HOME affordance: always navigates to Dashboard.
      // Sidebar collapse stays on the dedicated button beside it.
      +   '<a href="/dashboard" aria-label="Go to Dashboard" class="flex items-center gap-3">'
      +     '<span class="material-symbols-outlined text-primary text-[28px]">' + brand.icon + '</span>'
      +     '<span class="font-headline text-headline-md font-bold text-primary tracking-tight logo-text">' + brand.name + '</span>'
      +   '</a>'
      +   '<button onclick="window.APP_CONFIG.toggleSidebar()" class="text-on-surface-variant hover:text-primary transition-colors hidden md:block" id="sidebar-collapse-btn">'
      +     '<span class="material-symbols-outlined" id="collapse-icon">menu_open</span>'
      +   '</button>'
      + '</div>'
      + '<div class="px-6 mb-6 flex items-center gap-3 profile-container">'
      +   '<div class="w-10 h-10 rounded-full overflow-hidden border border-outline-variant shrink-0 bg-surface-container flex items-center justify-center text-primary font-bold">'
      +     '<img alt="' + brand.owner + '" class="w-full h-full object-cover" src="' + brand.ownerPhoto + '" onerror="this.style.display=\'none\'; this.nextElementSibling.style.display=\'flex\';">'
      +     '<span class="hidden w-full h-full items-center justify-center text-body-md font-bold bg-primary/10 text-primary">' + brand.ownerInitials + '</span>'
      +   '</div>'
      +   '<div class="profile-details overflow-hidden">'
      +     '<p class="text-title-lg text-on-surface truncate">' + brand.owner + '</p>'
      +     '<p class="text-label-md text-on-surface-variant truncate">' + brand.facility + '</p>'
      +     '<span class="inline-block mt-0.5 px-2 py-0.5 rounded bg-primary/10 text-primary text-label-md border border-primary/20 role-badge">' + brand.ownerRole + '</span>'
      +   '</div>'
      + '</div>'
      + '<div class="flex-1 overflow-y-auto hide-scrollbar space-y-1 px-2">'
      +   navLinksHtml
      + '</div>'
      + '</nav>';
  }

  function renderMobileBottomNav() {
    var activeId = getActiveNavId();
    // Collect items for slots 1-5
    var slotItems = [];
    var overflowItems = [];
    for (var i = 0; i < NAV_ITEMS.length; i++) {
      if (NAV_ITEMS[i].mobileSlot > 0) {
        slotItems.push(NAV_ITEMS[i]);
      } else {
        overflowItems.push(NAV_ITEMS[i]);
      }
    }
    slotItems.sort(function(a,b){ return a.mobileSlot - b.mobileSlot; });

    // Replace last slot (Settings at 5) with "More" button if overflow items exist
    var showMore = overflowItems.length > 0;

    var barHtml = '';
    for (var k = 0; k < slotItems.length; k++) {
      var item = slotItems[k];
      // If this is the last slot and we have overflow, render "More" instead
      if (showMore && item.mobileSlot === 5) {
        // Render the actual item but also add More
        var isActive = item.id === activeId;
        var activeClass = isActive ? 'text-primary' : 'text-on-surface-variant';
        var fillStyle = isActive ? "font-variation-settings: 'FILL' 1;" : "font-variation-settings: 'FILL' 0;";
        barHtml += '<a class="flex flex-col items-center justify-center ' + activeClass + ' hover:bg-white/5 active:scale-90 transition-all w-16 h-full" href="' + item.href + '">'
          + '<span class="material-symbols-outlined text-[22px]" style="' + fillStyle + '">' + item.icon + '</span>'
          + '<span class="text-[10px] mt-0.5 font-medium whitespace-nowrap">' + (item.mobileLabel || item.label) + '</span>'
          + '</a>';
        // Check if any overflow item is active
        var overflowActive = false;
        for (var m = 0; m < overflowItems.length; m++) {
          if (overflowItems[m].id === activeId) { overflowActive = true; break; }
        }
        var moreClass = overflowActive ? 'text-primary' : 'text-on-surface-variant';
        barHtml += '<button class="flex flex-col items-center justify-center ' + moreClass + ' hover:bg-white/5 active:scale-90 transition-all w-16 h-full" onclick="window.APP_CONFIG.toggleMobileMore()" id="mobile-more-btn">'
          + '<span class="material-symbols-outlined text-[22px]" style="font-variation-settings: \'FILL\' 0;">more_horiz</span>'
          + '<span class="text-[10px] mt-0.5 font-medium">More</span>'
          + '</button>';
      } else {
        var isActive2 = item.id === activeId;
        var activeClass2 = isActive2 ? 'text-primary' : 'text-on-surface-variant';
        var fillStyle2 = isActive2 ? "font-variation-settings: 'FILL' 1;" : "font-variation-settings: 'FILL' 0;";
        barHtml += '<a class="flex flex-col items-center justify-center ' + activeClass2 + ' hover:bg-white/5 active:scale-90 transition-all w-16 h-full" href="' + item.href + '">'
          + '<span class="material-symbols-outlined text-[22px]" style="' + fillStyle2 + '">' + item.icon + '</span>'
          + '<span class="text-[10px] mt-0.5 font-medium whitespace-nowrap">' + (item.mobileLabel || item.label) + '</span>'
          + '</a>';
      }
    }

    // Build overflow sheet
    var overflowHtml = '';
    if (showMore) {
      var overflowLinks = '';
      for (var n = 0; n < overflowItems.length; n++) {
        var oi = overflowItems[n];
        var oiActive = oi.id === activeId;
        var oiClass = oiActive ? 'text-primary bg-primary/10' : 'text-on-surface-variant hover:bg-surface-container-high';
        overflowLinks += '<a class="flex items-center gap-3 px-4 py-3 rounded-lg transition-all ' + oiClass + '" href="' + oi.href + '">'
          + '<span class="material-symbols-outlined">' + oi.icon + '</span>'
          + '<span class="text-body-md font-medium">' + oi.label + '</span>'
          + '</a>';
      }
      overflowHtml = '<div id="mobile-more-sheet" class="fixed inset-0 z-[100] hidden" onclick="window.APP_CONFIG.toggleMobileMore()">'
        + '<div class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>'
        + '<div class="absolute bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] left-0 right-0 bg-surface-container-low border-t border-white/10 rounded-t-2xl p-4 space-y-1 shadow-2xl" onclick="event.stopPropagation()">'
        +   '<p class="text-label-md text-on-surface-variant uppercase tracking-wider px-4 pb-2">More Features</p>'
        +   overflowLinks
        + '</div>'
        + '</div>';
    }

    return overflowHtml
      + '<nav class="jsb-bottom-nav md:hidden fixed bottom-0 left-0 right-0 z-50 flex justify-around items-center min-h-[4rem] px-2 bg-[#111111]/90 backdrop-blur-xl border-t border-white/10 shadow-[0_-4px_20px_rgba(0,0,0,0.5)]">'
      + barHtml
      + '</nav>';
  }

  function renderHeader(pageTitle) {
    return '<header class="bg-background/70 backdrop-blur-xl fixed top-0 left-0 right-0 z-50 border-b border-white/10 shadow-sm flex justify-between items-center px-4 md:px-8 h-16 md:ml-[280px] transition-all duration-300">'
      + '<a href="/dashboard" aria-label="Go to Dashboard" class="flex items-center gap-3 md:hidden">'
      +   '<img src="/assets/img/app_logo.png" class="h-8 w-8 object-contain rounded shrink-0" alt="Gym Flow Logo">'
      +   '<span class="text-headline-md font-bold text-primary tracking-tight">Gym Flow</span>'
      + '</a>'
      + '<div class="hidden md:block">'
      +   (pageTitle ? '<p class="text-body-md text-on-surface-variant">' + pageTitle + '</p>' : '')
      + '</div>'
      + '<div class="flex items-center gap-2">'
      +   '<button class="w-10 h-10 flex items-center justify-center rounded-full hover:bg-surface-variant transition-colors text-on-surface-variant hover:text-primary" onclick="window.location.href=\'/notifications\'">'
      +     '<span class="material-symbols-outlined" style="font-variation-settings: \'FILL\' 0;">notifications</span>'
      +   '</button>'
      + '</div>'
      + '</header>';
  }

  function renderBackButton(label, href) {
    return '<a href="' + href + '" class="inline-flex items-center gap-1 text-on-surface-variant hover:text-primary transition-colors mb-4 text-body-md">'
      + '<span class="material-symbols-outlined text-[20px]">arrow_back</span>'
      + '<span>' + (label || 'Back') + '</span>'
      + '</a>';
  }

  // ─── SIDEBAR COLLAPSE ─────────────────────────────────
  function toggleSidebar() {
    var isCollapsed = document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem('sidebarCollapsed', isCollapsed ? 'true' : 'false');
    var icon = document.getElementById('collapse-icon');
    if (icon) icon.innerText = isCollapsed ? 'menu' : 'menu_open';
  }

  function toggleMobileMore() {
    var sheet = document.getElementById('mobile-more-sheet');
    if (sheet) sheet.classList.toggle('hidden');
  }

  // ─── INITIALIZATION ────────────────────────────────────
  // Apply sidebar collapsed state from localStorage immediately (before paint)
  if (localStorage.getItem('sidebarCollapsed') === 'true') {
    document.documentElement.classList.add('sidebar-collapsed-init');
  }

  // ─── THEME CONFIG & APIs ───────────────────────────────
  function getTheme() {
    return localStorage.getItem('gymflow-theme') || 'system';
  }

  function setTheme(theme) {
    localStorage.setItem('gymflow-theme', theme);
    applyTheme(theme);
    window.dispatchEvent(new CustomEvent('gymflow-theme-changed', { detail: { theme } }));
  }

  function applyTheme(theme) {
    let themeToApply = theme;
    if (theme === 'system') {
      const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      themeToApply = systemPrefersDark ? 'dark' : 'light';
    }
    const docEl = document.documentElement;
    if (themeToApply === 'dark') {
      docEl.classList.add('dark');
      docEl.classList.remove('light');
    } else {
      docEl.classList.add('light');
      docEl.classList.remove('dark');
    }
  }

  // ─── PUBLIC API ────────────────────────────────────────
  window.APP_CONFIG = {
    brand: brand,
    currency: currency,
    nav: NAV_ITEMS,
    tailwind: tailwindConfig,
    toggleSidebar: toggleSidebar,
    toggleMobileMore: toggleMobileMore,
    renderDesktopSidebar: renderDesktopSidebar,
    renderMobileBottomNav: renderMobileBottomNav,
    renderHeader: renderHeader,
    renderBackButton: renderBackButton,
    getActiveNavId: getActiveNavId,
    getTheme: getTheme,
    setTheme: setTheme,
    applyTheme: applyTheme
  };

  // ─── AUTO-INJECT NAVIGATION ────────────────────────────
  // This runs after DOMContentLoaded to inject nav if page has markers
  document.addEventListener('DOMContentLoaded', function() {
    // Inject desktop sidebar
    var sidebarTarget = document.getElementById('jsb-sidebar');
    if (sidebarTarget) {
      sidebarTarget.outerHTML = renderDesktopSidebar();
    }

    // Inject mobile bottom nav. Focused flows (add member, payment, renew) omit
    // the marker; flag the body so the bottom-nav padding reservation is dropped.
    var mobileTarget = document.getElementById('jsb-mobile-nav');
    if (mobileTarget) {
      mobileTarget.outerHTML = renderMobileBottomNav();
    } else {
      document.body.classList.add('no-bottom-nav');
    }

    // Inject header
    var headerTarget = document.getElementById('jsb-header');
    if (headerTarget) {
      var pageTitle = headerTarget.getAttribute('data-page-title') || '';
      headerTarget.outerHTML = renderHeader(pageTitle);
    }

    // Apply sidebar collapsed state
    if (localStorage.getItem('sidebarCollapsed') === 'true') {
      document.body.classList.add('sidebar-collapsed');
      var icon = document.getElementById('collapse-icon');
      if (icon) icon.innerText = 'menu';
    }

    // Set document title from brand
    var currentTitle = document.title || '';
    if (currentTitle && !currentTitle.startsWith(brand.name)) {
      // Extract page-specific part
      var parts = currentTitle.split(' - ');
      var pagePart = parts.length > 1 ? parts[parts.length - 1] : parts[0];
      if (pagePart.toLowerCase() !== brand.name.toLowerCase()) {
        document.title = brand.name + ' - ' + pagePart;
      }
    }

    // Auto-inject onboarding and activation script globally
    var onboardingScript = document.createElement('script');
    onboardingScript.src = '/assets/js/onboarding.js';
    document.body.appendChild(onboardingScript);

    // Auto-inject the reusable card 3-dot context-menu handler globally so any
    // card/list/table row using the [data-card-menu] convention just works.
    if (!document.querySelector('script[data-gf-card-menu]')) {
      var cardMenuScript = document.createElement('script');
      cardMenuScript.src = '/assets/js/cardMenu.js';
      cardMenuScript.setAttribute('data-gf-card-menu', '1');
      document.body.appendChild(cardMenuScript);
    }

    // Auto-inject the subscription tier gate (nav hiding + upsell on locked
    // modules). Loads after api.js is already present on the page.
    if (!document.querySelector('script[data-gf-plan-gate]')) {
      var planGateScript = document.createElement('script');
      planGateScript.src = '/assets/js/planGate.js';
      planGateScript.setAttribute('data-gf-plan-gate', '1');
      document.body.appendChild(planGateScript);
    }
  });
})();
