// The design half of the Quality Gate — same contract as quality-gate.js's
// runQualityGate ({ clean, issues }, issues shaped { path, patternId,
// snippet }), run alongside it at the exact same two points (generation and
// approval, routes/action-center.js), so a draft that looks like a generic
// AI-styled insertion instead of something that belongs on the site's real
// design gets caught before it ever becomes a PR — the "validated against
// the current Design Context before a PR is created" requirement.
//
// Deliberately narrow, not a full design-system linter: every real style on
// a generated page already comes from componentTemplates/newpage-render's
// projected wrapper (design-drift.js) — literal classes copied from (or
// projected from) the site's own live design, never invented by the LLM.
// The one way a generator's own prose can still introduce something that
// does NOT belong is by emitting raw styling itself — an inline
// `style="..."` attribute or a hardcoded hex/rgb color value — which is
// both a strong, low-false-positive "generic AI output" tell and something
// no real template this platform projects would ever contain. This is
// intentionally NOT a class-name allowlist check: an LLM occasionally
// echoing one of the site's own real classes back in prose is harmless and
// common (e.g. quoting a snippet), but it never has grounds to invent a
// style attribute or a color value the site's design system doesn't
// express in its own classes.
const INLINE_STYLE_RE = /\bstyle\s*=\s*["'][^"']*["']/i;
const RAW_COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]+\)/;

// Walks a generator's structured `content` (routes/action-center.js's
// GeneratorOutput contract — plain strings, arrays, and nested objects, the
// same shape quality-gate.js's checks already walk) collecting every string
// value along with a dotted path, so an issue can say WHERE it was found.
function collectStrings(value, path = '') {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectStrings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => collectStrings(v, path ? `${path}.${k}` : k));
  }
  return [];
}

export function checkDesignConsistency(content) {
  const issues = [];
  for (const [path, text] of collectStrings(content)) {
    const styleMatch = INLINE_STYLE_RE.exec(text);
    if (styleMatch) {
      issues.push({
        path, patternId: 'inline-style', snippet: styleMatch[0].slice(0, 120),
      });
    }
    const colorMatch = RAW_COLOR_RE.exec(text);
    if (colorMatch) {
      issues.push({
        path, patternId: 'raw-color-value', snippet: colorMatch[0].slice(0, 120),
      });
    }
  }
  return { clean: issues.length === 0, issues };
}
