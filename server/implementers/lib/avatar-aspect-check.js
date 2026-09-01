// Onboarding-time check for a defect class first hit for real on
// zunkireelabs-web (2026-09): a "Zunkiree Labs Team" blog byline used the
// full wide wordmark logo (SVG viewBox ~7.3:1) as an author avatar, but the
// template rendered it inside a fixed circular `object-cover` frame sized
// for square headshots. `object-cover` fills the frame by the shorter
// dimension and crops whatever overflows, so a wide logo gets almost
// entirely cropped away — only a thin sliver of its center stays visible.
// That template code is hand-authored per client site (see
// action-center-onboarding skill), so nothing here can auto-fix it — but a
// site declaring its avatar assets in url_file_map.siteRoot.authorAvatars
// lets audit-url-file-map.js catch a same-shaped mismatch onboarding-time,
// before any blog ships, instead of it being found by eye on a live page.
//
// Deliberately narrow, same discipline as every other check in this file's
// caller: only SVG width/height is parsed (viewBox, or width+height
// attributes on the root <svg> tag) — good enough for the logo-mark case
// this exists for. A raster avatar (png/jpg/webp) is reported "unverified"
// rather than guessed at; decoding raster image headers is real, separate
// scope this doesn't attempt.

const SQUARE_TOLERANCE = 0.2; // ratio must fall within [1-t, 1+t] to be "square enough" to survive a circular object-cover crop

// Reads only the root <svg ...> tag's own attributes — a naive whole-file
// regex would just as happily match a `width`/`height` on some nested
// <rect>/<path> and report a completely wrong aspect ratio.
export function parseSvgDimensions(svgSource) {
  if (typeof svgSource !== 'string') return null;
  const openTagMatch = svgSource.match(/<svg\b[^>]*>/i);
  if (!openTagMatch) return null;
  const openTag = openTagMatch[0];

  const viewBoxMatch = openTag.match(/\bviewBox\s*=\s*"([^"]+)"/i);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }

  const widthMatch = openTag.match(/\bwidth\s*=\s*"([\d.]+)/i);
  const heightMatch = openTag.match(/\bheight\s*=\s*"([\d.]+)/i);
  if (widthMatch && heightMatch) {
    const width = Number(widthMatch[1]);
    const height = Number(heightMatch[1]);
    if (width > 0 && height > 0) return { width, height };
  }

  return null;
}

// expectedFit is the human-declared truth about how the site's template
// actually renders this avatar — 'circular-cover' (rounded-full +
// object-cover, or equivalent: crops to fill) or 'contain' (natural aspect
// ratio preserved, e.g. object-contain / no forced circular frame). Only
// 'circular-cover' can ever produce a gap here: object-contain tolerates
// any aspect ratio by construction.
export function classifyAvatarAspectGap({ expectedFit, dimensions }) {
  if (expectedFit !== 'circular-cover') return null;

  if (!dimensions) {
    return {
      severity: 'unverified',
      reason: "could not determine the image's real aspect ratio (only SVG viewBox/width+height are currently parsed)",
    };
  }

  const { width, height } = dimensions;
  const ratio = width / height;
  if (ratio >= 1 - SQUARE_TOLERANCE && ratio <= 1 + SQUARE_TOLERANCE) return null;

  return {
    severity: 'fatal',
    reason: `image is ${width}x${height} (aspect ratio ${ratio.toFixed(2)}:1) but is declared as rendering inside a circular object-cover frame — object-cover will crop most of a non-square image away, leaving only a sliver visible`,
  };
}
