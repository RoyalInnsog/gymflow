---
name: Kinetic Enterprise
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#3a3939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#c3c5d8'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#8d90a1'
  outline-variant: '#434655'
  surface-tint: '#b5c4ff'
  primary: '#b5c4ff'
  on-primary: '#00297b'
  primary-container: '#2d6aff'
  on-primary-container: '#ffffff'
  inverse-primary: '#0051e0'
  secondary: '#4edea3'
  on-secondary: '#003824'
  secondary-container: '#00a572'
  on-secondary-container: '#00311f'
  tertiary: '#ffb95f'
  on-tertiary: '#472a00'
  tertiary-container: '#a66900'
  on-tertiary-container: '#ffffff'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#dbe1ff'
  primary-fixed-dim: '#b5c4ff'
  on-primary-fixed: '#00164d'
  on-primary-fixed-variant: '#003cac'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#ffddb8'
  tertiary-fixed-dim: '#ffb95f'
  on-tertiary-fixed: '#2a1700'
  on-tertiary-fixed-variant: '#653e00'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  display-lg:
    fontFamily: Hanken Grotesk
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Hanken Grotesk
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  title-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  headline-lg-mobile:
    fontFamily: Hanken Grotesk
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 24px
  margin: 32px
  container-max: 1440px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 24px
---

## Brand & Style

The design system is engineered for **Kinetic Enterprise**, a high-performance CRM tailored for the premium Indian fitness sector. The aesthetic balances the rigorous utility of enterprise software with the high-octane energy of modern fitness. 

The visual direction is **Dark Minimalist / Technical Glassmorphism**. It draws inspiration from industry-leading tools like Linear and Stripe, prioritizing information density without sacrificing clarity. The interface should feel expensive, precise, and authoritative. Every interaction must reinforce a sense of elite performance through subtle motion, depth, and a strict adherence to a technical grid.

The target audience consists of enterprise gym owners and high-end facility managers who require a tool that reflects the premium nature of their own services.

## Colors

The palette is anchored in a **Deep Enterprise Dark** scheme. The background architecture uses three tiers of depth:
- **Surface Lowest (#0A0A0A):** The canvas/body background.
- **Surface Low (#121212):** Primary container background for cards and sidebars.
- **Surface Medium (#1B1B1B):** Secondary containers, modals, or active states.
- **Surface Variant (#242424):** Used for subtle hover states or tertiary nested elements.

**Accents:**
- **Electric Blue:** The primary driver of action and focus.
- **Emerald Green:** Reserved for "Active" status, successful payments, and positive growth metrics.
- **Orange:** Warning indicators for expiring memberships or pending documents.
- **Crimson:** Critical alerts, overdue payments, and system errors.

All currency displays must utilize the **₹ (Indian Rupee)** symbol and follow the **Lakh/Crore numbering system** (e.g., ₹10,50,000).

## Typography

This design system utilizes a dual-font strategy. **Hanken Grotesk** is employed for headlines to provide a sharp, modern, and high-end feel. **Inter** handles all body copy, labels, and data-heavy tables to ensure maximum legibility and a systematic, utilitarian appearance.

Hierarchy is enforced through weight rather than just size. Display styles should use tighter letter spacing for a "locked-in" look. All numerical data in tables should utilize tabular figures to ensure easy vertical scanning of membership fees and attendance counts.

## Layout & Spacing

The layout follows a **12-column fluid grid** for desktop and a **4-column grid** for mobile. We utilize a strict **4px/8px baseline grid** to maintain mathematical harmony.

- **Desktop (1200px+):** 24px gutters, 32px margins. Sidebars are fixed at 240px or 280px depending on context.
- **Tablet (768px - 1199px):** 16px gutters, 24px margins. Content may reflow to a 2-column card layout.
- **Mobile (<767px):** 12px gutters, 16px margins. Bottom navigation replaces sidebars for easier accessibility.

Spacing should be generous to maintain the "premium" feel. Use `stack-lg` for separating major sections and `stack-sm` for related internal components.

## Elevation & Depth

Depth is established through **Glassmorphism** and **Tonal Layering** rather than traditional heavy shadows.

- **Background Surfaces:** Use flat hex codes (#0A0A0A) for the base layer.
- **Floating Containers (Cards/Modals):** Implement a semi-transparent fill (`rgba(27, 27, 27, 0.7)`) with a **12px to 20px Backdrop Blur**.
- **Outlines:** Every elevated element must feature a **1px subtle border** (`#ffffff10` or `outline_low`) to define its edges against the dark background.
- **Shadows:** Only used for primary modals or dropdowns. Use highly diffused, low-opacity shadows (e.g., `0 10px 40px rgba(0, 0, 0, 0.5)`) to mimic ambient occlusion.

## Shapes

The shape language is sophisticated and consistent. We use a **Rounded** philosophy:
- **Small Elements (Inputs, Buttons, Tags):** 0.5rem (8px) corner radius.
- **Standard Containers (Cards, Table wrappers):** 1rem (16px) corner radius.
- **Interactive Layers:** Active states on list items use a 0.75rem (12px) radius.

Shapes should remain crisp. Avoid full-pill shapes unless used for specific status chips to differentiate them from actionable buttons.

## Components

- **Buttons:** Primary buttons use a solid Electric Blue fill with white text. Secondary buttons are "Ghost" style with a 1px border and 0.05 opacity fill.
- **Input Fields:** Dark backgrounds (#121212) with a 1px border. Focus state triggers a subtle Blue outer glow and a border color shift to Electric Blue.
- **Cards:** Must utilize the glassmorphism tokens. Padding should be a minimum of 24px. Header sections within cards should have a subtle 1px bottom border divider.
- **Active Indicators:** Side navigation or list selection is indicated by a 2px wide vertical bar of Electric Blue (`active-indicator`) aligned to the left edge of the item, combined with a subtle surface-variant background.
- **Data Visualization:** Charts use glow effects. Line charts should feature a gradient stroke that fades toward the baseline. Grid lines must be kept at a minimum opacity (`0.03`).
- **Chips/Status:** Use the semantic colors (Green, Orange, Crimson) with a 0.1 opacity background and solid 1px border for high-end legibility.