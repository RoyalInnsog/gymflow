---
name: Kinetic Enterprise
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#393939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1b1b1b'
  surface-container: '#1f1f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353535'
  on-surface: '#e2e2e2'
  on-surface-variant: '#cfc4c5'
  inverse-surface: '#e2e2e2'
  inverse-on-surface: '#303030'
  outline: '#988e90'
  outline-variant: '#4c4546'
  surface-tint: '#c6c6c6'
  primary: '#c6c6c6'
  on-primary: '#303030'
  primary-container: '#000000'
  on-primary-container: '#757575'
  inverse-primary: '#5e5e5e'
  secondary: '#c8c6c5'
  on-secondary: '#313030'
  secondary-container: '#4a4949'
  on-secondary-container: '#bab8b7'
  tertiary: '#c8c6c5'
  on-tertiary: '#303030'
  tertiary-container: '#000000'
  on-tertiary-container: '#767575'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e2e2e2'
  primary-fixed-dim: '#c6c6c6'
  on-primary-fixed: '#1b1b1b'
  on-primary-fixed-variant: '#474747'
  secondary-fixed: '#e5e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1c1b1b'
  on-secondary-fixed-variant: '#474646'
  tertiary-fixed: '#e5e2e1'
  tertiary-fixed-dim: '#c8c6c5'
  on-tertiary-fixed: '#1b1b1c'
  on-tertiary-fixed-variant: '#474746'
  background: '#131313'
  on-background: '#e2e2e2'
  surface-variant: '#353535'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 40px
    fontWeight: '700'
    lineHeight: 48px
    letterSpacing: -0.02em
  headline-xl-mobile:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 8px
  sm: 16px
  md: 24px
  lg: 40px
  xl: 64px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 48px
---

## Brand & Style

The design system is engineered for a high-performance, B2B SaaS environment catering to premium gym operators and fitness franchises. The brand personality is **authoritative, precise, and sophisticated**, mirroring the discipline of elite athletic training.

The visual style is a fusion of **Modern Minimalism** and **Refined Glassmorphism**. It prioritizes deep, immersive dark surfaces to reduce eye strain during long operational hours while using light and transparency to establish a clear information hierarchy. Every element is designed to feel like a precision instrument—uncluttered, responsive, and powerful. The aesthetic draws inspiration from developer-centric tools like Linear, focusing on high-density data visualization wrapped in a premium, editorial-grade interface.

## Colors

The palette is anchored in a multi-layered dark theme to create depth without relying on traditional drop shadows.

- **Foundational Layers:** The base background is `Deep Black (#000000)`. Content containers and sidebars utilize `Charcoal (#121212)` and `Dark Gray (#1E1E1E)` to create a logical "lifting" effect.
- **Accents:** `Electric Blue (#3B82F6)` is the singular primary action color, used sparingly to draw focus to high-value interactions.
- **System Feedback:** Emerald, Orange, and Red are reserved strictly for semantic feedback (e.g., membership status, payment alerts, or capacity warnings), ensuring they remain highly visible against the dark backdrop.
- **Borders:** A consistent `Thin Border (#2A2A2A)` is used to define boundaries in the glassmorphic layers, maintaining a sharp, professional structure.

## Typography

This design system utilizes **Inter** for all primary communication due to its exceptional legibility in data-heavy SaaS interfaces. 

- **Headlines:** Use tight letter-spacing and semi-bold/bold weights to convey strength and authority.
- **Body:** Standardized on 16px for optimal readability against dark backgrounds.
- **Data Labels:** **JetBrains Mono** is introduced for small labels, IDs, and numerical data to provide a technical, high-performance feel that distinguishes static text from dynamic metrics.
- **Hierarchy:** Contrast is achieved through weight and color (using White at 100% opacity for headlines and 70% for secondary body text) rather than excessive size variance.

## Layout & Spacing

The system follows a strict **8px grid** to ensure consistency across all components.

- **Grid System:** A 12-column fluid grid is used for the main dashboard content. Gutters are fixed at 24px to provide ample "breathing room" between complex data widgets.
- **Density:** While the aesthetic is minimal, the system supports high-density views for management tasks. Padding within cards should be generous (24px) to maintain the premium feel.
- **Adaptability:** On mobile, the grid collapses to a single column with 16px side margins. Tablets utilize an 8-column grid.
- **Sectioning:** Vertical rhythm is maintained using the `lg` (40px) and `xl` (64px) spacing units to clearly separate distinct functional modules.

## Elevation & Depth

Depth is communicated through **translucency and tonal stacking** rather than heavy shadows.

- **Backdrop Blurs:** High-level surfaces (modals, dropdowns, navigation bars) use a 20px blur with a 60% opaque background color. This allows the vibrant brand colors or dashboard data to peek through, creating a sense of orientation.
- **Thin Outlines:** Every container utilizes a 1px border (`#2A2A2A`). For active or hovered states, this border transitions to a slightly lighter gray or the Electric Blue accent.
- **Stacking Logic:** 
  - Level 0: Pure Black (#000000) - Main Canvas.
  - Level 1: Charcoal (#121212) - Secondary sidebars and cards.
  - Level 2: Dark Gray (#1E1E1E) - Hovered states and nested components.
  - Level 3: Translucent Overlays - Modals and popovers with backdrop-filter.

## Shapes

The design system employs a **smooth, modern corner radius** to soften the professional dark theme.

- **Standard Elements:** Buttons, input fields, and small UI elements use a `0.5rem (8px)` radius.
- **Large Containers:** Dashboard cards and main content areas use `1rem (16px)` or `rounded-lg`.
- **Special Elements:** Avatars and notification badges use full-round "pill" shapes.
- **Consistency:** All nested elements must have a corner radius that is 4px smaller than their parent container to maintain concentric visual harmony.

## Components

- **Buttons:** Primary actions use a solid `Electric Blue` fill with white text. Secondary buttons are "Ghost" style with a `#2A2A2A` border and subtle hover transitions.
- **Input Fields:** Backgrounds are slightly darker than the card they sit on. Focus states trigger an `Electric Blue` border glow (2px).
- **Cards:** Use a 1px border and a very subtle gradient (Top-Left: `#1E1E1E` to Bottom-Right: `#121212`) to simulate a physical surface.
- **Chips/Badges:** Small, high-contrast indicators. For membership status (e.g., "Active"), use a low-opacity green background with a high-opacity green label.
- **Progress Bars:** Thin, 4px height bars for goal tracking, utilizing the `Electric Blue` for momentum and `Dark Gray` for the remaining track.
- **Data Tables:** Borderless rows with a 1px divider. Hovering over a row should apply a `#1E1E1E` background tint.