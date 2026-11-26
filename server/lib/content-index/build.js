// Builds the content index (migration 270) from what the system really knows. PURE: rows in, entries out, no database.
//
// PUBLISHED comes from the crawl and the page-content classification, never from URL patterns alone. On 2026-11-25 the URL pattern
// /(blog|articles|news|insights)/ found 0 blogs among Admizz's 393 inventory pages because its posts live at the site root (/slug), while
// the classification cache held 59 of them and 34 of its 47 latest snapshots carried BlogPosting schema. Four independent signals are
// used, any one is enough: the classification cache says "blog", the schema types include an article type, og:type is article, or the page sits under a
// detected blog listing root. A page with none of them is indexed as kind 'page': its path is still protected, it is just not a blog.
import { pathKey, tokensForEntry, topicKey } from './normalize.js';

// A page is identified by its PATH within one client's index, whatever host spelling it was stored with: the inventory holds both full URLs and bare paths
// ('/blog/slug') for the same site, and a bare path used to be dropped entirely (5 of Zunkiree's posts on 2026-11-25). One client's index never mixes hosts.
const keyOf = pathKey;

const ARTICLE_SCHEMA = /^(Article|BlogPosting|NewsArticle|TechArticle|ScholarlyArticle|Report)$/;
export const MIN_CLASSIFIER_CONFIDENCE = 0.6;

// Draft action types that create a NEW page of their own. Edits to existing pages are not "content" to deduplicate.
export const NET_NEW_ACTION_TYPES = new Set(['blog-outline']);

export const DRAFT_STATE_BY_STATUS = Object.freeze({
  draft: 'draft', edited: 'draft', submitted_for_approval: 'draft', revision_requested: 'draft',
  approved: 'approved', branch_pushed: 'approved', awaiting_publish: 'approved',
  pr_opened: 'in_pr', merged_to_stage: 'in_pr',
  implemented: 'merged',
});

const BLOG_SEGMENT = /^(blog|blogs|news|articles?|insights|journal|resources|posts|guides?|stories|learn)$/i;
const PAGINATION = /\/page\/\d+\/?$/i;

/**
 * Pure. Blog listing roots from the site's own paths, at ANY depth and under a language prefix: '/blog/', '/nl/blog/', '/businesses/blog/'. A root is a path
 * ending in a blog-like segment that has at least `minChildren` single-segment children (the posts). Pagination ('/blog/page/3/') never counts as a post, and a
 * child that is itself a listing ('/blog/articles/') is a root of its own, not a post. The older detector (agents/lib/blog-listing.js) only sees one-level roots,
 * which missed all 63 of Zennly's posts under /businesses/blog/ on 2026-11-25.
 */
export function detectBlogRoots(paths, { minChildren = 5 } = {}) {
  const children = new Map();
  for (const raw of paths) {
    const segs = String(raw || '').split('?')[0].split('/').filter(Boolean);
    for (let i = 0; i < segs.length - 1; i++) {
      if (!BLOG_SEGMENT.test(segs[i]) || segs.length !== i + 2 || /^page$/i.test(segs[i + 1])) continue;
      const root = `/${segs.slice(0, i + 1).join('/').toLowerCase()}/`;
      if (!children.has(root)) children.set(root, new Set());
      children.get(root).add(segs[i + 1].toLowerCase());
    }
  }
  return [...children].filter(([, set]) => set.size >= minChildren).map(([root]) => root).sort();
}

/** Pure. Why this page counts as a blog post, or null. */
export function blogSignal({ url, classification = null, schemaTypes = null, ogType = null, listingRoots = [] } = {}) {
  const p0 = pathKey(url) || '';
  if (PAGINATION.test(p0)) return null;                         // a pagination page is a listing, never a post
  if (classification && classification.content_type === 'blog' && Number(classification.confidence) >= MIN_CLASSIFIER_CONFIDENCE) return 'classifier';
  if (Array.isArray(schemaTypes) && schemaTypes.some((t) => ARTICLE_SCHEMA.test(String(t)))) return 'schema';
  if (String(ogType || '').toLowerCase() === 'article') return 'og-article';
  const roots = listingRoots.map((r) => r.replace(/\/+$/, '').toLowerCase());
  if (roots.includes(p0)) return null;                          // a listing root itself ('/blog/articles' under '/blog/') is not a post
  if (roots.some((root) => p0.startsWith(`${root}/`) && p0.length > root.length + 1)) return 'listing-root';
  return null;
}

const titleOf = (snap, draft) => (snap?.title || draft?.content?.title || draft?.content?.topic || '').toString().slice(0, 300);
const h1Of = (snap) => (Array.isArray(snap?.h1) ? snap.h1[0] : null);

/**
 * @param {object} d
 *   inventory        [{ page, orphaned? }]               the site's own pages
 *   snapshots        [{ url, title, h1, schema_types, open_graph, content_hash }]   latest crawl snapshot per URL
 *   classifications  [{ page, content_type, confidence }]
 *   drafts           [{ id, action_type, status, pr_state, pr_url, branch_name, target_file_path, content, input }]
 *   listingRoots     ['/blog/', ...]                      from blog-listing.js detectListingRoots
 * @returns {Array} entries { refKey, kind, state, url, title, topicKey, tokens, source, draftId, branchName, prUrl, filePath, contentHash }
 */
export function buildIndexEntries({ inventory = [], snapshots = [], classifications = [], drafts = [], listingRoots = [] } = {}) {
  const snapBy = new Map(); for (const s of snapshots) { const k = keyOf(s.url); if (k) snapBy.set(k, s); }
  const classBy = new Map(); for (const c of classifications) { const k = keyOf(c.page); if (k) classBy.set(k, c); }
  const entries = [];
  const seen = new Set();

  for (const row of inventory) {
    const key = keyOf(row.page); if (!key || seen.has(key)) continue; seen.add(key);
    const snap = snapBy.get(key) || null;
    const signal = blogSignal({ url: row.page, classification: classBy.get(key), schemaTypes: snap?.schema_types, ogType: snap?.open_graph?.type ?? snap?.open_graph?.['og:type'], listingRoots });
    const title = (snap?.title || h1Of(snap) || '').toString().slice(0, 300);
    entries.push({
      refKey: `url:${key}`, kind: signal ? 'blog' : 'page', state: 'published', url: row.page, title, topicKey: topicKey(`${title} ${pathKey(row.page)?.split('/').pop()?.replace(/[-_]+/g, ' ') || ''}`) || null,
      tokens: tokensForEntry({ title, url: row.page }), source: signal || 'inventory', draftId: null, branchName: null, prUrl: null, filePath: null, contentHash: snap?.content_hash || null,
    });
  }
  // A snapshot of a page the inventory missed is still a page that exists.
  for (const s of snapshots) {
    const key = keyOf(s.url); if (!key || seen.has(key) || (s.status_code && s.status_code >= 400)) continue; seen.add(key);
    const signal = blogSignal({ url: s.url, classification: classBy.get(key), schemaTypes: s.schema_types, ogType: s.open_graph?.type ?? s.open_graph?.['og:type'], listingRoots });
    entries.push({
      refKey: `url:${key}`, kind: signal ? 'blog' : 'page', state: 'published', url: s.url, title: (s.title || '').slice(0, 300), topicKey: topicKey(s.title || '') || null,
      tokens: tokensForEntry({ title: s.title, url: s.url }), source: signal || 'snapshot', draftId: null, branchName: null, prUrl: null, filePath: null, contentHash: s.content_hash || null,
    });
  }

  for (const d of drafts) {
    if (!NET_NEW_ACTION_TYPES.has(d.action_type)) continue;
    let state = DRAFT_STATE_BY_STATUS[d.status];
    if (!state) continue;                                   // abandoned (or unknown): not being processed, so it blocks nothing
    if (d.status === 'pr_opened') {
      if (d.pr_state === 'closed') continue;                // closed without merging: the work is not in flight any more
      if (d.pr_state === 'merged') state = 'merged';
    }
    const title = titleOf(null, d);
    const topic = d.content?.topic || d.input?.topic || title;
    entries.push({
      refKey: `draft:${d.id}`, kind: 'blog', state, url: d.content?.url || null, title, topicKey: topicKey(`${topic} ${title}`) || null,
      tokens: tokensForEntry({ title: `${title} ${topic}`, url: d.content?.url || '', filePath: d.target_file_path || '' }), source: 'draft', draftId: d.id,
      branchName: d.branch_name || null, prUrl: d.pr_url || null, filePath: d.target_file_path || null, contentHash: null,
    });
  }
  return entries;
}
