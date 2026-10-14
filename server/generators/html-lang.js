import { getSiteById } from '../store/read.js';
import { analyzePageUrl } from '../agents/lib/page-content.js';
import { siteOriginFor } from '../agents/lib/site-domain.js';

// Pure, deterministic generator — no LLM call, nothing to ground beyond a
// language code. The implementer (server/implementers/backend.js) injects
// this directly into the shared layout's <html> tag via a targeted regex
// (server/implementers/lib/html-lang-inject.js) — no marker convention
// needed, since <html> is unambiguous standard markup in every framework
// this platform targets.

export const meta = {
  id: 'html-lang',
  name: 'HTML Lang Attribute Generator',
  description: 'Drafts the missing <html lang="..."> attribute for the site\'s shared layout template.',
  recommendationTags: [],
};

const VALID_LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const DEFAULT_LANG = 'en';

// params: { lang?: string } — an explicit override, if one is ever passed.
// Otherwise resolved from the site's own per-site config
// (url_file_map.siteRoot.htmlLang, set once at onboarding), falling back to
// 'en'. Anything that doesn't look like a real BCP-47-ish code (e.g. "en" or
// "en-US") falls back to 'en' rather than drafting a malformed attribute.
export async function generate({ siteId, params }) {
  let lang = params?.lang;
  if (!lang) {
    const site = await getSiteById(siteId);
    lang = site?.url_file_map?.siteRoot?.htmlLang;
  }
  if (!lang || !VALID_LANG_RE.test(lang)) lang = DEFAULT_LANG;

  return {
    content: { lang },
    summary: `Set <html lang="${lang}"> on the shared layout template.`,
  };
}

// Side-effect-free re-verification (server/generators/lib/verification-layer.js).
// <html lang> is a shared-template attribute (same "one page's absence means
// every page's absence" reasoning the detecting agent uses — see
// agents/accessibility.js), so there is no single per-recommendation page to
// check against; the site's own public origin is the same fallback target
// fix-verification.js's own PAGE_PATTERN check already uses for this exact
// generator (`target = page || siteOrigin`), reused here rather than
// reinvented. analyzePageUrl is the SAME real check the detecting agent
// itself runs (page-content.js's analyzePage), just re-run against current
// live HTML instead of the batch snapshot that originally flagged it.
export async function verifyCurrentState(rec, { site } = {}) {
  if (!site) return { decision: 'still_valid', reason: 'no-site-context', evidence: null };
  const target = rec.params?.page || rec.page || siteOriginFor(site);
  if (!target) return { decision: 'still_valid', reason: 'no-checkable-target', evidence: null };

  const fetched = await analyzePageUrl(target);
  if (!fetched.ok) return { decision: 'still_valid', reason: 'unreachable', evidence: { target, error: fetched.error } };

  if (fetched.analysis.htmlLang) {
    return { decision: 'already_resolved', reason: 'html-lang-present', evidence: { target, htmlLang: fetched.analysis.htmlLang } };
  }
  return { decision: 'still_valid', reason: 'html-lang-missing', evidence: { target } };
}
