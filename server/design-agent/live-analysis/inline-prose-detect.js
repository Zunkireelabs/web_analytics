import { launchBrowser } from './capture.js';
import { measureBodyInPage, tailwindFontSizePx, MEASURE_VIEWPORTS } from './body-measure.js';

// Work out `siteRoot.inlineProse` instead of waiting for a person to set it.
//
// 'layout' means the site's own LAYOUT already styles article prose (site 1's
// blog template wraps the body in Tailwind Typography's `.prose`), so the
// platform must NOT project the design profile's page-builder classes onto an
// article's headings — doing so overrides the layout and was measured at
// 30-48px headings next to the site's own 28px. 'project' means the article's
// own headings are effectively unstyled, which is the case projection exists
// to fix. Today this is a hand-set flag with no detection, so every new tenant
// silently gets whichever default is wrong for it.
//
// Measures only HUMAN-WRITTEN articles (captured pages of type blog-article),
// never generated ones — measuring our own output to decide how to render our
// own output would be circular.

export const PROJECTION_EXCESS = 0.15;

// A bare browser's h2: 1.5em with ~0.83em margins. A heading sitting exactly
// there, with no rule and no weight change, is unstyled by the site.
const looksUnstyled = (h2, bodyFont) => Boolean(h2) && bodyFont > 0
  && Math.abs(h2.fontSize - bodyFont * 1.5) < 1.5
  && h2.marginTop > 0 && Math.abs(h2.marginTop - h2.fontSize * 0.83) < 3 && h2.borderBottom === 0;

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// Pure: from per-article desktop measurements and the px size projection
// would emit, decide the mode. `evidence` is stored so the call can be audited.
export function decideInlineProseMode(measures, projectedH2Px = null) {
  const found = (measures || []).filter((m) => m?.found && m.h2);
  if (!found.length) return { mode: 'unknown', evidence: { reason: 'no measurable human-written article' } };

  const liveH2 = median(found.map((m) => m.h2.fontSize));
  const evidence = { articles: found.length, liveH2Px: liveH2, projectedH2Px };

  if (found.some((m) => m.pluginClass)) return { mode: 'layout', evidence: { ...evidence, signal: 'typography-plugin-class' } };
  // Unstyled FIRST: for a bare heading projection is ALWAYS larger than live,
  // so checking "projection exceeds live" before this would call every
  // unstyled site 'layout' — the exact opposite of the truth.
  if (found.every((m) => looksUnstyled(m.h2, m.bodyFontSize))) {
    return { mode: 'project', evidence: { ...evidence, signal: 'article-headings-unstyled' } };
  }
  if (projectedH2Px && liveH2 && projectedH2Px > liveH2 * (1 + PROJECTION_EXCESS)) {
    return { mode: 'layout', evidence: { ...evidence, signal: 'projection-larger-than-live' } };
  }
  // Styled, but projection would not visibly differ: either mode is safe, and
  // asserting one would be a guess.
  return { mode: 'unknown', evidence: { ...evidence, signal: 'indeterminate' } };
}

export function articleUrlsFromProfile(profile, { max = 3 } = {}) {
  return (profile?.pages || [])
    .filter((p) => p?.url && p.pageType === 'blog-article')
    .map((p) => p.url)
    .slice(0, max);
}

export function projectedH2PxFromProfile(profile, width = 1440) {
  const h = profile?.typography?.heading;
  return tailwindFontSizePx(h?.item || h?.section || '', width);
}

export async function detectInlineProseMode({ articleUrls, projectedH2Px = null, launchBrowserFn = launchBrowser, navTimeoutMs = 20000 } = {}) {
  if (!articleUrls?.length) return { mode: 'unknown', evidence: { reason: 'no captured human-written article' } };

  let browser;
  try { browser = await launchBrowserFn(); } catch (err) {
    return { mode: 'unknown', evidence: { reason: 'browser-unavailable', error: err.message } };
  }
  try {
    const desktop = MEASURE_VIEWPORTS[0];
    const context = await browser.newContext({ viewport: { width: desktop.width, height: desktop.height } });
    const page = await context.newPage();
    const measures = [];
    for (const url of articleUrls) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
        // eslint-disable-next-line no-await-in-loop
        measures.push(await page.evaluate(measureBodyInPage, false));
      } catch { /* one unreachable article must not sink the rest */ }
    }
    return decideInlineProseMode(measures, projectedH2Px);
  } catch (err) {
    return { mode: 'unknown', evidence: { reason: 'measurement-failed', error: err.message } };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Writes the detected mode, never overwriting a human-set one: hand-set
// config outranking a detector is this repo's convention, and a mismatch is
// logged, not silently resolved either way. 'unknown' writes nothing.
export function planInlineProseWrite(current, detected) {
  if (!detected || detected.mode === 'unknown') return { write: false, reason: 'unknown' };
  if (current === detected.mode) return { write: false, reason: 'already-set' };
  if (current === 'layout' || current === 'project') return { write: false, reason: 'human-set-mismatch', mismatch: { configured: current, detected: detected.mode } };
  return { write: true, mode: detected.mode };
}

export function isInlineProseAutodetectEnabled(env = process.env) {
  return env.INLINE_PROSE_AUTODETECT === 'true';
}

// Run detection against a freshly persisted profile and write the result.
// Called from persistDesignProfile, so every derivation and weekly rescan
// re-checks the mode instead of it being set once by hand and never revisited.
//
// Everything injected so it is testable and so persistDesignProfile's own
// callers see no change when the flag is off. NEVER throws: the profile is
// already saved and is the valuable result; the mode is a refinement of it.
export async function applyInlineProseDetection({ site, profile, saveConfig, detect = detectInlineProseMode, log = console }) {
  try {
    const detected = await detect({ articleUrls: articleUrlsFromProfile(profile), projectedH2Px: projectedH2PxFromProfile(profile) });
    const current = site?.url_file_map?.siteRoot?.inlineProse;
    const plan = planInlineProseWrite(current, detected);
    if (plan.mismatch) {
      log.warn(`[inline-prose] site ${site?.id}: configured "${plan.mismatch.configured}" but the detector says "${plan.mismatch.detected}" — left as configured, worth a look.`);
    }
    if (!plan.write) return { written: false, reason: plan.reason, detected };

    const map = site.url_file_map || {};
    await saveConfig({
      siteId: site.id,
      urlFileMap: { ...map, siteRoot: { ...(map.siteRoot || {}), designProfile: profile, inlineProse: plan.mode } },
    });
    return { written: true, mode: plan.mode, detected };
  } catch (err) {
    log.warn(`[inline-prose] site ${site?.id}: detection failed, profile unaffected: ${err.message}`);
    return { written: false, reason: 'error' };
  }
}
