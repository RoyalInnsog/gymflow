/**
 * Gym Flow — Tailwind build config.
 *
 * Compiles the utilities the app actually uses into a static stylesheet
 * (public/assets/css/tailwind.css), replacing the runtime cdn.tailwindcss.com
 * Play CDN. The theme below MIRRORS window.tailwind.config in
 * public/assets/js/designSystem.js — keep the two in sync if you change tokens.
 *
 * Rebuild after editing markup/JS/tokens:  npm run build:css
 */
module.exports = {
  darkMode: 'class',
  content: [
    './*/code.html',
    './public/assets/js/*.js',
    './public/assets/js/member/*.js',
    './public/assets/js/offline/*.js',
  ],
  // Several pages build class names by string interpolation, e.g.
  //   `border-${colorClass}/20 bg-${colorClass}/5 hover:bg-${colorClass}/10 text-${colorClass}`
  // with colorClass ∈ {primary, secondary, tertiary, error} (dashboard alerts,
  // expiry groups, drill-down icons). The scanner can't see those, so safelist
  // exactly that set — nothing more, to keep the CSS lean.
  safelist: [
    {
      pattern: /^(bg|text|border)-(primary|secondary|tertiary|error)(\/(5|10|20|30|40|50))?$/,
      variants: ['hover', 'group-hover'],
    },
  ],
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
        'inverse-on-surface':        'var(--color-inverse-on-surface, #313030)',
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        lg:      '0.5rem',
        xl:      '0.75rem',
        full:    '9999px',
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
        'base':          '4px',
      },
      fontFamily: {
        body:     ['Inter', 'sans-serif'],
        headline: ['Inter', 'sans-serif'],
        mono:     ['JetBrains Mono', 'monospace'],
      },
      fontSize: {
        'headline-xl':        ['36px', { lineHeight: '44px', letterSpacing: '-0.022em', fontWeight: '800' }],
        'headline-lg':        ['30px', { lineHeight: '38px', letterSpacing: '-0.019em', fontWeight: '800' }],
        'headline-lg-mobile': ['24px', { lineHeight: '32px', letterSpacing: '-0.015em', fontWeight: '800' }],
        'headline-md':        ['24px', { lineHeight: '32px', letterSpacing: '-0.015em', fontWeight: '700' }],
        'headline-sm':        ['20px', { lineHeight: '28px', letterSpacing: '-0.012em', fontWeight: '700' }],
        'title-lg':           ['18px', { lineHeight: '26px', letterSpacing: '-0.01em',  fontWeight: '700' }],
        'title-md':           ['16px', { lineHeight: '24px', letterSpacing: '-0.006em', fontWeight: '600' }],
        'body-lg':            ['16px', { lineHeight: '24px', letterSpacing: '0',        fontWeight: '400' }],
        'body-md':            ['14px', { lineHeight: '22px', letterSpacing: '0',        fontWeight: '400' }],
        'body-sm':            ['13px', { lineHeight: '19px', letterSpacing: '0',        fontWeight: '400' }],
        'label-md':           ['12px', { lineHeight: '16px', letterSpacing: '0',        fontWeight: '600' }],
        'label-caps':         ['11px', { lineHeight: '16px', letterSpacing: '0.05em',   fontWeight: '600' }],
        'label-sm':           ['12px', { lineHeight: '16px', letterSpacing: '0',        fontWeight: '500' }],
        'display-lg':         ['48px', { lineHeight: '56px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'display-md':         ['40px', { lineHeight: '48px', letterSpacing: '-0.02em', fontWeight: '800' }],
      },
      boxShadow: {
        panel: '0 20px 70px rgba(0, 0, 0, 0.32)',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries'),
  ],
};
