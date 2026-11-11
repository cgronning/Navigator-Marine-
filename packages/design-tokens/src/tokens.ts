/**
 * Navigator design tokens — first draft (Stage 2 refines with a designer).
 * Direction: deep navy, cream, white, quiet ocean accents; high contrast
 * for sunlight; large touch targets for use aboard.
 */

export const color = {
  navy: { 950: '#07142B', 900: '#0B1F3F', 800: '#132C55', 700: '#1D3D6E', 500: '#3A5F96' },
  cream: { 50: '#FBF8F1', 100: '#F5EFE2', 200: '#EBE2CD' },
  white: '#FFFFFF',
  ocean: { teal: '#1F7A8C', sea: '#3E9BB5', foam: '#BFE3EA' },
  signal: {
    // Status colors follow maritime convention where it helps recognition
    safe: '#1E8E5A',      // starboard green
    caution: '#E0A100',   // amber
    danger: '#C8322B',    // port red
    info: '#2F6FD6',
  },
  data: {
    live: '#1E8E5A',
    delayed: '#E0A100',
    stale: '#8A93A3',     // stale positions are grey, never green
    estimated: '#8A93A3', // estimated/interpolated drawn dashed in grey
  },
} as const;

export const theme = {
  day: { bg: color.cream[50], surface: color.white, text: color.navy[950], textMuted: '#4B5871', accent: color.ocean.teal, border: color.cream[200] },
  night: { bg: color.navy[950], surface: color.navy[900], text: color.cream[100], textMuted: '#A9B3C6', accent: color.ocean.sea, border: color.navy[700] },
  // Red-shifted night mode preserves night vision on deck
  redNight: { bg: '#000000', surface: '#120404', text: '#D23A2A', textMuted: '#8C2A20', accent: '#D23A2A', border: '#2A0B07' },
} as const;

export const type = {
  family: { display: 'serif-display (TBD with designer)', text: 'Inter', mono: 'JetBrains Mono' },
  size: { caption: 13, body: 16, bodyLarge: 18, title: 22, headline: 28, display: 36, instrument: 48 },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '700' },
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { sm: 8, md: 12, lg: 20, pill: 999 } as const;

/** Minimum touch target on board (wet hands, motion): larger than the 44pt platform default. */
export const touch = { min: 52, mapControl: 56 } as const;

export const motion = { fast: 150, base: 250, slow: 400, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' } as const;
