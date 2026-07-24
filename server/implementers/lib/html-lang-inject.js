// Direct attribute injection for the shared layout's <html> tag — no marker
// convention needed here (unlike marker-merge.js/hash-marker-merge.js):
// `<html` is unambiguous standard markup in every framework this platform
// targets (Nunjucks/Astro/Next.js/Hugo/plain HTML all emit a literal
// `<html...>` tag), so a single tightly-scoped regex is safe without the
// "never parse unknown templating syntax" concern that motivates markers
// elsewhere. Only ever touches the tag itself, never the rest of the file.

const HTML_TAG_RE = /<html\b([^>]*)>/i;
const LANG_ATTR_RE = /\blang\s*=/i;

// Injects lang="<langCode>" into the first <html ...> tag, only when no
// `lang` attribute is present at all (covers both a literal value like
// lang="en" and a templated one like lang="{{ locale }}" — either way,
// "already present" is an honest no-op, never an overwrite of a value a
// human or the site's own templating already set).
export function injectHtmlLang(fileContent, langCode) {
  const match = HTML_TAG_RE.exec(fileContent);
  if (!match) {
    return { ok: false, reason: 'no-html-tag', error: 'No <html> tag found in this file — confirm url_file_map.siteRoot.layoutTemplate points at the file containing the real <html> tag.' };
  }
  const attrs = match[1];
  if (LANG_ATTR_RE.test(attrs)) {
    return { ok: false, reason: 'lang-already-present', error: `<html> already has a lang attribute (${attrs.trim()}) — nothing to do.` };
  }

  const before = match[0];
  const after = `<html lang="${langCode}"${attrs}>`;
  const newContent = fileContent.slice(0, match.index) + after + fileContent.slice(match.index + before.length);
  return { ok: true, newContent, changedRegion: { before, after } };
}

// The live <html ...> tag, verbatim — used to show an implemented draft's
// real, current tag without recomputing anything (mirrors marker-merge.js's
// getMarkerContent / hash-marker-merge.js's getHashMarkerContent).
export function getHtmlTag(fileContent) {
  return HTML_TAG_RE.exec(fileContent)?.[0] ?? null;
}
