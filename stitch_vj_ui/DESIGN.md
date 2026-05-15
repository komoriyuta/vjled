---
name: Cyber-Industrial Performance Interface
colors:
  surface: '#131315'
  surface-dim: '#131315'
  surface-bright: '#39393b'
  surface-container-lowest: '#0e0e10'
  surface-container-low: '#1b1b1d'
  surface-container: '#1f1f21'
  surface-container-high: '#2a2a2c'
  surface-container-highest: '#353437'
  on-surface: '#e4e2e4'
  on-surface-variant: '#b9cacb'
  inverse-surface: '#e4e2e4'
  inverse-on-surface: '#303032'
  outline: '#849495'
  outline-variant: '#3b494b'
  surface-tint: '#00dbe9'
  primary: '#dbfcff'
  on-primary: '#00363a'
  primary-container: '#00f0ff'
  on-primary-container: '#006970'
  inverse-primary: '#006970'
  secondary: '#ddb7ff'
  on-secondary: '#490080'
  secondary-container: '#6f00be'
  on-secondary-container: '#d6a9ff'
  tertiary: '#fff4e8'
  on-tertiary: '#412d00'
  tertiary-container: '#ffd386'
  on-tertiary-container: '#7d5800'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#7df4ff'
  primary-fixed-dim: '#00dbe9'
  on-primary-fixed: '#002022'
  on-primary-fixed-variant: '#004f54'
  secondary-fixed: '#f0dbff'
  secondary-fixed-dim: '#ddb7ff'
  on-secondary-fixed: '#2c0051'
  on-secondary-fixed-variant: '#6900b3'
  tertiary-fixed: '#ffdea8'
  tertiary-fixed-dim: '#ffba20'
  on-tertiary-fixed: '#271900'
  on-tertiary-fixed-variant: '#5e4200'
  background: '#131315'
  on-background: '#e4e2e4'
  surface-variant: '#353437'
typography:
  display-lg:
    fontFamily: Hanken Grotesk
    fontSize: 40px
    fontWeight: '800'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: 0.05em
  label-caps:
    fontFamily: Hanken Grotesk
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.1em
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0em
  data-lg:
    fontFamily: JetBrains Mono
    fontSize: 18px
    fontWeight: '700'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 12px
  margin: 24px
  module-padding: 16px
  grid-cols: '12'
---

## Brand & Style

The design system is engineered for high-stakes, low-light live performance environments. It adopts a **Cyber-Industrial** aesthetic, blending the rugged reliability of high-end hardware workstations with futuristic digital overlays. The brand personality is precise, authoritative, and immersive.

Key stylistic pillars include:
- **Technological Precision:** Every pixel serves a functional purpose, mirroring the density of professional audio/visual rack gear.
- **Glassmorphism & Depth:** Utilizes layered translucency and background blurs to maintain context while focusing on active control modules.
- **Atmospheric Glow:** Subtle neon luminance is applied to active states to ensure high visibility in dark DJ booths or VJ pits.
- **Industrial Durability:** Strong structural lines and rigid container definitions evoke a sense of physical hardware.

## Colors

The palette is optimized for OLED displays and extreme low-light environments, prioritizing high-contrast functional signaling over decorative color.

- **Background (#0A0A0B):** Deepest black to minimize light bleed and maximize contrast.
- **Surface (#161618):** Low-reflectance gray for primary UI containers and module housing.
- **Primary Cyan (#00F0FF):** High-energy "Active" state indicator. Used for active deck playback, fader positions, and primary interactions.
- **AI Purple (#A855F7):** Reserved exclusively for generative AI features, beat-matching suggestions, and automated visual synthesis.
- **Alert Amber (#FFB800):** Warning state for clipping, dropped frames, or hardware disconnects.
- **Border (#2D2D30):** Defines the "machined" edges of the hardware-inspired panels.

## Typography

Typography is split between **Hanken Grotesk** for structural labels and **JetBrains Mono** for real-time data monitoring.

- **Structural Labels:** Use Hanken Grotesk in uppercase with increased letter spacing to mimic engraved or screen-printed hardware labels.
- **Performance Data:** Use JetBrains Mono for all numeric values (BPM, timestamps, frame rates). The monospaced nature prevents layout "jitter" when numbers change rapidly.
- **Visual Hierarchy:** Large display type is reserved for critical status (e.g., Master BPM), while small, high-contrast labels identify specific knobs and sliders.

## Layout & Spacing

This design system utilizes a **modular grid** approach. The interface is divided into functional "Racks" or "Modules" that behave like physical 19-inch rack units.

- **Modular Racks:** Elements are grouped into high-level containers (e.g., Mixer, FX Chain, Clip Launcher).
- **Hard Grids:** A 12-column system is used for the desktop layout, but internal module components use a strict 4px baseline grid for alignment.
- **Density:** High information density is prioritized. Vertical space is conserved to ensure global controls remain visible at all times.
- **Responsive Reflow:** On smaller screens, modules stack vertically, but internal control clusters (knob groups) maintain their spatial relationships to preserve muscle memory.

## Elevation & Depth

Depth is achieved through **Tonal Layering** and **Glassmorphism**, avoiding traditional drop shadows which can muddy dark UIs.

- **Level 0 (Base):** The dark background (#0A0A0B).
- **Level 1 (Module Surface):** Surface color (#161618) with a 1px border (#2D2D30). This represents the "faceplate" of the hardware.
- **Level 2 (Inlay/Well):** Slightly darker recessed areas for sliders and knob tracks, created using inner shadows.
- **Level 3 (Overlays/Modals):** Glassmorphic surfaces with a 20px background blur and 40% opacity. These "float" above the performance data.
- **Illumination:** Active elements emit a `0 0 12px` outer glow in their respective accent color (Cyan or Purple) to simulate LED backlighting.

## Shapes

The shape language is primarily **Soft (0.25rem)**, leaning towards a rugged, industrial feel.

- **Containers:** Modules use a 4px (Soft) radius to define boundaries without appearing "bubbly."
- **Interactive Points:** Buttons and toggles use a consistent 2px radius for a sharp, machined look.
- **Progress Bars & Faders:** Use sharp corners (0px) or minimal 2px rounding to emphasize precision and technical accuracy.
- **Recessed Areas:** "Wells" for knobs or sliders should be circular (pill-shaped) to match the physical geometry of hardware components.

## Components

- **Performance Buttons:** Rectangular with a heavy 1px top-border highlight. Active state uses a Cyan background with a subtle glow.
- **Rotary Knobs:** Vector-based circles with a "needle" indicator in Cyan. The "track" of the knob is a dark recessed path.
- **Linear Faders:** High-contrast tracks with a Cyan "cap." The cap features a horizontal grip texture.
- **Data Chips:** Small JetBrains Mono labels wrapped in a dark border (#2D2D30) used for metadata like file types or sample rates.
- **AI Suggestion Engine:** Containers for AI features use a subtle electric purple border-glow. Buttons within these modules use the AI Purple as the primary action color.
- **Waveform Displays:** High-contrast line art with Cyan peaks. Background of the waveform uses the Surface color to provide a clear container.
- **VU Meters:** Segmented bars. Lower segments are Gray, mid-segments are Cyan, and top segments (clipping) are Amber.
