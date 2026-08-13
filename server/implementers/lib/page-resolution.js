import { resolveAdapter, resolveFile } from './url-file-map.js';
import { discoverPaginationRoutes, matchPaginationRoute, paginationBlockedReason } from './pagination-routes.js';
import { findCandidateFile, normalizedPath } from './discover-file-mapping.js';

// Replaces the question "which file does this URL map to?" with the one that
// actually matters: "how is this page rendered, and where does a
// page-specific change belong?"
//
// A URL is not necessarily a file. /glossary/multi-tenant-saas/ is not a page
// with its own source — it is one instance of a shared template
// (glossary-term.njk) rendering one record from a data collection
// (src/_data/glossary.js). Writing a page-specific change (an author byline,
// a freshness date) into the template would apply it to every glossary page
// at once; the correct target is the record.
//
// Everything below is composed from evidence this app already gathers —
// resolveAdapter/resolveFile (url-file-map.js's explicit config),
// discoverPaginationRoutes/matchPaginationRoute (real front matter, read from
// the repo), findCandidateFile (a real filename match, never a framework
// convention guess). This module adds no new evidence source; it orders and
// interprets what already exists, and it is the one place that answers "is
// the candidate target shared, and by how much."

// A resolution's `kind`:
//   'generated-record'  — an instance of a shared, data-driven template.
//                          editableTarget names the record, not the template.
//   'authored-file'      — a real file with exactly one URL depending on it.
//   'nonexistent'         — the URL does not correspond to a real page.
//   'unknown'             — no evidence either way; needs a human mapping.
//
// `affectedUrls`: 'one' | 'family' | 'site' — a coarse but honest answer to
// "if I modify editableTarget, which URLs change" — the question §9 of the
// remediation brief asks the system to be able to answer before committing.

function familyFor(pageUrl) {
  const path = normalizedPath(pageUrl);
  const first = path.split('/').filter(Boolean)[0];
  return first ? `/${first}` : null;
}

export async function resolvePageSource(site, pageUrl, actionType, {
  routes,
  fetchTree,
  fetchFile,
  isPageSoftNotFound = async () => false,
} = {}) {
  const evidence = [];
  const base = { url: pageUrl, family: familyFor(pageUrl) };

  // 1. Adapter config: explicit, per-site, and already the correct answer for
  // any route a human (or autoHealFileMapping's cousin, adapter onboarding)
  // has configured — it is checked first because it is the most specific,
  // deliberately-configured evidence available, and it already resolves
  // straight to a record rather than a file.
  const adapter = resolveAdapter(site, pageUrl, actionType);
  if (adapter) {
    evidence.push(`url_file_map adapter config routes "${actionType}" on this page to the ${adapter.id} adapter.`);
    return {
      ...base,
      kind: 'generated-record',
      renderingTemplate: null,
      isSharedTemplate: true,
      layout: null,
      dataSource: { file: adapter.dataFile || null, format: adapter.format || null, idField: adapter.idField || null, nestedField: adapter.nestedField || null },
      recordId: null, // the adapter derives this itself from the URL at apply time — see adapters/data-array-content.js's idFromPageUrl
      editableTarget: { kind: 'data-record', path: adapter.dataFile || null },
      affectedUrls: 'one',
      evidence,
      blockedReason: null,
    };
  }

  // Route families discovered from the repo's own pagination front matter —
  // shared across every page this pass resolves, so callers with many pages
  // to resolve should discover once and pass `routes` in, the same caching
  // discipline recommendation-gates.js already applies to the repo tree.
  const discoveredRoutes = routes ?? await discoverPaginationRoutes(site, { fetchTree }).catch(() => []);
  const paginationMatch = matchPaginationRoute(pageUrl, discoveredRoutes);

  // 2/3. An explicit url_file_map mapping (pages[] exact entry or a
  // patterns[] regex) — but ONLY if it does not resolve to the very template
  // a paginating route says renders this URL. A stored mapping that points at
  // a shared template is a mis-map, not a source of truth: config can be
  // stale (added before the route was understood, or copy-pasted from a
  // different URL), and trusting it blindly is exactly the "URL -> FILE"
  // guessing this resolver exists to replace with "how is this rendered."
  const mappedFile = resolveFile(site, pageUrl);
  if (mappedFile) {
    if (paginationMatch && mappedFile === paginationMatch.template) {
      evidence.push(`url_file_map maps this URL to ${mappedFile}, but that file is the SHARED generator for every ${paginationMatch.routePrefix}/* page (real pagination front matter) — the stored mapping is a mis-map and is rejected rather than trusted.`);
      // Fall through to the pagination branch below, which has the correct
      // answer already in hand.
    } else {
      evidence.push(`url_file_map resolves this URL to ${mappedFile}, and no known pagination route claims that file — treated as authored.`);
      return {
        ...base,
        kind: 'authored-file',
        renderingTemplate: mappedFile,
        isSharedTemplate: false,
        layout: null,
        dataSource: null,
        recordId: null,
        editableTarget: { kind: 'file', path: mappedFile },
        affectedUrls: 'one',
        evidence,
        blockedReason: null,
      };
    }
  }

  // 4. A real, repo-verified generated-page family. This is the case the
  // architecture principle in the remediation brief is written for: the URL
  // is an instance of a data record, not a file of its own.
  if (paginationMatch) {
    evidence.push(`${paginationMatch.routePrefix}/* is generated by ${paginationMatch.template} from ${paginationMatch.dataFile || 'its data source'} (real pagination front matter, not inferred from naming).`);
    const recordId = normalizedPath(pageUrl).split('/').filter(Boolean).pop() || null;
    return {
      ...base,
      kind: 'generated-record',
      renderingTemplate: paginationMatch.template,
      isSharedTemplate: true,
      layout: paginationMatch.layout,
      dataSource: { file: paginationMatch.dataFile, format: paginationMatch.dataFileAmbiguous ? 'ambiguous' : 'js-or-json', idField: paginationMatch.idField, nestedField: null },
      recordId,
      editableTarget: paginationMatch.dataFile
        ? { kind: 'data-record', path: paginationMatch.dataFile, field: paginationMatch.idField }
        : { kind: 'none' },
      affectedUrls: 'family',
      evidence,
      blockedReason: paginationMatch.dataFile ? null : paginationBlockedReason(paginationMatch, actionType),
    };
  }

  // 5. No config, no known route family — is the page even real? A soft-404
  // fallback (many static/SPA deploys return 200 + the homepage for any
  // unknown path) makes "no evidence" and "page doesn't exist" look
  // identical without this check.
  if (await isPageSoftNotFound(pageUrl)) {
    evidence.push('This page returns the site\'s soft-404 fallback (same body as a deliberately-invented nonexistent URL) — it does not exist.');
    return {
      ...base, kind: 'nonexistent', renderingTemplate: null, isSharedTemplate: false, layout: null,
      dataSource: null, recordId: null, editableTarget: { kind: 'none' }, affectedUrls: 'one',
      evidence, blockedReason: null,
    };
  }

  // 6. Last resort, read-only discovery: does exactly one real filename in
  // the repo match this URL's last segment? This is findCandidateFile's own
  // evidence bar (never ambiguous, never a convention guess) — reported here
  // as information for provenance, not persisted; autoHealFileMapping is the
  // only writer, and it re-runs this same match with its own safety
  // predicates before ever saving it.
  let candidate = null;
  if (fetchTree) {
    const tree = await fetchTree(site, undefined).catch(() => null);
    if (tree?.files) {
      const found = findCandidateFile(pageUrl, tree.files);
      if (found.kind === 'resolved') candidate = found.file;
    }
  }
  if (candidate) {
    evidence.push(`No stored mapping, but exactly one file in the repo matches this URL's last segment: ${candidate}. Not yet persisted — see autoHealFileMapping.`);
    return {
      ...base, kind: 'authored-file', renderingTemplate: candidate, isSharedTemplate: false, layout: null,
      dataSource: null, recordId: null, editableTarget: { kind: 'file', path: candidate }, affectedUrls: 'one',
      evidence, blockedReason: null,
    };
  }

  evidence.push('No adapter, no url_file_map entry, no known generated-route family, and no unambiguous filename match.');
  return {
    ...base, kind: 'unknown', renderingTemplate: null, isSharedTemplate: null, layout: null,
    dataSource: null, recordId: null, editableTarget: { kind: 'none' }, affectedUrls: null,
    evidence,
    blockedReason: `No url_file_map entry resolves ${pageUrl} to a file in this site's repo, and it could not be discovered automatically. Add a mapping via 'npm run connect-repo' (or 'npm run audit-url-file-map -- --site-id <id>' to see every gap) before this can be applied.`,
  };
}
