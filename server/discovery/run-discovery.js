import { getRepoTree, getFileContent } from '../github/client.js';
import { detectTechnology } from './detect-technology.js';
import { discoverPageStructure } from './discover-page-structure.js';
import { discoverRoutes } from './discover-routes.js';
import { recordFinding, summarize } from '../store/site-understanding.js';
import { autoConfigure } from './auto-configure.js';
// Reused, never reimplemented (§3/§4): structural-detect.js already performs
// semantic container detection, and design-profile.js already defines and
// validates the design profile shape. Discovery's job is to invoke them and
// record what they establish, not to grow a parallel copy of either.
import { detectInsertionPoint } from '../implementers/lib/structural-detect.js';
import { isProfileUsable } from '../design-agent/lib/design-profile.js';

// Orchestrates repository discovery for one site and persists what it can
// justify (Phase 2, §1/§9/§14).
//
// This module INSPECTS ONLY. It writes to site_understanding (a metadata
// table) and never to the client's repository — the §13 boundary. Projecting
// safe findings into url_file_map is a separate, explicit step so that
// "we learned something" and "we changed the configuration that drives real
// edits" can never happen accidentally in one pass.

// The autonomy policy (§9), in one place so every category is judged the same
// way and the rule can be read without tracing call sites.
//
// The asymmetry is deliberate: high confidence alone is not a licence to act.
// A shared layout the engine is 98% sure about still changes hundreds of
// pages if it is wrong, so it goes to a human; a single content record it is
// 85% sure about affects one page and can be configured. Blast radius decides
// what confidence has to buy.
export function decideAutonomy({ confidence, risk }) {
  const c = typeof confidence === 'number' ? confidence : confidence?.value ?? 0;

  if (c < 0.5) {
    return { status: c === 0 ? 'discovered' : 'needs_confirmation', autoConfigure: false, reason: 'insufficient evidence to act without confirmation' };
  }
  if (risk === 'high') {
    // Never auto-applied at any confidence — the blast radius is the point.
    return { status: 'needs_confirmation', autoConfigure: false, reason: 'high blast radius: affects many pages, so a human confirms even when confidence is high' };
  }
  if (c >= 0.85 && risk === 'low') {
    return { status: 'auto_configured', autoConfigure: true, reason: 'high confidence and low blast radius' };
  }
  if (c >= 0.85) {
    return { status: 'validated', autoConfigure: false, reason: 'high confidence, but medium blast radius warrants validation before configuring' };
  }
  return { status: 'needs_confirmation', autoConfigure: false, reason: 'medium confidence — a human should confirm' };
}

// A finding that cannot name its evidence must not be persisted (§8, and the
// CHECK constraint in migration 112). Failing loudly here beats discovering
// at INSERT time that the engine tried to record a belief it can't justify.
function assertEvidence(subject, evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error(`refusing to record "${subject}" with no evidence — every finding must be justifiable`);
  }
}

export async function runDiscovery(site, {
  fetchTree = getRepoTree,
  fetchFile = getFileContent,
  persist = recordFinding,
  // Synchronous (path) -> string|null reader over a checked-out copy of the
  // repo. Optional: without it, discovery still runs but route and insertion
  // detection are skipped rather than guessed, since both require real file
  // content and neither may be inferred from paths alone.
  readFile = null,
} = {}) {
  if (!site?.repo_owner || !site?.repo_name) {
    // Not a failure of discovery — there is simply nothing to inspect yet.
    return { ok: false, reason: 'no-repo-configured', findings: [], summary: [] };
  }

  const branch = site.repo_default_branch || 'main';
  const { files, truncated } = await fetchTree(site, branch);

  // package.json is the single strongest technology signal; a repo without
  // one (Hugo, Jekyll) is normal and detection falls back to config files.
  const pkgRaw = await fetchFile(site, 'package.json', branch).then((r) => r?.content ?? r).catch(() => null);

  const tech = detectTechnology({ files, packageJsonRaw: pkgRaw });
  const structure = discoverPageStructure({ files, templateLanguages: tech.templateLanguages });

  const findings = [];
  const record = async (row) => {
    assertEvidence(row.subject, row.evidence);
    const decision = decideAutonomy({ confidence: row.confidence, risk: row.risk });
    const saved = await persist(site.id, { ...row, status: decision.status });
    findings.push({ ...row, status: saved?.status ?? decision.status, decision });
  };

  // ---- technology -------------------------------------------------------
  if (tech.framework) {
    await record({
      category: 'technology',
      subject: `framework:${tech.framework.id}`,
      finding: {
        id: tech.framework.id, name: tech.framework.name, kind: tech.framework.kind,
        ambiguous: tech.framework.ambiguous, alternatives: tech.framework.alternatives,
        buildScripts: tech.buildScripts, packageManager: tech.packageManager?.id ?? null,
        templateLanguages: tech.templateLanguages,
      },
      evidence: tech.framework.evidence,
      confidence: tech.framework.confidence.value,
      // Knowing the framework changes no file by itself — recording it is
      // inert, so it carries no blast radius of its own.
      risk: 'low',
    });
  }

  for (const target of tech.deploymentTargets) {
    await record({
      category: 'deployment',
      subject: `target:${target.id}`,
      finding: { id: target.id },
      evidence: target.evidence,
      confidence: 0.9,
      // Deployment config is infrastructure: never auto-modified (§13).
      risk: 'high',
    });
  }

  // ---- page types -------------------------------------------------------
  for (const pt of structure.pageTypes) {
    await record({
      category: 'page-type',
      subject: pt.directory,
      finding: {
        name: pt.name, directory: pt.directory, fileCount: pt.fileCount,
        kind: pt.kind, extensions: pt.extensions, sampleFiles: pt.files.slice(0, 5),
      },
      evidence: pt.evidence,
      confidence: pt.confidence.value,
      risk: pt.risk,
    });
  }

  // ---- shared infrastructure -------------------------------------------
  // Recorded specifically so later agents know what NOT to touch unattended.
  for (const shared of structure.sharedInfrastructure) {
    await record({
      category: 'shared-infrastructure',
      subject: shared.path,
      finding: { path: shared.path, reason: shared.reason, requiresConfirmation: true },
      evidence: shared.evidence,
      confidence: 0.95,
      risk: 'high',
    });
  }

  // ---- data sources -----------------------------------------------------
  for (const ds of structure.dataSources) {
    await record({
      category: 'data-source',
      subject: ds.path,
      finding: { path: ds.path, reason: ds.reason },
      evidence: ds.evidence,
      confidence: 0.9,
      risk: ds.risk,
    });
  }

  // ---- routes -----------------------------------------------------------
  // Only page-bearing files are worth reading; `readFile` is supplied by the
  // caller so a checked-out tarball can back this with one API call instead
  // of one per file.
  const pageFiles = structure.pageTypes.flatMap((pt) => pt.files);
  const routeResult = readFile
    ? discoverRoutes({ files, pageFiles, readFile })
    : { routes: [], families: [], unresolved: [] };

  for (const family of routeResult.families) {
    await record({
      category: 'route-family',
      subject: family.directory,
      finding: {
        directory: family.directory, routePattern: family.routePattern,
        count: family.count, sampleRoutes: family.sampleRoutes,
        // The shared template every route in this family renders through is
        // the natural `patterns[].file` target.
        templateFile: family.templateFile || null,
      },
      evidence: family.evidence,
      confidence: family.confidence,
      risk: 'low',
    });
  }

  // ---- insertion strategy (§3) -----------------------------------------
  // One representative file per page type, not every file: the detector
  // answers a question about the TEMPLATE's shape, which files in a family
  // share. Sampling keeps onboarding to a handful of reads while still
  // resting on real file content rather than convention.
  if (readFile) {
    for (const pt of structure.pageTypes.slice(0, 8)) {
      const sample = pt.files[0];
      const content = readFile(sample);
      if (!content) continue;
      let detected = null;
      try { detected = detectInsertionPoint(content, sample); } catch { detected = null; }
      if (!detected?.ok) {
        // No safe location could be proven — recorded as unresolved rather
        // than inventing one (§3).
        await record({
          category: 'insertion-point',
          subject: pt.directory,
          finding: { sampleFile: sample, resolved: false, reason: 'no safe semantic container could be proven in this template' },
          evidence: [{ kind: 'structural-detection', detail: 'structural-detect.js found no qualifying content container', source: sample }],
          confidence: 0.3,
          risk: 'medium',
        });
        continue;
      }
      await record({
        category: 'insertion-point',
        subject: pt.directory,
        finding: {
          sampleFile: sample, resolved: true, fileKind: detected.fileKind,
          container: detected.containerDescription, strategy: 'structural-detect',
        },
        evidence: [{
          kind: 'structural-detection',
          detail: `semantic container "${detected.containerDescription}" detected in a ${detected.fileKind} file`,
          source: sample,
        }],
        confidence: 0.9,
        // Where generated content lands affects only pages of this type.
        risk: 'low',
      });
    }
  }

  // ---- design profile (§4) ---------------------------------------------
  // Discovery does not DERIVE the profile — that is the Design Agent's job,
  // in its sandbox, and duplicating it here would be the second design system
  // §4 forbids. What discovery does is record whether a usable profile exists
  // yet, so onboarding readiness reflects reality instead of assuming it.
  const existingProfile = site.url_file_map?.siteRoot?.designProfile || null;
  const profileUsable = existingProfile ? isProfileUsable(existingProfile) : false;
  await record({
    category: 'design-profile',
    subject: 'site-design-language',
    finding: profileUsable
      ? { present: true, derivedBy: existingProfile.derivedBy, derivedAt: existingProfile.derivedAt,
        typography: !!existingProfile.typography, components: Object.keys(existingProfile.components || {}) }
      : { present: false, reason: existingProfile ? 'a profile exists but does not validate as usable' : 'no design profile derived yet — the Design Agent must run' },
    evidence: [{
      kind: 'config-inspection',
      detail: profileUsable
        ? `url_file_map.siteRoot.designProfile validates as usable (derived by ${existingProfile.derivedBy})`
        : 'url_file_map.siteRoot.designProfile is absent or fails validateDesignProfile',
      source: 'sites.url_file_map.siteRoot.designProfile',
    }],
    confidence: profileUsable ? 0.95 : 0.2,
    risk: 'low',
  });

  // ---- project the safe subset into url_file_map (§1) --------------------
  // Runs last, over findings the autonomy policy already cleared, and only
  // writes what it can then read back through the real resolvers.
  const projectable = findings.filter((f) => f.decision.autoConfigure);
  const configured = await autoConfigure(site, projectable);

  const summary = await summarize(site.id);
  return {
    ok: true,
    repo: `${site.repo_owner}/${site.repo_name}@${branch}`,
    fileCount: files.length,
    // A truncated tree means findings are based on a partial view — surfaced
    // rather than silently treated as complete.
    truncated: !!truncated,
    technology: tech,
    structure,
    routes: routeResult,
    designProfile: { present: profileUsable },
    findings,
    autoConfigured: configured,
    summary,
  };
}
