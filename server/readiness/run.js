import { inferMappings } from '../discovery/infer-patterns.js';
import { planUrlPattern, planPageEntries } from '../discovery/url-pattern.js';
import { planHeadTargets } from '../discovery/head-targets.js';
import { planSetupPr } from '../implementers/lib/setup-pr.js';
import { resolveFile, resolveActionFile } from '../implementers/lib/url-file-map.js';
import { layoutDerivesHead, classifyGaps, groupGaps } from './stacks.js';
import { collectLayoutText, deriveKeys } from './layouts.js';

// SITE READINESS: the one pass that makes a project ready for the daily agent, for ANY stack. In order:
//   1 learn the stack from the repository
//   2 complete the page list (so no page is invisible)
//   3 map every page to its template file(s), inferred from the repository and strictly validated
//   4 plan the markers (placing them, or adopting the head tags that already exist)
//   5 the COMPLETENESS GATE: every page and marker is placed, or listed with a stated reason. A page can never silently miss a marker
//   6 design capture: queue it when the project has none
// Without `apply` it reads everything and changes nothing. With `apply` it saves the mapping (read back through the daily run's own resolver, the old
// mapping restored on any difference) and queues the design capture. Opening the setup PR is a separate step that uses the plan this returns.

const DEFAULT_DEPS = {
  async learn(site) { return (await import('../discovery/run-discovery.js')).runDiscovery(site); },
  async refreshPages(site) { return (await import('../job.js')).runSiteDiscoveryIfDue(site, { force: true }); },
  async listPages(site) {
    const { listPageInventory } = await import('../store/page-inventory.js');
    return (await listPageInventory(site.id, { limit: 5000 })).map((r) => String(r.page || '')).filter(Boolean);
  },
  async repoTree(site) { const { getRepoTree } = await import('../github/client.js'); return getRepoTree(site, site.repo_default_branch || 'main'); },
  async readFile(site, path, ref) { const { getFileContent } = await import('../github/client.js'); const f = await getFileContent(site, path, ref); return f ? f.content : null; },
  async saveMap(site, nextMap) { const { updateSiteRepoConfig } = await import('../db.js'); await updateSiteRepoConfig({ siteId: site.id, urlFileMap: nextMap }); },
  async reloadSite(site) { return (await import('../store/read.js')).getSiteById(site.id); },
  async designState(site) {
    const { siteHasUsableDesignProfile } = await import('../implementers/lib/design-drift.js');
    const { getQueuedComponentTemplateJob, getLatestDesignAgentJob, DESIGN_PROFILE_JOB_KEY } = await import('../store/execution-jobs.js');
    if (siteHasUsableDesignProfile(site)) return { state: 'usable' };
    const pending = await getQueuedComponentTemplateJob(site.id, DESIGN_PROFILE_JOB_KEY);
    if (pending) return { state: 'queued', jobId: pending.id };
    const last = await getLatestDesignAgentJob(site.id, DESIGN_PROFILE_JOB_KEY).catch(() => null);
    return last ? { state: last.status === 'failed' ? 'failed' : 'none', lastJob: { id: last.id, status: last.status } } : { state: 'none' };
  },
  async queueDesign(site) { return (await import('../job.js')).queueDesignAgentDerivationForSite(site); },
  async markerTypes() { return (await import('../implementers/backend.js')).MARKER_MERGE_TYPES; },
  hostOf: (site) => site.website_domain || null,
};

export async function runSiteReadiness(site, { apply = false, deps = {}, log = console } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const report = { siteId: site.id, name: site.name, apply, stack: null, steps: {} };
  const ref = site.repo_default_branch || 'main';
  if (!site.repo_owner || !site.repo_name) return { ...report, ready: false, reason: 'no-repository-connected' };

  // 1. the stack
  let learned = null;
  try { learned = await d.learn(site); } catch (err) { log.error?.(`[readiness] site ${site.id}: discovery failed, using the saved mapping:`, err?.message); }
  report.stack = learned?.technology?.framework?.name || null;
  report.steps.learn = { ok: Boolean(learned?.ok), stack: report.stack };

  // 2. the page list. Only HTML pages carry markers: robots.txt, llms.txt, sitemaps, feeds, images and the like are listed as excluded, not as gaps.
  if (apply) { try { await d.refreshPages(site); } catch (err) { log.error?.(`[readiness] site ${site.id}: page discovery failed:`, err?.message); } }
  const allPages = await d.listPages(site);
  const NON_HTML = /\.(txt|xml|json|webmanifest|pdf|png|jpe?g|gif|svg|webp|avif|ico|css|js|map|zip|rss|atom|csv)$/i;
  const pages = allPages.filter((p) => { try { return !NON_HTML.test(new URL(p).pathname); } catch { return true; } });
  report.steps.pages = { count: pages.length, excluded: allPages.length - pages.length };

  // 3. the mapping
  const tree = await d.repoTree(site);
  const repoFiles = tree.files;
  const host = d.hostOf(site);
  let map = site.url_file_map || {};
  const mapNotes = []; const expect = [];

  // 3a. AUDIT what is already mapped. A pattern that sends a whole family of pages to ONE dynamic template (`src/pages/blog/[slug].astro`) is a mapping
  // every page shares, so a marker there would be one marker for all of them and a fix would be refused as a shared-template write. When each page has
  // its own file (an Astro content collection, `src/content/blog/<slug>.md`), the pattern is replaced, with the same strict validation as any other.
  for (const p of [...(map.patterns || [])]) {
    if (/\$\d/.test(p.file) || !/\[[^\]]+\]/.test(p.file)) continue;                 // not a shared dynamic template
    let re; try { re = new RegExp(p.match); } catch { continue; }
    const covered = pages.filter((u) => { try { const path = new URL(u).pathname; const n = path.length > 1 ? path.replace(/\/+$/, '') : path; return re.test(n) || re.test(path); } catch { return false; } });
    if (covered.length < 2) continue;
    const better = inferMappings({ unmappedPages: covered, repoFiles }).patterns.find((x) => x.match === p.match && x.covers === covered.length);
    if (!better) { mapNotes.push(`pattern ${p.match} -> ${p.file} is a shared template and no per-page files were found for its ${covered.length} pages`); continue; }
    const r = planUrlPattern({ siteMap: map, match: p.match, file: better.file, pages, repoFiles, host, replace: true });
    if (r.ok) { map = r.nextMap; expect.push(...r.newlyMapped.map((m) => ({ page: m.page, type: null, file: m.file }))); mapNotes.push(`pattern ${p.match}: shared template ${p.file} replaced by each page's own file ${better.file} (${r.newlyMapped.length} pages)`); }
    else mapNotes.push(`pattern ${p.match} replacement refused: ${r.reason}`);
  }

  const unmappedBefore = pages.filter((p) => !resolveFile({ website_domain: host, url_file_map: map }, p));
  const inferred = inferMappings({ unmappedPages: unmappedBefore, repoFiles });
  for (const p of inferred.patterns) {
    const r = planUrlPattern({ siteMap: map, match: p.match, file: p.file, pages, repoFiles, host });
    if (r.ok) { map = r.nextMap; expect.push(...r.newlyMapped.map((m) => ({ page: m.page, type: null, file: m.file }))); mapNotes.push(`pattern ${p.match} -> ${p.file} (${r.newlyMapped.length} pages)`); }
    else mapNotes.push(`pattern ${p.match} refused: ${r.reason}`);
  }
  const exactGaps = [];
  for (const e of inferred.pages) {
    const r = planPageEntries({ siteMap: map, entries: [e], repoFiles });
    if (r.ok) { map = r.nextMap; expect.push({ page: `https://${host}${e.path === '/' ? '/' : e.path}`, type: null, file: e.file }); }
    else exactGaps.push({ page: `https://${host}${e.path}`, reason: r.reason });
  }
  const readFile = (() => { const c = new Map(); return async (path) => { if (!c.has(path)) c.set(path, await d.readFile(site, path, ref).catch(() => null)); return c.get(path); }; })();
  const siteLayout = site.url_file_map?.siteRoot?.layoutTemplate || null;
  const layoutByFile = new Map();
  const layoutTextFor = async (pageFile) => {
    if (!layoutByFile.has(pageFile)) layoutByFile.set(pageFile, await collectLayoutText({ pagePath: pageFile, pageContent: await readFile(pageFile), readFile, repoFiles, siteLayoutPath: siteLayout }));
    return layoutByFile.get(pageFile);
  };

  // 3b. The front-matter keys the site's layout really renders as title and description (`metaDescription`, ...), read from its own layout chain. When they
  // differ from the platform's field names and every sampled page agrees, they are saved as the site-wide key alias for meta-title (never overwriting one a person set).
  const mappedNow = () => ({ website_domain: host, url_file_map: map });
  const sampleFiles = [...new Set(pages.map((p) => resolveFile(mappedNow(), p)).filter(Boolean))].slice(0, 6);
  const keySets = []; for (const f of sampleFiles) keySets.push(deriveKeys(await layoutTextFor(f)));
  const agreed = {};
  for (const field of ['title', 'description']) {
    const vals = keySets.map((k) => k[field]).filter(Boolean);
    if (vals.length && vals.length === keySets.length && vals.every((v) => v === vals[0]) && vals[0] !== field) agreed[field] = vals[0];
  }
  const existingKeys = map.defaults?.placements?.['meta-title']?.lineKeys;
  if (Object.keys(agreed).length && !existingKeys) {
    const placements = { ...(map.defaults?.placements || {}), 'meta-title': { ...(map.defaults?.placements?.['meta-title'] || {}), lineKeys: agreed } };
    map = { ...map, defaults: { ...(map.defaults || {}), placements } };
    mapNotes.push(`front-matter keys read from the layout: ${Object.entries(agreed).map(([f, k]) => `${f} -> ${k}`).join(', ')}`);
  }
  const ht = await planHeadTargets({ siteMap: map, pages, host, repoFiles, readFile });
  if (ht.ok) { map = ht.nextMap; for (const c of ht.configured) for (const t of c.types) expect.push({ page: c.page, type: t, file: c.headFile }); mapNotes.push(`head files for ${ht.configured.length} pages`); }
  const mapped = { website_domain: host, url_file_map: map };
  const stillUnmapped = pages.filter((p) => !resolveFile(mapped, p));
  // A section with no file per page may be GENERATED by one template (Eleventy pagination: one page per data item). Name it: that is a different problem
  // from "no file", and the one a data adapter solves.
  const generatedBy = async (page) => {
    let section; try { section = new URL(page).pathname.split('/').filter(Boolean)[0]; } catch { return null; }
    if (!section) return null;
    // Files that belong to the section: inside a directory named for it, or named for it (`features.njk`). Not any file whose name merely contains the word.
    const sec = section.toLowerCase();
    const cands = repoFiles.filter((f) => /\.(njk|liquid|md|html)$/i.test(f)).filter((f) => { const lower = f.toLowerCase(); const base = lower.split('/').pop().replace(/\.[^.]+$/, ''); return lower.includes(`/${sec}/`) || base === sec; }).slice(0, 12);
    for (const f of cands) { const txt = await readFile(f); const fm = txt && /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt); if (fm && /(^|\n)\s*"?pagination"?\s*:/.test(fm[1])) return `generated-by-a-template (${f}: one page per data item; needs a data adapter)`; }
    return null;
  };
  const whyUnmapped = new Map([...inferred.gaps, ...exactGaps].map((g) => [g.page, g.reason]));
  for (const p of stillUnmapped) { const g = await generatedBy(p); if (g) whyUnmapped.set(p, g); }
  report.steps.mapping = {
    changed: map !== (site.url_file_map || {}), notes: mapNotes,
    unmapped: stillUnmapped.map((p) => ({ page: p, reason: whyUnmapped.get(p) || whyUnmapped.get(p.replace(/\/$/, '')) || 'no-template-file-in-the-repository' })),
  };

  // 4. the markers
  const planSite = { ...site, url_file_map: map };
  const plan = await planSetupPr(planSite, { listPages: async () => pages, readFile: async (s, path) => readFile(path), markerTypes: d.markerTypes });
  report.steps.plan = { files: plan.files.length, markers: plan.files.reduce((n, f) => n + f.added.length, 0), placedCount: plan.placedCount, truncated: plan.truncated };

  // 5. the completeness gate
  const derivesCache = new Map();
  // Decided per page from its OWN layout chain (a site may have several layouts), computed once per file before classifying.
  for (const g of plan.gaps) {
    if (g.marker !== 'OPENGRAPH' && g.marker !== 'CANONICAL') continue;
    const pageFile = resolveFile(mapped, g.page) || g.path;
    if (derivesCache.get(pageFile) == null) derivesCache.set(pageFile, layoutDerivesHead(await layoutTextFor(pageFile)));
  }
  const derivesForGap = (g) => derivesCache.get(resolveFile(mapped, g.page) || g.path) || {};
  // A markdown page whose meta description is its `excerpt:` (which also feeds blog cards) has no `description:` line to mark. Say that, not "no front matter".
  for (const g of plan.gaps) {
    if (g.marker !== 'METADESCRIPTION' || g.reason !== 'no-front-matter' || !/\.mdx?$/i.test(g.path)) continue;
    const txt = await readFile(g.path);
    if (txt && /^excerpt\s*:/m.test(txt) && !/^description\s*:/m.test(txt)) g.reason = 'description-lives-in-the-excerpt-field';
  }
  // A page without a `title:` (or description) key at all: the layout falls back to a default, and creating the key would add a value, which a setup PR never does.
  for (const g of plan.gaps) {
    if ((g.marker === 'TITLE' || g.marker === 'METADESCRIPTION') && /^creating it would add a value/.test(g.reason)) g.reason = `page-has-no-${g.marker === 'TITLE' ? 'title' : 'description'}-key`;
  }
  const { open, notApplicable } = classifyGaps(plan.gaps, { derivesFor: derivesForGap, exclusions: site.url_file_map?.siteRoot?.readiness?.exclusions || [] });
  report.gate = {
    markersComplete: open.length === 0 && stillUnmapped.length === 0,
    openGaps: groupGaps(open), notApplicable: groupGaps(notApplicable),
    unmapped: report.steps.mapping.unmapped.length, placed: plan.placedCount,
  };

  // 6. design capture
  const design = await d.designState(site);
  report.design = design;
  if (apply && (design.state === 'none' || design.state === 'failed')) {
    const queued = await d.queueDesign(site).catch(() => false);
    report.design = { ...design, queuedNow: Boolean(queued) };
  }

  // apply: save the mapping, read it back, restore on any difference
  if (apply && report.steps.mapping.changed) {
    const old = site.url_file_map || {};
    await d.saveMap(site, map);
    const saved = (await d.reloadSite(site)) || planSite;
    const bad = expect.filter((m) => (m.type ? resolveActionFile(saved, m.page, m.type) : resolveFile(saved, m.page)) !== m.file);
    if (bad.length) { await d.saveMap(site, old); report.steps.mapping.rolledBack = { count: bad.length, example: bad[0].page }; report.ready = false; return { ...report, plan }; }
    report.steps.mapping.saved = true;
  }
  report.ready = report.gate.markersComplete && report.design.state === 'usable';
  return { ...report, plan, nextMap: map };
}

// The compact form kept on the project and shown in reports: no file contents, only what a person needs to see.
export function summarizeReadiness(r) {
  return {
    at: new Date().toISOString(), apply: Boolean(r.apply), stack: r.stack, ready: Boolean(r.ready),
    pages: r.steps?.pages?.count ?? null, excludedPages: r.steps?.pages?.excluded ?? 0,
    mapping: { changed: Boolean(r.steps?.mapping?.changed), saved: Boolean(r.steps?.mapping?.saved), rolledBack: r.steps?.mapping?.rolledBack || null, notes: r.steps?.mapping?.notes || [], unmapped: (r.steps?.mapping?.unmapped || []).length, unmappedExamples: (r.steps?.mapping?.unmapped || []).slice(0, 5) },
    plan: r.steps?.plan || null,
    gate: r.gate ? { markersComplete: r.gate.markersComplete, placed: r.gate.placed, unmapped: r.gate.unmapped, openGaps: r.gate.openGaps, notApplicable: r.gate.notApplicable } : null,
    design: r.design || null,
    reason: r.reason || null,
  };
}
