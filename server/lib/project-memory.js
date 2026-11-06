import { createHash } from 'node:crypto';

// PROJECT MEMORY: what the platform knows about ONE project (a `sites` row), in one consistent shape, with where each
// fact came from and how fresh it is.
//
// This is a composition layer, not a store. Nothing here keeps a second copy of a fact: each section is read from the
// table that already owns it, so there is nothing to drift. The only thing persisted is project_memory_log (migration
// 226), which records WHEN a section's content changed (a version number, a hash and a small digest), never the
// content itself.
//
// It sits on top of lib/tenant-context.js rather than beside it: that module already assembles the business half
// (goals, industries, markets, SEO policy, product facts) for ~13 callers, so the 'business' section reuses it. The
// sections it did not cover (how the website is built, the captured design, the search baseline, what happened to
// previous work) are added here.
//
// ISOLATION. Every read is keyed by `siteId`, and a caller that knows which workspace it is acting for passes
// `expectWorkspaceId`: a project that belongs to a different workspace is reported as "not found" before any section
// is loaded. Who may ask is the caller's job (middleware, decideSiteAccess in store/workspaces.js); this module never
// widens access, it only narrows it.
//
// MISSING DATA IS NORMAL. A new project has most sections empty, and one table being unavailable must not stop a task
// that only wanted another section. Every section reports status 'ok' | 'empty' | 'error' and never throws.
//
// EVERY READER IS IMPORTED LAZILY (same reason as tenant-context.js: this repo's tests mock the stores with partial
// `mock.module` exports, and an eager import chain would break unrelated tests at instantiate time).

import { surgeStatus } from './surge-mode.js';
import { growthStageFor } from './growth-stage.js';

export const MEMORY_SECTIONS = Object.freeze(['business', 'technical', 'design', 'search', 'history']);

// [fresh until, aging until] in days. Past the second number a section is 'stale'. Search and history move daily; the
// business description and the site's technology change rarely, so they are allowed to be older before they are flagged.
const FRESHNESS_DAYS = Object.freeze({
  business: [90, 365],
  technical: [30, 120],
  design: [30, 90],
  search: [14, 45],
  history: [2, 14],
});

const DAY_MS = 86_400_000;

export function freshnessOf(section, asOf, now = new Date()) {
  const limits = FRESHNESS_DAYS[section];
  const t = asOf ? new Date(asOf).getTime() : NaN;
  if (!limits || Number.isNaN(t)) return 'unknown';
  const ageDays = (now.getTime() - t) / DAY_MS;
  if (ageDays <= limits[0]) return 'fresh';
  if (ageDays <= limits[1]) return 'aging';
  return 'stale';
}

// Stable JSON: object keys sorted, dates as ISO, so the same content always hashes the same regardless of the order a
// query happened to return its columns in.
function canonical(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function contentHash(data) {
  return createHash('sha256').update(canonical(data)).digest('hex');
}

// A few top-level facts about a section, small enough to keep forever: scalars as they are, arrays and objects as a
// size. Enough to tell a human what a version was about without storing the content.
export function digestOf(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (Array.isArray(v)) out[`${k}Count`] = v.length;
    else if (v && typeof v === 'object') out[`${k}Keys`] = Object.keys(v).length;
    else if (typeof v === 'string') out[k] = v.slice(0, 120);
    else if (v === null || ['number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

const latestOf = (...dates) => {
  const ts = dates.filter(Boolean).map((d) => new Date(d).getTime()).filter((t) => !Number.isNaN(t));
  return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
};

const DEFAULT_DEPS = {
  getSiteById: async (...a) => (await import('../store/read.js')).getSiteById(...a),
  loadTenantContext: async (...a) => (await import('./tenant-context.js')).loadTenantContext(...a),
  summarizeUnderstanding: async (...a) => (await import('../store/site-understanding.js')).summarize(...a),
  listFindings: async (...a) => (await import('../store/site-understanding.js')).listFindings(...a),
  isProfileUsable: async (p) => (await import('../design-agent/lib/design-profile.js')).isProfileUsable(p),
  profileCaptureGaps: async (p) => (await import('../design-agent/lib/design-profile.js')).profileCaptureGaps(p),
  getBaselineReport: async (...a) => (await import('../store/baseline-reports.js')).getBaselineReport(...a),
  listCompetitorProfiles: async (...a) => (await import('../store/competitor-profiles.js')).listCompetitorProfiles(...a),
  getLatestGeoAuditScore: async (...a) => (await import('../store/drafts.js')).getLatestGeoAuditScore(...a),
  keywordGapSummary: async (...a) => (await import('../store/project-memory-log.js')).keywordGapSummary(...a),
  countDraftsByLifecycle: async (...a) => (await import('../store/drafts.js')).countDraftsByLifecycle(...a),
  listDeploymentsForSite: async (...a) => (await import('../store/deployments.js')).listDeploymentsForSite(...a),
  impactByGenerator: async (...a) => (await import('../store/fix-impact.js')).impactByGenerator(...a),
  getBehaviourLearning: async (...a) => (await import('./behaviour-learning.js')).getBehaviourLearning(...a),
  getLatestMemoryVersion: async (...a) => (await import('../store/project-memory-log.js')).getLatestMemoryVersion(...a),
  insertMemoryVersion: async (...a) => (await import('../store/project-memory-log.js')).insertMemoryVersion(...a),
};

// ── Section loaders. Each returns { data, asOf, sources } or null when the project has nothing for that section. ──

async function loadBusiness(siteId, site, d) {
  const ctx = await d.loadTenantContext(siteId, { site });
  if (!ctx) return null;
  const goals = (ctx.goals || []).map((g) => ({
    id: g.id ?? null, objective: g.objective || g.description || null, goalType: g.goalType ?? null, primaryMetric: g.primaryMetric ?? null, targetBusinessArea: g.targetBusinessArea ?? null,
  }));
  const profile = ctx.siteProfile || null;
  const data = {
    propertyType: ctx.propertyType || null,
    industries: ctx.industries || [],
    markets: ctx.markets || [],
    icpSignals: ctx.icpSignals ?? null,
    conversionEvent: ctx.conversionEvent ?? null,
    goals,
    siteType: profile?.site_type ?? profile?.siteType ?? null,
    hasSeoPolicy: Boolean(ctx.seoPolicy),
  };
  const empty = !goals.length && !data.industries.length && !data.markets.length && !profile && !ctx.seoPolicy;
  if (empty) return null;
  return {
    data,
    asOf: latestOf(profile?.profiled_at, ...(ctx.goals || []).map((g) => g.updatedAt ?? g.updated_at)),
    sources: ['site_goals', 'site_profiles', 'site_seo_policy', 'product_growth_config'],
  };
}

async function loadTechnical(siteId, site, d) {
  const [categories, technology] = await Promise.all([
    d.summarizeUnderstanding(siteId),
    d.listFindings(siteId, { category: 'technology' }),
  ]);
  if (!categories?.length) return null;
  return {
    data: {
      repoConnected: Boolean(site.repo_name || site.repo_url),
      categories: categories.map((c) => ({ category: c.category, total: c.total, ready: c.ready, unresolved: c.unresolved, avgConfidence: c.avgConfidence })),
      technology: (technology || []).slice(0, 20).map((f) => ({ subject: f.subject, status: f.status, confidence: f.confidence == null ? null : Number(f.confidence), finding: f.finding })),
    },
    asOf: latestOf(...(technology || []).map((f) => f.updated_at)),
    sources: ['site_understanding'],
  };
}

// The design section is a SUMMARY: whether a usable profile exists, how complete it is and when it was captured. The
// profile itself (130-180 KB) stays where generators already read it, in sites.url_file_map.siteRoot.designProfile.
async function loadDesign(siteId, site, d) {
  const root = site?.url_file_map?.siteRoot || {};
  const profile = root.designProfile || null;
  const templates = Object.keys(root.componentTemplates || {});
  if (!profile && !templates.length) return null;
  const usable = profile ? await d.isProfileUsable(profile) : false;
  return {
    data: {
      profilePresent: Boolean(profile),
      usable,
      profileVersion: profile?.version ?? null,
      derivedAt: profile?.derivedAt ?? null,
      captureGaps: profile ? await d.profileCaptureGaps(profile) : [],
      componentTemplates: templates,
    },
    asOf: profile?.derivedAt ?? null,
    sources: ['sites.url_file_map.siteRoot.designProfile', 'sites.url_file_map.siteRoot.componentTemplates'],
  };
}

async function loadSearch(siteId, site, d) {
  const [baseline, competitors, geoScore, keywordGaps] = await Promise.all([
    d.getBaselineReport(siteId),
    d.listCompetitorProfiles(siteId),
    d.getLatestGeoAuditScore(siteId),
    d.keywordGapSummary(siteId),
  ]);
  const keywordCounts = Object.fromEntries((keywordGaps || []).map((r) => [r.status, r.n]));
  const hasAny = baseline || competitors?.length || geoScore != null || Object.keys(keywordCounts).length;
  if (!hasAny) return null;
  return {
    data: {
      baselineCapturedAt: baseline?.generated_at ?? null,
      baselineKpis: baseline?.kpi_snapshot ?? null,
      competitorDomains: (competitors || []).map((c) => c.domain).filter(Boolean),
      geoScore: geoScore ?? null,
      keywordBacklog: keywordCounts,
    },
    asOf: latestOf(baseline?.generated_at, ...(competitors || []).map((c) => c.last_analyzed_at), ...(keywordGaps || []).map((r) => r.latest)),
    sources: ['baseline_reports', 'competitor_profiles', 'drafts(geo-audit)', 'keyword_gaps'],
  };
}

// References to what happened to earlier work, kept as the stages the lifecycle really has: a draft existing, a PR
// being opened, a merge being observed, the deployment being detected on the live site, and an impact measurement.
// Nothing here states or implies that a change caused a result; that judgement belongs to the learning layer.
async function loadHistory(siteId, site, d) {
  const [lifecycle, deployments, impact, behaviour] = await Promise.all([
    d.countDraftsByLifecycle(siteId),
    d.listDeploymentsForSite(siteId, { limit: 10 }),
    d.impactByGenerator(siteId),
    // Behaviour learning is the richest part of this section and also the newest, so its failure must not take the
    // rest of the history down with it: it degrades to null and the other facts still load.
    d.getBehaviourLearning(siteId).catch(() => null),
  ]);
  if (!lifecycle?.total && !deployments?.length) return null;
  return {
    data: {
      drafts: lifecycle || null,
      recentDeployments: (deployments || []).map((x) => ({ id: x.id, status: x.status, prNumber: x.pr_number ?? null, mergedAt: x.merged_at ?? null, deployedAt: x.deployed_at ?? null })),
      measuredImpactByGenerator: impact || [],
      // What the history says about each generator on THIS project, with an evidence label, plus where all of this
      // project's work stands stage by stage (generated -> PR -> merged -> deployed -> measured).
      behaviour: behaviour
        ? {
          lifecycle: behaviour.lifecycle,
          generators: behaviour.generators.map((g) => ({ generatorId: g.generatorId, technicalEvidence: g.technicalEvidence, impactEvidence: g.impactEvidence, demoted: g.demoted, text: g.text })),
        }
        : null,
    },
    asOf: latestOf(...(deployments || []).map((x) => x.updated_at ?? x.merged_at)),
    sources: ['drafts', 'deployments', 'fix_impact', 'generator_outcomes'],
  };
}

const LOADERS = { business: loadBusiness, technical: loadTechnical, design: loadDesign, search: loadSearch, history: loadHistory };

async function loadSection(section, siteId, site, d, now) {
  try {
    const out = await LOADERS[section](siteId, site, d);
    if (!out) return { status: 'empty', data: null, provenance: { sources: [], asOf: null, freshness: 'unknown', loadedAt: now.toISOString() } };
    return {
      status: 'ok',
      data: out.data,
      provenance: { sources: out.sources, asOf: out.asOf, freshness: freshnessOf(section, out.asOf, now), loadedAt: now.toISOString() },
    };
  } catch (err) {
    // The reason is for the operator reading this; it is never used to infer anything about the project.
    return { status: 'error', data: null, reason: String(err?.message || err).slice(0, 200), provenance: { sources: [], asOf: null, freshness: 'unknown', loadedAt: now.toISOString() } };
  }
}

function projectNotInWorkspace() {
  // Same wording as a project that does not exist, so a caller cannot probe which ids belong to other workspaces.
  const err = new Error('Project not found');
  err.userFacing = true;
  err.status = 404;
  err.code = 'PROJECT_NOT_IN_WORKSPACE';
  return err;
}

export async function getProjectMemory(siteId, { sections = MEMORY_SECTIONS, expectWorkspaceId = null, deps = {}, now = new Date() } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const site = await d.getSiteById(siteId);
  if (!site) return null;
  if (expectWorkspaceId != null && Number(site.workspace_id) !== Number(expectWorkspaceId)) throw projectNotInWorkspace();

  const wanted = MEMORY_SECTIONS.filter((s) => sections.includes(s));
  const loaded = await Promise.all(wanted.map((s) => loadSection(s, siteId, site, d, now)));
  return {
    siteId: site.id,
    workspaceId: site.workspace_id ?? null,
    loadedAt: now.toISOString(),
    // Where the project is in its 30 / 30 / ongoing growth programme (sites.growth_started_at). Top level, not a section, so
    // the day counter never creates a "changed" memory version every morning.
    growth: growthStageFor(site.growth_started_at, now),
    surge: surgeStatus(site.surge_mode_until, now),
    sections: Object.fromEntries(wanted.map((s, i) => [s, loaded[i]])),
  };
}

// Records a new version for every section whose content changed since the last one. Only 'ok' sections are recorded:
// an 'error' section is a failed read, not a change, and must not look like one in the history. Safe to call daily;
// an unchanged project writes nothing.
export async function snapshotProjectMemory(siteId, { reason = 'manual', deps = {}, now = new Date() } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const memory = await getProjectMemory(siteId, { deps, now });
  if (!memory) return { siteId, found: false, changed: [], unchanged: [], skipped: [] };

  const result = { siteId, found: true, changed: [], unchanged: [], skipped: [] };
  for (const section of MEMORY_SECTIONS) {
    const s = memory.sections[section];
    if (s.status !== 'ok') { result.skipped.push({ section, status: s.status }); continue; }
    const hash = contentHash(s.data);
    const latest = await d.getLatestMemoryVersion(siteId, section);
    if (latest && latest.content_hash === hash) { result.unchanged.push(section); continue; }
    const row = await d.insertMemoryVersion(siteId, section, { contentHash: hash, digest: digestOf(s.data), provenance: s.provenance, reason });
    if (row) result.changed.push({ section, version: row.version });
    else result.unchanged.push(section); // another writer recorded this same change first
  }
  return result;
}
