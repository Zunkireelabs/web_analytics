import { getSiteById } from '../store/read.js';

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
