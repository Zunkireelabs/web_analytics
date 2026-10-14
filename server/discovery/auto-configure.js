import { updateSiteRepoConfig } from '../db.js';
import { resolveFile, isPageMapped } from '../implementers/lib/url-file-map.js';
import { knownDomain } from '../agents/lib/site-domain.js';

// `site.website_domain` is stored inconsistently across tenants — some rows
// hold a bare hostname, others a full URL with scheme and/or a trailing
// slash (real data: Admizz's is "https://admizzeducation.com/"). Building a
// probe URL as `https://${site.website_domain}` in that case produces
// "https://https://admizzeducation.com/...", whose `new URL(...).hostname`
// parses to the literal string "https" — resolveHostScope then treats every
// probe as a foreign hostname and resolveFile always returns null, failing
// EVERY validation regardless of how correct the underlying mapping is.
// knownDomain() is the same normalizer agents/lib/site-domain.js already
// uses everywhere else a bare hostname is needed, reused here instead of a
// second ad hoc strip.
function probeOrigin(site) {
  return knownDomain(site) || 'example.com';
}

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
//
// `pages` joined `patterns`/`renderCapabilities` once filesystem-router
// discovery (filesystem-routes.js) started proposing exact, single-file
// static routes — e.g. Next.js App Router's `page.tsx` per directory. Same
// blast radius as one `patterns[]` entry (one page, one file), same
// read-back-through-resolveFile validation below, just an exact key instead
// of a regex.
const AUTO_WRITABLE = new Set(['patterns', 'pages', 'renderCapabilities']);

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
    // Component-based template languages (JSX/TSX, Vue, Svelte, Astro, plain
    // HTML) never run a Markdown pass over their own source on any framework
    // this platform detects — that's a property of the LANGUAGE, not a
    // per-repo guess (a `.tsx` file is JSX+TS syntax; nothing in the Next.js/
    // Astro/etc. build pipeline treats `# heading` inside one as Markdown).
    // Recording `markdown: false` here is exactly what unblocks the
    // Rendering Validation Gate (rendering-gate.js) for a newly onboarded
    // component-based site without a human re-typing the same fact
    // action-center-onboarding.md's §1a otherwise asks for by hand.
    const COMPONENT_LANGUAGES = { jsx: ['.jsx', '.tsx'], vue: ['.vue'], svelte: ['.svelte'], astro: ['.astro'], html: ['.html', '.htm'] };
    for (const lang of templateLanguages || []) {
      const exts = COMPONENT_LANGUAGES[lang.id];
      if (!exts) continue;
      for (const ext of exts) extensions[ext] = { markdown: false, ...(extensions[ext] || {}) };
    }
    return {
      key: 'renderCapabilities',
      next: { ...existing, generator: id, ...(Object.keys(extensions).length ? { extensions } : {}) },
      describes: `renderCapabilities.generator = "${id}"`,
    };
  }

  // Exact, single-file static routes from filesystem-router discovery
  // (filesystem-routes.js) — one Next.js App Router `page.tsx`, one Pages
  // Router/Astro file, one URL. Same blast radius as one `patterns[]` entry.
  if (finding.category === 'static-routes') {
    const { routes } = finding.finding || {};
    if (!Array.isArray(routes) || !routes.length) return null;
    const pages = { ...(existingMap.pages || {}) };
    const additions = [];
    for (const { route, file } of routes) {
      if (!route || !file) continue;
      // Never overwrite an entry a human (or an earlier pass) already wrote
      // — including one that already resolves this exact URL to a DIFFERENT
      // file via a pattern; re-deriving is not grounds to override a decision.
      const already = resolveFile({ url_file_map: existingMap }, `https://probe.invalid${route}`);
      if (already) continue;
      pages[route] = { ...(pages[route] || {}), file };
      additions.push({ route, file });
    }
    if (!additions.length) return { skip: true, reason: 'every proposed static route already resolves to a file' };
    return { key: 'pages', next: pages, additions, describes: `pages{} entries for ${additions.length} static route(s)` };
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
    const full = probeUrl.startsWith('http') ? probeUrl : `https://${probeOrigin(site)}${probeUrl}`;
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
  if (projection.key === 'pages') {
    // Every addition is checked, not just one probe — unlike a single
    // regex family, each entry here is an independent claim about a
    // different file, so one bad entry must never hide behind the rest
    // validating fine.
    for (const { route, file } of projection.additions || []) {
      const resolved = resolveFile(site, `https://${probeOrigin(site)}${route}`);
      if (resolved !== file) return { ok: false, reason: `wrote pages["${route}"], but it resolves to ${resolved ?? 'nothing'} instead of ${file} — rejecting` };
    }
    return { ok: true, detail: `${(projection.additions || []).length} pages{} entrie(s) read back correctly` };
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
