// SuperRank chart + status palette. Every chart, sparkline and category colour
// in the app reads from here. SERIES is a fixed order validated for colour-
// blind separation (adjacent pairs): assign in order, never cycle past it;
// fold extra series into "Other" (CHART.muted).
export const CHART = {
  highlight: '#d54e00',     // the one accent: primary series, single-series charts, sparklines
  highlightTint: '#fff4ed',
  ink: '#171717',
  text: '#525252',
  axis: '#8a8a8a',          // tick labels
  grid: '#f0f0f0',          // gridlines
  cursor: '#e6e6e6',        // tooltip cursor / reference lines
  muted: '#d4d4d4',         // "Other", inactive, plan lines
  track: '#ededed',         // empty bar/progress track
};

export const SERIES = ['#d54e00', '#3a6fb5', '#b8860b', '#00897b', '#8e55a8', '#4f8a2f'];

// Reserved for state (good / warning / critical / neutral). Never used as a series colour.
// color = marks + icons, text = readable text on white/tint, tint = soft background, ring = 1px border.
export const STATUS = {
  good:     { color: '#1a7f4b', text: '#1a7f4b', tint: '#e8f7ee', ring: '#c6ebd5' },
  warning:  { color: '#b8860b', text: '#8a5300', tint: '#fdf3e1', ring: '#f3ddb0' },
  critical: { color: '#e5484d', text: '#b42318', tint: '#fdecec', ring: '#f9c9c9' },
  neutral:  { color: '#a3a3a3', text: '#525252', tint: '#f5f5f5', ring: '#e6e6e6' },
};

// Shared recharts axis tick style.
export const AXIS_TICK = { fontSize: 11, fill: CHART.axis, fontWeight: 500 };
