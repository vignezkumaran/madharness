// ─── MAD Harness Claude-Style Violet Design System ─────────────────────────────
// Strict Palette: Violet, Black, White, and Grayscale tones.
// Inspired by Claude Code terminal aesthetics + Anthropic design elegance.

export const THEME = {
  // ── Core Violets ──────────────────────────────────────────────────────────
  primary: '#8B5CF6',       // Vibrant Electric Violet (Claude prompt, brand accent)
  secondary: '#7C3AED',     // Deep Royal Violet (Active headers, sub-badges)
  accent: '#A78BFA',        // Soft Lilac Violet (Assistant name, status accents)
  highlight: '#C4B5FD',     // Pastel Lilac (Active states, checkmarks, success)
  glow: '#DDD6FE',          // Pale Lavender Glow (Emphasized text, code highlights)
  light: '#EDE9FE',         // Softest Violet Tint (High-contrast highlights)

  // ── Violet Surface & Structure ───────────────────────────────────────────
  border: '#8B5CF6',        // Electric Violet Border (Focused card, input container)
  borderDim: '#5B21B6',     // Subdued Violet Border (Inactive borders, panel frames)
  borderSubtle: '#3B1877',  // Deep Violet Separator (Dividers, horizontal rules)
  bgViolet: '#2E1065',      // Deep Violet Background (Badges, selected highlights)
  bgVioletCard: '#180E29',  // Dark Obsidian Violet (Card surfaces)
  bgDark: '#0B0714',        // Deep Space Black/Violet (Terminal canvas)

  // ── Monochromes & Text ───────────────────────────────────────────────────
  white: '#FFFFFF',         // Pure White (Crisp headings, primary user input)
  text: '#F5F3FF',          // Off-white / Lavender-white (Body text paragraphs)
  textMuted: '#9CA3AF',     // Slate Gray (Secondary descriptions, details)
  textDim: '#6B7280',       // Dimmed Gray (Timestamps, keyboard hints)
  black: '#000000',         // True Black
  darkGray: '#1F2937',      // Charcoal (Meters, inactive progress bars)

  // ── Semantic Colors (Strict Violet & Monochrome) ─────────────────────────
  success: '#C4B5FD',       // Pastel Violet for Success / Completed (replaces green)
  successDim: '#7C3AED',    // Subdued Violet for success backgrounds
  warning: '#DDD6FE',       // Bright Lavender for Warnings (replaces yellow)
  error: '#FFFFFF',         // High-contrast Pure White for Errors (replaces red)
  errorAccent: '#A78BFA',   // Soft Violet for error details
  errorBg: '#4C1D95',       // Deep Violet for error badges
  info: '#A78BFA',          // Soft Lilac for Info
  codeBg: '#130924',        // Code Block Dark Violet-Black
};

