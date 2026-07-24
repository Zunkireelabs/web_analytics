// Direct injection/replacement for the shared layout's <meta name="viewport">
// tag — no marker convention needed (same reasoning as html-lang-inject.js):
// the tag itself is unambiguous standard <head> markup. Unlike html-lang
// (inject-only, refuses if a lang attribute already exists), viewport must
// also REPLACE an existing tag's content when it's present but wrong
// (misconfigured or zoom-blocking) — there's a single correct value, and
// setting the whole attribute (not patching parts of it) is what actually
// fixes a zoom-blocking `user-scalable=no` alongside a missing
// `width=device-width` in one write.

const VIEWPORT_TAG_RE = /<meta\s+[^>]*name=["']viewport["'][^>]*>/i;
const CONTENT_ATTR_RE = /content=["']([^"']*)["']/i;
const HEAD_TAG_RE = /<head\b[^>]*>/i;

export function getViewportMeta(fileContent) {
  return VIEWPORT_TAG_RE.exec(fileContent)?.[0] ?? null;
}

// Sets the tag to exactly `desiredContent` — inserting a new tag if none
// exists, or replacing the `content` attribute of the existing one. An
// honest no-op (`viewport-already-correct`) when the live tag already
// matches, so a re-approved draft never produces a no-op diff.
export function setViewportMeta(fileContent, desiredContent) {
  const existing = VIEWPORT_TAG_RE.exec(fileContent);
  if (existing) {
    const tag = existing[0];
    const contentMatch = CONTENT_ATTR_RE.exec(tag);
    if (contentMatch && contentMatch[1] === desiredContent) {
      return { ok: false, reason: 'viewport-already-correct', error: `<meta name="viewport"> already has content="${desiredContent}" — nothing to do.` };
    }
    const newTag = contentMatch
      ? tag.replace(CONTENT_ATTR_RE, `content="${desiredContent}"`)
      : tag.replace(/>$/, ` content="${desiredContent}">`);
    const newContent = fileContent.slice(0, existing.index) + newTag + fileContent.slice(existing.index + tag.length);
    return { ok: true, newContent, changedRegion: { before: tag, after: newTag } };
  }

  const head = HEAD_TAG_RE.exec(fileContent);
  if (!head) {
    return { ok: false, reason: 'no-head-tag', error: 'No <head> tag found in this file — confirm url_file_map.siteRoot.layoutTemplate points at the file containing the real <head> tag.' };
  }
  const newTag = `<meta name="viewport" content="${desiredContent}">`;
  const insertAt = head.index + head[0].length;
  const newContent = fileContent.slice(0, insertAt) + newTag + fileContent.slice(insertAt);
  return { ok: true, newContent, changedRegion: { before: null, after: newTag } };
}
