import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { getRepoTree, getFileContent } from '../github/client.js';
import { findNamedExport, listTopLevelEntries } from '../implementers/adapters/lib/ts-export-data.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { resolveFile, resolveAdapter } from '../implementers/lib/url-file-map.js';

// READ-ONLY audit of one site's open recommendations: for every recommendation type, which can be written automatically, which can be
// resolved automatically with evidence, which need a human, and which cannot be processed safely yet (with the reason). Also lists
// every url_file_map entry that points at the wrong place, with the exact old value, the proposed new value and the affected
// recommendation ids. Performs SELECTs and GitHub reads only — it never writes to the database or to GitHub, and prints a proposal
// that a human applies separately.
//
//   node server/scripts/audit-recommendation-workflow.js --site-id 8862 [--tree-file tree.txt] [--out report.json]
//
// --repo-dir: read file contents from a local clone's origin/main (git show) instead of GitHub.
// --tree-file: a newline list of repo paths (e.g. `git ls-tree -r --name-only origin/main`) instead of calling GitHub.

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1]; };
const siteId = Number(arg('site-id'));
if (!siteId) { console.error('usage: --site-id <id> [--tree-file path] [--out path]'); process.exit(2); }

const slugOf = (url) => { try { return new URL(url).pathname.replace(/\/+$/, '').split('/').filter(Boolean); } catch { return null; } };
const pathOf = (url) => { try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return null; } };

// What actually serves this URL, from the repo tree only (no guessing from the URL's shape).
function servedBy(path, tree) {
  if (path === '/') return { kind: 'home', file: 'src/app/page.tsx' };
  const seg = path.split('/').filter(Boolean);
  const dedicated = `src/app${path}/page.tsx`;
  if (tree.has(dedicated)) return { kind: 'dedicated-page', file: dedicated };
  if (seg.length === 1 && tree.has(`src/content/blog/posts/${seg[0]}.json`)) return { kind: 'json-post', file: `src/content/blog/posts/${seg[0]}.json`, template: 'src/app/[slug]/page.tsx' };
  if (seg[0] === 'category' && seg.length === 2 && tree.has('src/app/category/[slug]/page.tsx')) return { kind: 'template-record', file: 'src/app/category/[slug]/page.tsx' };
  if (seg[0] === 'course-finder' && seg.length === 2 && tree.has('src/app/course-finder/[course]/page.tsx')) return { kind: 'computed-page', file: 'src/app/course-finder/[course]/page.tsx' };
  return { kind: 'unknown', file: null };
}

const isShared = (file) => !!file && /\[[^\]]+\]/.test(file);

async function main() {
  const site = await getSiteById(siteId);
  if (!site) throw new Error(`site ${siteId} not found`);
  const tree = new Set(arg('tree-file') ? readFileSync(arg('tree-file'), 'utf8').split('\n').filter(Boolean) : (await getRepoTree(site, baseBranch(site))).files);
  const map = site.url_file_map || {};
  const readRepoFile = async (path) => {
    if (arg('repo-dir')) { try { return execFileSync('git', ['-C', arg('repo-dir'), 'show', `origin/main:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return null; } }
    return (await getFileContent(site, path, baseBranch(site)))?.content ?? null;
  };
  // Keys that already carry curated FAQs in the category data store (read from the real file, never assumed).
  let categoryKeys = new Set();
  const pf = await readRepoFile('src/data/page-faqs.ts');
  if (pf) {
    const exp = findNamedExport(pf, 'categoryFaqs');
    const l = exp.ok && exp.kind === 'object' ? listTopLevelEntries(pf, exp.start, exp.end) : null;
    if (l?.ok) categoryKeys = new Set(l.entries.map((e) => e.key));
  }

  const { rows } = await pool.query(
    `select id, recommendation_type as type, page, issue, blocked_kind, blocked_reason from recommendations where site_id = $1 and status = 'open' order by recommendation_type, id`, [siteId]);

  // ---- target evidence per recommendation ----
  const recs = rows.map((r) => {
    const url = String(r.page || '').split('::')[0];
    const path = /^https?:/.test(url) ? pathOf(url) : null;
    const served = path ? servedBy(path, tree) : { kind: 'no-page', file: null };
    const resolved = path ? resolveFile(site, url) : null;
    const adapter = path ? resolveAdapter(site, url, r.type) : null;
    return { ...r, url, path, served, resolved, adapter: adapter?.id || null };
  });

  // ---- mapping corrections (exact old -> new) ----
  const corrections = [];
  const byUrl = new Map();
  for (const r of recs) {
    if (!r.path || r.served.kind !== 'dedicated-page') continue;
    if (r.resolved === r.served.file) continue;
    const e = byUrl.get(r.path) || { url: r.path, old: r.resolved, proposedFile: r.served.file, ids: [] };
    e.ids.push(r.id); byUrl.set(r.path, e);
  }
  for (const e of byUrl.values()) {
    const existing = map.pages?.[e.url];
    corrections.push({
      kind: existing ? 'repoint-page' : 'add-page',
      url: e.url,
      old: existing ? { file: existing.file } : `(no pages entry — resolved by pattern to ${e.old})`,
      new: { file: e.proposedFile },
      evidence: `${e.proposedFile} exists on the default branch and is this URL's own route; the current mapping resolves to ${e.old}${isShared(e.old) ? ' (a SHARED template used by every post)' : ''}.`,
      recommendationIds: e.ids,
    });
  }
  for (const [url, entry] of Object.entries(map.pages || {})) {
    if (entry.file && !tree.has(entry.file)) {
      corrections.push({
        kind: 'remove-stale-page',
        url, old: { file: entry.file }, new: '(remove entry)',
        evidence: `${entry.file} does not exist on the default branch. Check separately whether the URL redirects (nginx/static.conf) before removing.`,
        recommendationIds: recs.filter((r) => r.path === url).map((r) => r.id),
      });
    }
  }
  for (const p of map.patterns || []) {
    if (p.file?.includes('$1')) {
      const trailingSlashOnly = /\/\$$/.test(p.match);
      if (trailingSlashOnly) corrections.push({ kind: 'dead-pattern', url: p.match, old: { match: p.match, file: p.file }, new: '(remove pattern, or drop the required trailing slash only after confirming it cannot capture JSON posts)', evidence: 'Site URLs carry no trailing slash, so this never matches; and $1 files exist only for dedicated routes, not JSON posts.', recommendationIds: [] });
    }
  }

  // ---- per-type classification ----
  const dataStoreFaq = (r) => {
    if (r.path === '/blogs' || r.path === '/match-your-destination') return true;
    if (r.path?.startsWith('/category/')) return true;
    return r.served.kind === 'json-post';
  };
  const out = { writeAutomatically: [], resolveWithEvidence: [], needsHuman: [], cannotProcessYet: [] };
  const put = (bucket, r, reason, extra = {}) => out[bucket].push({ id: r.id, type: r.type, url: r.url || r.page, reason, ...extra });

  for (const r of recs) {
    const mismapped = r.served.kind === 'dedicated-page' && r.resolved !== r.served.file;
    const sharedTarget = isShared(r.resolved) && r.served.kind !== 'template-record';
    switch (r.type) {
      case 'blog-outline':
        put('needsHuman', r, 'New post: topic approval and a human read of the generated draft are required before anything is published; blog-outline target is mapped (see workflow audit for open gaps).');
        break;
      case 'direct-answer':
        put('cannotProcessYet', r, 'No page to attach it to (recommendation has no page URL) and newContentTargets["direct-answer"] points at src/app/blogs, which is not where Admizz serves /answers pages (src/app/answers/<slug>/page.tsx).');
        break;
      case 'translation':
        put('cannotProcessYet', r, 'Admizz has no locale routes or translation content directory; newContentTargets["translation"] must NOT be invented. Needs a human decision on whether and where a Nepali version should exist.');
        break;
      case 'faq':
        if (r.path === '/' ) put('cannotProcessYet', r, 'Homepage FAQ is rendered by src/app/HomepageFAQ.tsx; no data-store config exists for it yet.');
        else if (dataStoreFaq(r)) put('writeAutomatically', r, `Writable via ts-named-export-content once its config is added (needs production approval): ${r.path === '/blogs' ? 'page-faqs.ts blogIndexFaqs' : r.path === '/match-your-destination' ? 'page-faqs.ts destinationQuizFaqs' : r.path.startsWith('/category/') ? 'page-faqs.ts categoryFaqs["' + r.path.split('/')[2] + '"]' : 'post-faqs.ts postFaqs["' + r.path.slice(1) + '"]'}.`, { requires: 'adapter config approval' });
        else put('cannotProcessYet', r, `No data store for this page (served by ${r.served.kind} ${r.served.file || ''}); writing it would mean editing a page file by hand.`);
        break;
      case 'qa-content':
        if (r.served.kind === 'computed-page') put('resolveWithEvidence', r, '/course-finder/* FAQs are generated at build time by buildCourseFaqs() (src/lib/university-kb/course-faq.ts) from the course data, and the pages are noindex. There is no per-page store to write; editing the shared template is forbidden. Resolve as not-applicable (needs human OK).', { requires: 'human approval to close' });
        else if (r.path?.startsWith('/category/')) {
          const key = r.path.split('/')[2];
          if (categoryKeys.has(key)) put('resolveWithEvidence', r, `categoryFaqs["${key}"] already exists in src/data/page-faqs.ts, so the category page already renders curated Q&A. Re-read the live page to confirm before closing.`, { requires: 'live-page confirmation + human OK to close' });
          else put('needsHuman', r, `categoryFaqs has no "${key}" entry. A faq draft could create one through ts-named-export-content (once configured), but qa-content asks for question headings — a human should choose.`);
        }
        else put('needsHuman', r, 'Question-style headings on a page whose body is authored by hand/inline data; no safe automatic target.');
        break;
      case 'meta-title': case 'canonical': case 'open-graph':
        if (mismapped) put('cannotProcessYet', r, `Mapped to shared ${r.resolved}; correct file ${r.served.file} — fix the mapping first (see corrections).`, { afterCorrection: 'needs-verification' });
        else if (r.served.kind === 'json-post') put('cannotProcessYet', r, 'JSON post served by the shared [slug] template: title/description come from the post JSON, which no writer targets yet.');
        else put('writeAutomatically', r, 'Mapped page file + nextjs-metadata-export adapter.', { note: 'needs-verification: adapter refuses safely if the page has no static metadata export' });
        break;
      case 'schema-repair': case 'internal-links': case 'breadcrumbs': case 'expand-content': case 'refresh-content':
      case 'content-integrity-repair': case 'duplicate-id-fix': case 'sitemap-removal': case 'sitemap':
        if (r.served.kind === 'json-post' || sharedTarget || mismapped) put('cannotProcessYet', r, `Resolves to shared template ${r.resolved || '(none)'}; the content lives ${r.served.kind === 'json-post' ? 'in ' + r.served.file : 'in ' + (r.served.file || 'an unknown file')}. The shared-template guard (checkSharedTemplateWrite) will stop the write.`);
        else put('needsHuman', r, 'Page-specific edit on a dedicated page whose body is an inline data object; review the draft before apply.', { note: 'needs-verification' });
        break;
      default:
        put('needsHuman', r, 'Unclassified type.');
    }
  }

  const summary = {};
  for (const [bucket, list] of Object.entries(out)) for (const x of list) { const k = `${x.type}`; summary[k] = summary[k] || {}; summary[k][bucket] = (summary[k][bucket] || 0) + 1; }
  const report = { generatedAt: new Date().toISOString(), siteId, readOnly: true, openRecommendations: recs.length, summary, ...out, mappingCorrections: corrections };
  const text = JSON.stringify(report, null, 2);
  if (arg('out')) writeFileSync(arg('out'), text); else console.log(text);
  await pool.end();
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
