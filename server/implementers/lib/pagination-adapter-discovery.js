import { getFileContent } from '../../github/client.js';
import { baseBranch } from './github-ops.js';
import { updateSiteRepoConfig } from '../../db.js';
import { recordCapabilityRepair } from '../../store/capability-repairs.js';
import { findRootArrayBounds, scanBalanced, findObjectRange, findScalarFieldRange, findArrayFieldRange, assertValidContent } from '../adapters/lib/js-data-splice.js';

// The self-healing counterpart to pagination-routes.js's
// paginationBlockedReason: instead of only EXPLAINING that a page like
// /locations/bhaktapur/ is generated from src/_data/locations.js with no
// per-page file to map, this module tries to actually configure the
// `data-array-content` adapter (see url-file-map.js's resolveAdapter doc
// comment) that would make it auto-fixable — generically, for any tenant's
// route family, never one site's hardcoded config.
//
// url-file-map.js's own resolveAdapter comment draws a deliberate line:
// adapter routing is "never auto-detected or LLM-guessed" because a wrong
// guess corrupts a data file every page on the route imports at build time —
// a materially higher blast radius than a wrong per-page file guess. This
// module does not cross that line by lowering the evidence bar; it meets it
// a different way: every field this proposes is checked against the SAME
// two pieces of real evidence discoverPaginationRoutes already trusts
// (front-matter, the data file's own real content) PLUS the template's own
// real rendering of that item, and the synthesized config is validated by
// actually parsing/splicing the real data file with it before it is ever
// persisted. A config that fails that dry run is never written — same
// "checked, not guessed" discipline as autoHealFileMapping, applied one
// layer deeper.
//
// Deliberately narrow in what it will resolve: only the action types whose
// data-array-content shape is a single field (see FIELD_ACTION_TYPES below).
// meta-title needs two coordinated fields (title + metaDescription) with a
// materially different confidence bar and is left to explicit config, same
// as before this module existed.

const ITEMS_ACTION_TYPES = new Set(['faq', 'qa-content']);
const FIELD_ACTION_TYPES = { 'expand-content': 'expandedContent', 'internal-links': 'links' };

// Every direct `key: value` pair inside objRange, string/comment-aware so a
// nested object's own keys are never mistaken for a top-level one — same
// scanning discipline as js-data-splice.js's own listTopLevelObjects, one
// level deeper (fields of an object instead of objects of an array).
function listTopLevelFields(content, objRange, format) {
  const inner = content.slice(objRange.start + 1, objRange.end);
  const n = inner.length;
  const fields = [];
  let i = 0;
  while (i < n) {
    const c = inner[i];
    if (/\s/.test(c) || c === ',') { i++; continue; }
    if (c === '/' && inner[i + 1] === '/') { const nl = inner.indexOf('\n', i); i = nl === -1 ? n : nl + 1; continue; }
    if (c === '/' && inner[i + 1] === '*') { const end = inner.indexOf('*/', i + 2); i = end === -1 ? n : end + 2; continue; }

    const keyMatch = format === 'json-array'
      ? /^"((?:[^"\\]|\\.)*)"\s*:/.exec(inner.slice(i))
      : /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))\s*:/.exec(inner.slice(i));
    if (!keyMatch) break; // unexpected top-level token — bail rather than guess
    const key = keyMatch[1] || keyMatch[2] || keyMatch[3];
    i += keyMatch[0].length;
    while (i < n && /\s/.test(inner[i])) i++;

    const valueStart = i;
    let valueEnd;
    if (inner[i] === '"' || inner[i] === "'" || inner[i] === '`') {
      const quote = inner[i]; i++;
      while (i < n && inner[i] !== quote) { if (inner[i] === '\\') i++; i++; }
      i++; valueEnd = i;
    } else if (inner[i] === '{' || inner[i] === '[') {
      const open = inner[i]; const close = open === '{' ? '}' : ']';
      const closeIdx = scanBalanced(inner, i + 1, open, close);
      i = closeIdx === -1 ? n : closeIdx + 1;
      valueEnd = i;
    } else {
      while (i < n && inner[i] !== ',') i++;
      valueEnd = i;
    }
    fields.push({ key, kind: inner[valueStart] === '"' || inner[valueStart] === "'" || inner[valueStart] === '`' ? 'string' : inner[valueStart] === '[' ? 'array' : inner[valueStart] === '{' ? 'object' : 'scalar' });
  }
  return fields;
}

// Field names the template itself actually reads off the pagination item —
// `location.description`-shaped expressions, real rendering evidence, not a
// naming convention. Covers both the aliased form (`pagination.alias`) and
// Eleventy's default per-page pagination context when no alias is set.
//
// Returns two sets, not one: `all` (any reference at all) and `raw` (only
// references rendered UNESCAPED — Nunjucks/Liquid `| safe`, Handlebars
// `{{{ }}}`, EJS `<%- %>`). The distinction is what breaks the tie between
// e.g. `location.name` and `location.description` both being real string
// fields the template reads: only a field rendered raw can actually display
// the HTML a content adapter (expand-content, internal-links) writes into
// it — a plain, escaped `{{ location.name }}` would show literal "<p>..."
// tags on the live page, so it is real evidence the field is NOT this
// adapter's target, not just a naming coincidence to filter out by guessing.
function templateReferencedFields(templateSource, alias) {
  const all = new Set();
  const raw = new Set();
  const subjects = [alias, 'pagination\\.items\\[0\\]', 'pagination\\.items\\.0'].filter(Boolean);
  for (const subj of subjects) {
    const fieldExpr = `${subj}\\.([A-Za-z_$][\\w$]*)`;
    let m;
    const anyRe = new RegExp(`\\b${fieldExpr}`, 'g');
    while ((m = anyRe.exec(templateSource))) all.add(m[1]);

    const rawPatterns = [
      new RegExp(`\\{\\{\\s*${fieldExpr}\\s*\\|\\s*safe\\s*\\}\\}`, 'g'),
      new RegExp(`\\{\\{\\{\\s*${fieldExpr}\\s*\\}\\}\\}`, 'g'),
      new RegExp(`<%-\\s*${fieldExpr}\\s*%>`, 'g'),
    ];
    for (const re of rawPatterns) {
      while ((m = re.exec(templateSource))) raw.add(m[1]);
    }
  }
  return { all, raw };
}

function idFromPageUrl(pageUrl) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { return null; }
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

// Proposes and validates a `data-array-content` adapter config for `route`
// (a discoverPaginationRoutes result) and one `actionType`, using only real
// evidence: the matched entry's own field list, the template's own real
// rendering of the item, and a dry-run splice against the real data file.
// Returns { config, evidence } on success, or null if any step could not
// resolve to exactly one unambiguous, validated answer — callers must treat
// null as "could not repair," not as a partial or best-guess result.
export async function discoverDataArrayAdapterConfig(site, route, actionType, pageUrl, { fetchFile = getFileContent, branch } = {}) {
  if (!route.dataFile || route.dataFileAmbiguous) return null;
  const kind = ITEMS_ACTION_TYPES.has(actionType) ? 'items' : FIELD_ACTION_TYPES[actionType] ? 'field' : null;
  if (!kind) return null;

  const id = idFromPageUrl(pageUrl);
  if (!id) return null;

  const resolvedBranch = branch || baseBranch(site);
  let dataFile;
  let templateFile;
  try {
    [dataFile, templateFile] = await Promise.all([
      fetchFile(site, route.dataFile, resolvedBranch),
      fetchFile(site, route.template, resolvedBranch),
    ]);
  } catch {
    return null; // could not verify — never treated as evidence either way
  }
  if (!dataFile?.content || !templateFile?.content) return null;

  const format = route.dataFile.endsWith('.json') ? 'json-array' : 'js-export-array';
  const objRange = findObjectRange(dataFile.content, route.idField, id, format);
  if (!objRange) return null; // no single unambiguous entry — the same bar findObjectRange already holds apply() to

  const dataFields = listTopLevelFields(dataFile.content, objRange, format);
  const rendered = templateReferencedFields(templateFile.content, route.alias);

  // Items (an array the template loops over) only need to be referenced at
  // all — looping doesn't require an escape/raw filter the way splicing a
  // single HTML string into the page does. A single-field content write
  // (`kind === 'field'`) is checked against `raw` only, deliberately never
  // falling back to `all` — see templateReferencedFields' own comment for
  // why a merely-referenced-but-escaped field is real evidence AGAINST it,
  // not weak evidence for it.
  const wantKind = kind === 'items' ? 'array' : 'string';
  const evidence = kind === 'items' ? rendered.all : rendered.raw;
  const candidates = dataFields.filter((f) => f.kind === wantKind && evidence.has(f.key));
  if (candidates.length !== 1) return null; // ambiguous (0 or >1) — real evidence didn't converge on one field, refuse rather than pick

  const fieldName = candidates[0].key;

  // Dry-run: locate the field the same way a real apply() would, and confirm
  // the file still parses as valid after a no-op splice through the exact
  // code path apply() uses — never persisted unless this succeeds, so a
  // config that would corrupt route.dataFile (breaking every page's build
  // that imports it) is caught here, before it is ever written.
  let config;
  if (kind === 'items') {
    const arrayRange = findArrayFieldRange(dataFile.content, objRange, fieldName, format);
    if (!arrayRange) return null;
    const check = assertValidContent(dataFile.content, format);
    if (!check.ok) return null;
    config = { id: 'data-array-content', format, dataFile: route.dataFile, idField: route.idField, itemsField: fieldName };
  } else {
    const scalarRange = findScalarFieldRange(dataFile.content, objRange, fieldName, format);
    if (!scalarRange) return null;
    const check = assertValidContent(dataFile.content, format);
    if (!check.ok) return null;
    config = { id: 'data-array-content', format, dataFile: route.dataFile, idField: route.idField, fields: { [FIELD_ACTION_TYPES[actionType]]: fieldName } };
  }

  return { config, evidence: { id, fieldName, dataFields: dataFields.map((f) => f.key), renderedAll: [...rendered.all], renderedRaw: [...rendered.raw] } };
}

// Persists a discovered adapter config as a `patterns[]` entry covering the
// WHOLE route family (route.routePrefix + '/*'), not just the one page that
// triggered discovery — the point of this module is that every sibling page
// (every /locations/:slug/, not just bhaktapur) becomes auto-fixable in one
// write, generically for any tenant. Idempotent: if a pattern already covers
// this actionType for this route (another page in the family healed it
// first this pass, or a prior pass), returns the site unchanged rather than
// writing a duplicate entry.
export async function healPaginationAdapter(site, route, actionType, pageUrl, deps = {}) {
  if (!site?.repo_owner || !site?.repo_name) return null;

  const match = `^${route.routePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+/?$`;
  const existing = (site.url_file_map?.patterns || []).find((p) => p.match === match);
  if (existing?.adapters?.[actionType]) return null; // already configured — nothing to heal

  const result = await discoverDataArrayAdapterConfig(site, route, actionType, pageUrl, deps).catch((err) => {
    (deps.log || console).warn(`[pagination-adapter-heal] site #${site.id}: could not discover an adapter config for ${route.routePrefix}/* (${actionType}): ${err.message}`);
    return null;
  });

  if (!result) {
    await recordCapabilityRepair(site.id, {
      capabilityType: 'url-file-map-adapter', target: `${route.routePrefix}/* (${actionType})`, outcome: 'ambiguous',
      detail: { dataFile: route.dataFile, idField: route.idField },
    });
    return null;
  }

  const cfg = JSON.parse(JSON.stringify(site.url_file_map || {}));
  cfg.patterns = cfg.patterns || [];
  const patternEntry = cfg.patterns.find((p) => p.match === match);
  if (patternEntry) {
    patternEntry.adapters = { ...(patternEntry.adapters || {}), [actionType]: result.config };
  } else {
    cfg.patterns.push({ match, adapters: { [actionType]: result.config } });
  }

  console.log(`[pagination-adapter-heal] url_file_map: discovered a data-array-content adapter for ${route.routePrefix}/* (${actionType}) -> ${result.config.dataFile}, persisting.`);
  await recordCapabilityRepair(site.id, {
    capabilityType: 'url-file-map-adapter', target: `${route.routePrefix}/* (${actionType})`, outcome: 'repaired',
    detail: { config: result.config, evidence: result.evidence },
  });
  return updateSiteRepoConfig({ siteId: site.id, urlFileMap: cfg });
}
