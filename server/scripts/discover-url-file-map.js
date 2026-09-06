import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { pool } from '../db.js';
import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { resolveFile, resolveMarkers, resolveAdapter, resolveHostScope } from '../implementers/lib/url-file-map.js';
import { hasMarker } from '../implementers/lib/marker-merge.js';
import { ownDomains, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { getFileContent, getRepoTree } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { safeEvalJsDataFile } from './lib/safe-js-data-eval.js';
import { normalizedPath, findCandidateFile } from '../implementers/lib/discover-file-mapping.js';

// Proposes a fix for every class of `faq` gap audit-url-file-map.js surfaces
// diagnostically: no file mapping at all, no marker configured, or a
// configured marker that no longer exists in the live file (the bug fixed
// for zunkireelabs-web's `/` and `/about` on 2026-08-02 — the real FAQ had
// moved into a reusable component driven by a `src/_data/<name>.json` file,
// and the stale marker config was never updated to match).
//
// Deterministic and verified only, same principle as render-inspector.js:
// this never guesses blindly and never applies anything itself.
//   - A missing file mapping is only "resolved" once a SINGLE real candidate
//     file is found in the repo's own tree by matching the URL's last path
//     segment against a real filename, AND that file's content, once
//     fetched, ALSO independently confirms a data-driven FAQ loop whose
//     data file exists and has a verifiable shape. Two ambiguous candidates,
//     or any one step failing, falls through to manual review — a filename
//     match alone is evidence, not proof, so it's never trusted on its own.
//   - A `.js` data file's shape is checked by evaluating it in a bare,
//     no-require/no-process/no-network vm.Script sandbox with a timeout
//     (see lib/safe-js-data-eval.js) — the same thing Eleventy itself
//     already does to this exact file at the client's own build time, not a
//     new trust boundary. A file that doesn't evaluate cleanly (imports
//     another module, reads the environment, anything dynamic) fails closed
//     into manual review, it is never partially trusted.
//
// Writes NOTHING to the database. Prints a report and, if anything was
// resolved, writes a ready-to-use url_file_map JSON file (the site's real
// current config, with only the resolved pages added/touched) for a human
// to review and apply themselves via:
//   node server/scripts/connect-repo.js --site-id <id> --url-file-map <out>
//
//   node server/scripts/discover-url-file-map.js --site-id <id> [--out path.json]

const DEFAULT_WINDOW_DAYS = 90;
const PAGE_LIMIT = 300;

// Eleventy/Nunjucks convention: any src/_data/<name>.json|.js file is
// automatically exposed to every template as the global variable <name> —
// this is how the framework actually works, not a guess. A template that
// loops `{% for item in faq %}` is naming its own real data source.
const LOOP_SOURCE_PATTERN = /\{%\s*for\s+\w+\s+in\s+(\w+)\s*%\}/i;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

function isFlatFaqArray(json) {
  return Array.isArray(json) && json.length > 0
    && json.every((x) => x && typeof x === 'object' && 'question' in x && 'answer' in x);
}

// Tries `src/_data/<varName>.json` first (fully verifiable — parsed and
// shape-checked before ever being proposed), then `.js`, evaluated safely
// (see lib/safe-js-data-eval.js) and shape-checked exactly the same way —
// nothing is proposed on the strength of "a file with this name exists"
// alone, in either format.
async function tryResolveDataFile(site, branch, varName) {
  const jsonPath = `src/_data/${varName}.json`;
  const jsonFile = await getFileContent(site, jsonPath, branch).catch(() => null);
  if (jsonFile) {
    let parsed;
    try { parsed = JSON.parse(jsonFile.content); } catch { parsed = null; }
    if (isFlatFaqArray(parsed)) {
      return { kind: 'resolved', config: { id: 'data-array-content', format: 'json-array', dataFile: jsonPath, shape: 'flat-array' } };
    }
    return { kind: 'unusable', reason: `${jsonPath} exists but isn't a flat array of {question, answer} objects` };
  }

  const jsPath = `src/_data/${varName}.js`;
  const jsFile = await getFileContent(site, jsPath, branch).catch(() => null);
  if (jsFile) {
    const evaluated = safeEvalJsDataFile(jsFile.content);
    if (evaluated === undefined) {
      return { kind: 'unusable', reason: `found ${jsPath} but couldn't safely evaluate it (imports another module, reads the environment, or uses dynamic logic beyond a plain export) — check its export shape by hand` };
    }
    if (isFlatFaqArray(evaluated)) {
      return { kind: 'resolved', config: { id: 'data-array-content', format: 'js-export-array', dataFile: jsPath, shape: 'flat-array' } };
    }
    return { kind: 'unusable', reason: `${jsPath} evaluated cleanly but isn't a flat array of {question, answer} objects (got ${Array.isArray(evaluated) ? `an array of ${evaluated.length} item(s) with different fields` : typeof evaluated})` };
  }

  return { kind: 'not-found', reason: `template references "${varName}" but no matching src/_data/${varName}.json or .js in the repo` };
}

// Shared verification tail for a page whose file content we now have,
// regardless of whether that file came from an existing url_file_map entry
// or was just discovered by findCandidateFile — same evidence bar either
// way: a real data-loop pattern, resolving to a real, shape-verified data
// file, or it doesn't get proposed.
async function verifyFaqViaDataLoop(site, branch, fileContent) {
  const loopMatch = fileContent.match(LOOP_SOURCE_PATTERN);
  if (!loopMatch) return { kind: 'not-found', reason: 'no {% for x in <name> %} loop found to propose a data-file fix' };
  return tryResolveDataFile(site, branch, loopMatch[1]);
}

export async function discoverSite(siteId) {
  const site = await getSiteById(siteId);
  if (!site) { console.log(`Site #${siteId}: not found.`); return null; }
  if (!site.repo_owner || !site.repo_name) {
    console.log(`Site #${siteId} "${site.name}": no repo configured — run connect-repo first.`);
    return null;
  }

  const branch = baseBranch(site);
  const { start, end } = defaultRange();
  const rawPages = await getSearchPerformanceRange(siteId, start, end, 'page', PAGE_LIMIT);
  const pages = filterOwnDomainPages(rawPages, ownDomains(site));
  const pageUrls = [...new Set(pages.map((p) => p.dim_value))];

  console.log(`\n=== Discovering faq config gaps for site #${siteId} "${site.name}" (${site.repo_owner}/${site.repo_name}), ${pageUrls.length} candidate pages ===`);

  let repoTree = null; // fetched lazily, once, only if a page actually needs it

  const alreadyOk = [];
  const resolved = []; // { page, path, config, discoveredFile? }
  const needsReview = []; // { page, reason }

  for (const page of pageUrls) {
    if (resolveAdapter(site, page, 'faq')) { alreadyOk.push(page); continue; }

    let filePath = resolveFile(site, page);
    let discoveredFile = null;

    // Same boundary as autoHealFileMapping (implementers/lib/discover-
    // file-mapping.js): findCandidateFile below matches by real filename
    // against the WHOLE repo tree, with no notion of which of a site's
    // several registered hostnames a given route is meant to serve — real
    // evidence for the PRIMARY domain, no evidence at all for a registered
    // non-primary one (edgex.zunkireelabs.com etc.), which is a completely
    // separate real incident this exact ambiguity already caused once
    // (2026-08-24). A page that doesn't already resolve on a non-primary
    // host is reported for manual review, never guessed at.
    const hostScope = resolveHostScope(site, page);
    if (!filePath && hostScope.scope === 'host') {
      needsReview.push({
        page,
        reason: `page is on a registered non-primary hostname (${hostScope.host}) with no explicit ` +
          `url_file_map.hosts["${hostScope.host}"].pages entry — auto-discovery is not safe across ` +
          `hostnames on a shared repo (a filename/route match proves nothing about which hostname it's meant to serve). ` +
          `Add an explicit hosts[] entry by hand.`,
      });
      continue;
    }

    if (!filePath) {
      if (!repoTree) {
        repoTree = await getRepoTree(site, branch);
        if (repoTree.truncated) console.warn(`  (warning: repo file listing was truncated by GitHub — "no candidate found" results may be incomplete)`);
      }
      const candidate = findCandidateFile(page, repoTree.files);
      if (candidate.kind !== 'resolved') {
        needsReview.push({
          page,
          reason: candidate.candidates.length
            ? `no file mapping configured, and ${candidate.candidates.length} ambiguous filename candidates found: ${candidate.candidates.join(', ')}`
            : 'no file mapping configured, and no matching filename found in the repo',
        });
        continue;
      }
      filePath = candidate.file;
      discoveredFile = candidate.file;
    }

    let fileContent;
    try {
      const file = await getFileContent(site, filePath, branch);
      if (!file) { needsReview.push({ page, reason: `${discoveredFile ? 'discovered candidate file' : 'configured file'} ${filePath} not found in repo` }); continue; }
      fileContent = file.content;
    } catch (err) {
      needsReview.push({ page, reason: `could not read ${filePath}: ${err.message}` });
      continue;
    }

    if (!discoveredFile) {
      const markers = resolveMarkers(site, page, 'faq');
      if (markers && Object.values(markers).every((name) => hasMarker(fileContent, name))) {
        alreadyOk.push(page);
        continue;
      }
    }

    const result = await verifyFaqViaDataLoop(site, branch, fileContent);
    if (result.kind !== 'resolved') {
      needsReview.push({
        page,
        reason: discoveredFile
          ? `candidate file ${filePath} found, but ${result.reason}`
          : (resolveMarkers(site, page, 'faq')
            ? `marker configured but missing from the live file, and ${result.reason}`
            : `no faq marker configured, and ${result.reason}`),
      });
      continue;
    }

    resolved.push({ page, path: normalizedPath(page), config: result.config, discoveredFile });
  }

  console.log(`\n-- ALREADY OK (${alreadyOk.length}) --`);
  alreadyOk.forEach((p) => console.log(`  ${p}`));

  console.log(`\n-- RESOLVED, PROPOSED FIX (${resolved.length}) --`);
  resolved.forEach(({ page, config, discoveredFile }) => {
    console.log(`  ${page} -> ${JSON.stringify(config)}${discoveredFile ? `  [file mapping newly discovered: ${discoveredFile} — spot-check recommended]` : ''}`);
  });

  console.log(`\n-- STILL NEEDS MANUAL REVIEW (${needsReview.length}) --`);
  needsReview.forEach(({ page, reason }) => console.log(`  ${page}: ${reason}`));

  return { site, resolved };
}

// Pure — turns a discoverSite() result into the full, ready-to-apply
// url_file_map (the site's real current config, resolved pages merged in).
// Shared by this script's own CLI output and connect-repo.js's post-connect
// auto-discovery, so both write byte-identical proposals.
//
// Writes into the SAME hostname scope resolveFile/resolveAdapter would read
// from for that exact page (see url-file-map.js's resolveHostScope) — a
// resolved item on a registered non-primary hostname (only reachable here
// via an ALREADY-explicit hosts[] entry; discoverSite refuses to guess a
// new file mapping across hostnames, see above) is written back into that
// same `hosts[hostname]` namespace, never into the flat top-level `pages`,
// which is exactly the write-side mistake that caused the real
// edgex.zunkireelabs.com collision this script is now guarded against.
export function buildProposedUrlFileMap(result) {
  const cfg = JSON.parse(JSON.stringify(result.site.url_file_map || {}));
  cfg.pages = cfg.pages || {};
  cfg.hosts = cfg.hosts || {};
  for (const { page, path, config, discoveredFile } of result.resolved) {
    const { scope, host } = resolveHostScope(result.site, page);
    let pages = cfg.pages;
    if (scope === 'host') {
      cfg.hosts[host] = cfg.hosts[host] || {};
      cfg.hosts[host].pages = cfg.hosts[host].pages || {};
      pages = cfg.hosts[host].pages;
    }

    pages[path] = {
      ...(pages[path] || {}),
      ...(discoveredFile ? { file: discoveredFile } : {}),
      adapters: { ...(pages[path]?.adapters || {}), faq: config },
    };
    // The proposed adapter supersedes any stale marker config for this
    // action type (resolveAdapter is checked before resolveMarkers — see
    // url-file-map.js) — drop it so the config doesn't carry dead,
    // misleading marker settings forward.
    if (pages[path].placements?.faq) delete pages[path].placements.faq;
  }
  return cfg;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags['site-id']) {
    console.error('Usage: node server/scripts/discover-url-file-map.js --site-id <id> [--out path.json]');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const siteId = Number(flags['site-id']);
  const result = await discoverSite(siteId);

  if (result?.resolved.length) {
    const cfg = buildProposedUrlFileMap(result);
    const outPath = flags.out || `url-file-map-site-${siteId}-proposed.json`;
    writeFileSync(outPath, JSON.stringify(cfg, null, 2));
    console.log(`\nProposed config written to ${outPath} — review it, then apply with:`);
    console.log(`  node server/scripts/connect-repo.js --site-id ${siteId} --url-file-map ${outPath}`);
  } else {
    console.log('\nNothing auto-resolved — no proposal file written.');
  }

  await pool.end();
}

// Only run the CLI when this file is executed directly — connect-repo.js
// imports discoverSite/buildProposedUrlFileMap from this same module to
// chain auto-discovery after a repo connect, and must NOT trigger this
// script's own argv parsing or its `pool.end()` (which would kill the
// shared pool out from under the caller's own still-running command).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
