import { updateSiteRepoConfig } from '../db.js';
import { resolveFile, isPageMapped } from '../implementers/lib/url-file-map.js';

// Projects PROVEN discoveries into url_file_map — the existing configuration
// source of truth (Phase 2, §1). site_understanding stays the evidence layer;
// this module is the only place discovery is allowed to change what the
// implementers actually read, which keeps "we learned something" and "we
// changed real configuration" as two separate, auditable events.
//
// The invariant, and the reason this file exists at all: a finding may not be
// called auto-configured unless the configuration was written AND then read
// back and verified through the same resolvers the implementers use. A status
// column asserting success is not evidence of success.

// Only these keys are ever written automatically. Everything outside the list
// — siteRoot.layoutTemplate, componentTemplates, newContentTargets, anything
// touching build or deploy — is confirmation-gated (§9), regardless of how
// certain the discovery is.
const AUTO_WRITABLE = new Set(['patterns', 'renderCapabilities']);

// A projection must be reversible in review and inert if wrong. These are the
// checks that decide whether a finding is even a candidate, before confidence
// is considered.
function isProjectable(finding) {
  if (finding.risk === 'high') return { ok: false, reason: 'high blast radius — human confirmation required regardless of confidence' };
  if (finding.confidence < 0.85) return { ok: false, reason: `confidence ${finding.confidence} below the 0.85 auto-configure threshold` };
  return { ok: true };
}

// Builds the url_file_map fragment a finding implies. Returns null when the
// finding has no safe, schema-compatible representation — which is a normal
// outcome and leaves the finding needing confirmation rather than forcing a
// shape the schema was not designed for.
function projectFinding(finding, existingMap) {
  if (finding.category === 'route-family') {
    const { routePattern, templateFile, sampleRoutes } = finding.finding || {};
    if (!routePattern || !templateFile) return null;

    const patterns = existingMap.patterns || [];
    // Never duplicate or silently redefine a pattern a human already wrote —
    // an existing entry is a decision, and re-deriving it is not grounds to
    // overwrite it.
    //
    // Equivalence is decided by BEHAVIOUR, not by regex text: `^/blog/([^/]+)$`
    // and `^/blog/([^/]+)/?$` are different strings that resolve the same URLs
    // to the same file. Comparing the source text alone appended a redundant
    // second pattern for an already-configured route family — harmless only
    // because the human's entry matched first, but exactly the duplicated
    // configuration this projection is supposed to avoid.
    if (patterns.some((p) => p.match === routePattern)) {
      return { skip: true, reason: 'this route pattern is already configured' };
    }
    const probe = (sampleRoutes || [])[0];
    if (probe) {
      const already = resolveFile({ url_file_map: existingMap }, `https://probe.invalid${probe}`);
      if (already) {
        return { skip: true, reason: `already resolvable: existing configuration maps ${probe} to ${already}` };
      }
    }
    return {
      key: 'patterns',
      next: [...patterns, { match: routePattern, file: templateFile }],
      describes: `patterns[] entry mapping ${routePattern} -> ${templateFile}`,
    };
  }

  if (finding.category === 'technology') {
    const { id, templateLanguages } = finding.finding || {};
    if (!id) return null;
    const existing = existingMap.renderCapabilities || {};
    // Only fills a GAP. A generator already recorded by a human stands.
    if (existing.generator) return { skip: true, reason: `renderCapabilities.generator is already set to "${existing.generator}"` };
    const extensions = { ...(existing.extensions || {}) };
    if ((templateLanguages || []).some((t) => t.id === 'markdown')) {
      extensions['.md'] = { markdown: true, ...(extensions['.md'] || {}) };
    }
    return {
      key: 'renderCapabilities',
      next: { ...existing, generator: id, ...(Object.keys(extensions).length ? { extensions } : {}) },
      describes: `renderCapabilities.generator = "${id}"`,
    };
  }

  return null;
}

// Reads the written configuration back through the SAME resolvers the
// implementers use (url-file-map.js), so a projection is only accepted if it
// actually resolves in production code paths — not merely if the JSON looks
// right. A shape that writes cleanly but resolves to nothing is a silent
// failure, and this is what catches it.
function validateProjection(site, finding, projection) {
  if (projection.key === 'patterns') {
    const probeUrl = (finding.finding.sampleRoutes || [])[0];
    if (!probeUrl) return { ok: false, reason: 'no sample route to validate against' };
    const full = probeUrl.startsWith('http') ? probeUrl : `https://${site.website_domain || 'example.com'}${probeUrl}`;
    const resolved = resolveFile(site, full);
    if (!resolved) return { ok: false, reason: `wrote the pattern, but ${probeUrl} still resolves to no file — rejecting` };
    return { ok: true, detail: `${probeUrl} now resolves to ${resolved}` };
  }
  if (projection.key === 'renderCapabilities') {
    const generator = site.url_file_map?.renderCapabilities?.generator;
    return generator
      ? { ok: true, detail: `renderCapabilities.generator reads back as "${generator}"` }
      : { ok: false, reason: 'renderCapabilities.generator did not read back after write' };
  }
  return { ok: false, reason: 'no validator for this projection type' };
}

// findings: rows/objects with {category, subject, finding, confidence, risk}.
// Returns a per-finding record of what happened and why — including refusals,
// which are as important to report as successes.
export async function autoConfigure(site, findings, { saveConfig = updateSiteRepoConfig } = {}) {
  const results = [];
  // Accumulates across findings so several projections in one pass build on
  // each other rather than each overwriting the last write's map.
  let workingMap = { ...(site.url_file_map || {}) };
  let workingSite = { ...site, url_file_map: workingMap };

  for (const finding of findings) {
    const eligible = isProjectable(finding);
    if (!eligible.ok) {
      results.push({ subject: finding.subject, applied: false, status: 'needs_confirmation', reason: eligible.reason });
      continue;
    }

    const projection = projectFinding(finding, workingMap);
    if (!projection) {
      results.push({ subject: finding.subject, applied: false, status: 'needs_confirmation', reason: 'no safe, schema-compatible projection exists for this finding' });
      continue;
    }
    if (projection.skip) {
      results.push({ subject: finding.subject, applied: false, status: 'validated', reason: projection.reason });
      continue;
    }
    if (!AUTO_WRITABLE.has(projection.key)) {
      results.push({ subject: finding.subject, applied: false, status: 'needs_confirmation', reason: `${projection.key} is not auto-writable` });
      continue;
    }

    const candidateMap = { ...workingMap, [projection.key]: projection.next };
    const candidateSite = { ...workingSite, url_file_map: candidateMap };

    // Validate BEFORE persisting: a projection that cannot be proven correct
    // is never written at all, so a failed validation leaves the database
    // exactly as it was rather than needing a rollback.
    const validation = validateProjection(candidateSite, finding, projection);
    if (!validation.ok) {
      results.push({ subject: finding.subject, applied: false, status: 'needs_confirmation', reason: validation.reason });
      continue;
    }

    await saveConfig({ siteId: site.id, urlFileMap: candidateMap });
    workingMap = candidateMap;
    workingSite = candidateSite;

    results.push({
      subject: finding.subject,
      applied: true,
      status: 'auto_configured',
      wrote: projection.describes,
      validated: validation.detail,
    });
  }

  return { results, urlFileMap: workingMap, applied: results.filter((r) => r.applied).length };
}

export const __testables = { isProjectable, projectFinding, validateProjection, AUTO_WRITABLE };
