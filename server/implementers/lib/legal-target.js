// Where a NEW cookie-policy / privacy-policy / terms-of-service page goes, learned from the legal pages the site already has.
//
// WHY THIS EXISTS. Onboarding seeds url_file_map.newContentTargets for every net-new type with a placeholder directory ("docs", or "src/content-drafts" on
// an Astro site). Nothing builds that directory into the website, so a cookie policy written there is a file in the repo and a 404 on the site: MOBILISE,
// 2026-11-23, PR 12 added docs/cookie-policy-mobilise.md and /cookie-policy/ stayed 404 on the dev site, while the draft was marked implemented.
//
// The site already answers the real question: its privacy and terms pages are mapped in url_file_map.pages, so where they live (a folder per page,
// `src/terms/index.njk`, or a flat file, `src/terms.njk`), what URL shape they use, and which layout they declare are all known. A new legal page is
// placed beside them, the same way, with the same layout. Nothing here is a per-site setting, so it works for every client.
//
// It only RESOLVES a target. The body is still wrapped by the site's own captured contentWrapper (newpage-render.js), and a site that never captured
// one still ships plain headings: that gap is reported by the caller, not hidden here.

// Directories nothing builds into the website. A new page configured to land here is a placeholder, not a decision.
const PLACEHOLDER_DIRS = new Set(['docs', 'content-drafts', 'src/content-drafts', 'drafts', 'src/drafts']);
export const isPlaceholderDir = (dir) => PLACEHOLDER_DIRS.has(String(dir || '').replace(/^\.?\/+|\/+$/g, '').toLowerCase());

// What each compliance type is called in a URL when the site has none of its own.
const SLUG = { 'cookie-policy': 'cookie-policy', 'privacy-policy': 'privacy-policy', 'terms-of-service': 'terms' };
// A page URL that is some site's legal page. Used to find a sibling to copy the shape from.
const LEGAL_URL = /^(?:\/[a-z0-9-]+)?\/(privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|cookies?|cookie-policy|legal)\/?$/i;
const PAGE_FILE = /\.(njk|md|html?|liquid|astro)$/i;

const pathOf = (u) => { try { return new URL(u, 'https://x.invalid').pathname.replace(/\/+$/, '') || '/'; } catch { return null; } };

/**
 * @returns {Promise<null | { filePath, permalink, layout, sibling } | { conflict: true, filePath }>}
 *   null when the site has no legal page to learn from (the caller keeps its configured target).
 */
export async function deriveLegalTarget(site, actionType, { readFile = null, ref = 'main' } = {}) {
  const slug = SLUG[actionType];
  const pages = site?.url_file_map?.pages;
  if (!slug || !pages) return null;

  // A sibling is a DIFFERENT legal page that has a real template file.
  const siblings = Object.entries(pages)
    .map(([url, e]) => ({ url, path: pathOf(url), file: e?.file }))
    .filter((p) => p.path && p.file && LEGAL_URL.test(p.path) && PAGE_FILE.test(p.file) && p.path.split('/').pop().toLowerCase() !== slug)
    // Prefer the most "policy-like" sibling, then the shortest path, so the choice is the same on every run.
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const sibling = siblings[0];
  if (!sibling) return null;

  const segs = sibling.path.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  const base = sibling.file.split('/').pop();
  const dir = sibling.file.slice(0, sibling.file.length - base.length).replace(/\/$/, '');
  const ext = (base.match(/\.[^.]+$/) || ['.njk'])[0];
  const urlDir = segs.slice(0, -1).join('/');
  const permalink = `/${urlDir ? `${urlDir}/` : ''}${slug}/`;

  let filePath;
  if (/^index\./i.test(base) && dir.split('/').pop() === last) {
    // A folder per page: src/terms/index.njk -> src/cookie-policy/index.njk
    const parent = dir.split('/').slice(0, -1).join('/');
    filePath = `${parent ? `${parent}/` : ''}${slug}/${base}`;
  } else if (base.replace(/\.[^.]+$/, '') === last) {
    // A flat file named for its URL: src/terms.njk -> src/cookie-policy.njk
    filePath = `${dir ? `${dir}/` : ''}${slug}${ext}`;
  } else {
    return null; // the sibling's file does not follow its URL; guessing a sibling path from it would be a guess
  }

  // Never write over a file that is already there (a page the url map simply does not list).
  if (readFile) {
    const existing = await readFile(site, filePath, ref).catch(() => null);
    if (existing) return { conflict: true, filePath };
  }

  // The layout its neighbours declare, so the new page sits in the same template: the first legal page (shape sibling first) that names one.
  let layout = null;
  if (readFile) {
    for (const cand of siblings.slice(0, 4)) {
      const raw = await readFile(site, cand.file, ref).catch(() => null);
      const text = typeof raw === 'string' ? raw : raw?.content;
      const fm = text && /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const m = fm && /^layout\s*:\s*"?([^"\r\n]*)"?\s*$/m.exec(fm[1]);
      if (m) { layout = m[1].trim(); break; }
    }
  }
  return { filePath, permalink, layout, sibling: sibling.file };
}
