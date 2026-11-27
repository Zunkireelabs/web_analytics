// The site's own FAQ design, learned from its OTHER pages when its blog posts carry none. A site can have a well-designed FAQ on its pricing or home page and none in its
// blog posts (SuperRank: `faq-x__h` "Frequently asked questions" on /pricing, nothing in its articles). Learning only from the blog posts then drew every blog FAQ as a plain
// section, in no design of the site's. The pages come from the site's page inventory; the first one carrying a FAQ block the learner (html-faq-learn.js) can read wins.
import { faqBlockTemplate } from './html-faq-learn.js';

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // siteId -> { at, promise }
export const clearSiteFaqCache = () => cache.clear();

const NOT_A_PAGE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|json|xml|txt|pdf|woff2?|ttf|mp4|zip)(\?|$)/i;
const BLOG_LIKE = /\/(blogs?|articles?|insights|news|posts?|resources\/[^/]+)\//i;
const LIKELY = /pricing|faq|about|contact|services|features|product|solutions|how-it-works|packages/i;

/** The pages worth trying, best first: the home page, then pages likely to carry a FAQ, then the rest; never files, never blog posts, never a query string. */
export function pickFaqSourcePages(pages, { max = 8 } = {}) {
  const seen = new Set(); const out = [];
  for (const raw of pages || []) {
    let u; try { u = new URL(raw); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.search || NOT_A_PAGE.test(u.pathname) || BLOG_LIKE.test(u.pathname + '/')) continue;
    const key = `${u.host}${u.pathname.replace(/\/+$/, '')}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(u.href);
  }
  const rank = (href) => { const p = new URL(href).pathname.replace(/\/+$/, ''); return p === '' ? 0 : (LIKELY.test(p) ? 1 : 2); };
  return out.map((href, i) => ({ href, i })).sort((a, b) => rank(a.href) - rank(b.href) || a.i - b.i).slice(0, max).map((x) => x.href);
}

async function defaultListPages(siteId) {
  const { query } = await import('../../db.js');
  const { rows } = await query('SELECT page FROM page_inventory WHERE site_id = $1 ORDER BY page LIMIT 600', [siteId]);
  return rows.map((r) => r.page);
}
async function defaultFetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; SuperRankBot/1.0)' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return null;
  return res.text();
}

/** { wrapper, row, items, learnedFrom } or null. Kept per site for hours; a null (no FAQ found anywhere) is kept for a shorter time so a new FAQ is found. */
export function learnSiteFaqTemplate(site, { listPages = defaultListPages, fetchHtml = defaultFetchHtml, now = Date.now(), force = false } = {}) {
  if (!site?.id) return Promise.resolve(null);
  const hit = cache.get(site.id);
  if (!force && hit && now - hit.at < (hit.found ? TTL_MS : 30 * 60 * 1000)) return hit.promise;
  const promise = (async () => {
    const pages = pickFaqSourcePages(await listPages(site.id));
    for (let i = 0; i < pages.length; i += 4) {
      const batch = pages.slice(i, i + 4);
      // eslint-disable-next-line no-await-in-loop
      const found = await Promise.all(batch.map(async (url) => { try { const html = await fetchHtml(url); const t = html ? faqBlockTemplate(html) : null; return t ? { ...t, learnedFrom: url } : null; } catch { return null; } }));
      const first = found.find(Boolean);
      if (first) return first;
    }
    return null;
  })().catch(() => null);
  const entry = { at: now, promise, found: false };
  cache.set(site.id, entry);
  promise.then((t) => { entry.found = Boolean(t); });
  return promise;
}

// ---- A site's FAQ design from its own REPO files (for a site whose published pages are not the ones with the FAQ yet) ------------------------------------------------------
// MOBILISE's production site has no FAQ anywhere yet; its staging site and its repo do (services, about, compare, locations). The page list holds production addresses, so the
// design is read from the repo's own template files instead: the first non-blog file whose FAQ block the learner can read.
const SECTION_AROUND = /(<section\b[^>]*>)\s*<div\b[^>]*>\s*(?:<(?:span|p|div)\b[^>]*>[^<]*<\/(?:span|p|div)>\s*)*<h[1-3]\b[^>]*>\s*(?:frequently asked questions|faq|common questions)/i;
/** The opening tag of the band (<section class="faq-sec" id="faq">) a FAQ block sits in, from the page's own source; null when it is not inside one. */
export function sectionAroundFaq(raw) {
  const m = SECTION_AROUND.exec(String(raw || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''));
  return m ? m[1] : null;
}
const TEMPLATE_FILE = /\.(njk|html|liquid|hbs|md)$/i;
const FAQ_LIKELY_FILE = /services|about|compare|faq|pricing|locations|contact|case|home|index|features|solutions/i;

/** The repo's non-blog template files worth reading, best first. Pure. */
export function pickFaqSourceFiles(files, { blogDir = '', max = 14 } = {}) {
  const blog = String(blogDir || '').replace(/\/+$/, '');
  const ok = (files || []).filter((f) => TEMPLATE_FILE.test(f) && !/(^|\/)(node_modules|_site|dist|\.git)\//.test(f) && !(blog && (f === blog || f.startsWith(`${blog}/`))) && !/(^|\/)(blogs?|articles?|posts?)\//i.test(f));
  return ok.map((f, i) => ({ f, i })).sort((a, b) => (FAQ_LIKELY_FILE.test(b.f) ? 1 : 0) - (FAQ_LIKELY_FILE.test(a.f) ? 1 : 0) || a.i - b.i).slice(0, max).map((x) => x.f);
}

const repoCache = new Map();
export const clearRepoFaqCache = () => repoCache.clear();

/** { wrapper, row, items, learnedFrom } or null. `withSection` wraps the block in the band it sits in on the page (for a site whose blog posts are whole pages made of bands). */
export function learnRepoFaqTemplate(site, { getRepoTree = null, getFileContent = null, ref = null, blogDir = '', withSection = false, now = Date.now(), force = false } = {}) {
  if (!site?.id) return Promise.resolve(null);
  // Everything the answer depends on is in the key: a different branch or blog folder is a different question, never the first call's answer.
  const key = `${site.id}:${withSection}:${ref || ''}:${blogDir || ''}`;
  let hadError = false;
  const hit = repoCache.get(key);
  if (!force && hit && now - hit.at < (hit.found ? TTL_MS : 30 * 60 * 1000)) return hit.promise;
  const promise = (async () => {
    const injected = Boolean(getRepoTree && getFileContent);
    const [client, ops] = injected ? [{ getRepoTree, getFileContent }, null] : await Promise.all([import('../../github/client.js'), import('../../implementers/lib/github-ops.js')]);
    const tree = client.getRepoTree; const read = client.getFileContent;
    // The stage branch first (where a site that promotes through stage keeps its newest design), then the production branch.
    const refs = ref ? [ref] : [...new Set([client.prTargetBranchName?.(site), ops?.baseBranch(site)].filter(Boolean))];
    for (const branch of refs) {
      let files;
      try { files = pickFaqSourceFiles((await tree(site, branch)).files, { blogDir }); } catch { hadError = true; continue; }
      for (let i = 0; i < files.length; i += 4) {
        const batch = files.slice(i, i + 4);
        // eslint-disable-next-line no-await-in-loop
        const found = await Promise.all(batch.map(async (path) => {
          try {
            const raw = (await read(site, path, branch))?.content;
            const t = raw ? faqBlockTemplate(raw) : null;
            if (!t) return null;
            const open = withSection ? sectionAroundFaq(raw) : null;
            return { ...t, wrapper: open ? `${open}${t.wrapper}</section>` : t.wrapper, learnedFrom: `${branch}:${path}` };
          } catch { hadError = true; return null; }
        }));
        const first = found.find(Boolean);
        if (first) return first;
      }
    }
    return null;
  })().catch(() => null);
  const entry = { at: now, promise, found: false };
  repoCache.set(key, entry);
  // Nothing found because a read failed is not "this site has no FAQ": it is not remembered, so the next call looks again.
  promise.then((t) => { entry.found = Boolean(t); if (!t && hadError && repoCache.get(key) === entry) repoCache.delete(key); });
  return promise;
}

/** The site's FAQ design wherever it is: its other published pages first, then its own repo's template files (banded when its posts are whole pages made of bands). */
export async function learnFaqDesign(site) {
  const pages = await learnSiteFaqTemplate(site).catch(() => null);
  if (pages) return pages;
  const cfg = site?.url_file_map?.newContentTargets?.['blog-outline'] || {};
  return learnRepoFaqTemplate(site, { blogDir: cfg.dir || '', withSection: cfg.mode === 'clone-sibling' }).catch(() => null);
}
