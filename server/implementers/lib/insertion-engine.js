import { ensureMarkers, hasMarker, isHeadScopedField, isLineConventionField } from './marker-merge.js';
import { detectHeadRegion, isJsxFile } from './structural-detect.js';
import { getOrDetectStrategy } from './strategy-registry.js';

// The universal insertion engine's single entry point: "make sure every
// marker in markerMap exists in fileContent," without the caller
// (backend.js's computeMarkerMerge) knowing or caring whether that took a
// front-matter rewrite, a nested HEAD-region field, or real structural
// detection of the page's rendered body. Splicing the actual VALUES in is
// still spliceMarkers' job (marker-merge.js) — unchanged, called by the
// caller afterward with whatever content this returns.
//
// Per the agreed no-second-PR design: every marker this resolves is created
// as part of the SAME file diff the real content change lands in — the
// existing daily batch branch/PR, never a separate bootstrap branch/PR. A
// field that genuinely can't be resolved is reported in `unresolved` and
// must never be spliced with real content and must never reach a PR (see
// backend.js/routes/action-center.js) — but it never blocks any OTHER
// field on this same file, or any OTHER draft in the batch, either.

function markerComment(markerName, filePath) {
  return isJsxFile(filePath)
    ? { start: `{/* SEOAI:${markerName}:START */}`, end: `{/* SEOAI:${markerName}:END */}` }
    : { start: `<!-- SEOAI:${markerName}:START -->`, end: `<!-- SEOAI:${markerName}:END -->` };
}

function insertMarkerAt(fileContent, filePath, markerName, offset) {
  const { start, end } = markerComment(markerName, filePath);
  return fileContent.slice(0, offset) + `\n${start}${end}\n` + fileContent.slice(offset);
}

// Body-scoped marker creation for ANY field that isn't LINE/HEAD-scoped
// (marker-merge.js's ensureMarkers already handles those two safely,
// without ever needing structural detection). Learned-strategy-first via
// the Strategy Registry (strategy-registry.js) — a page sharing a template
// identity with an already-resolved page inherits that answer immediately;
// otherwise real fresh detection runs and its result is persisted for the
// next page/call to reuse.
async function ensureBodyMarker(site, fileContent, filePath, markerName) {
  const detection = await getOrDetectStrategy(site, filePath, fileContent);
  if (!detection.ok) return { ok: false, reason: detection.reason, error: detection.error };
  return { ok: true, content: insertMarkerAt(fileContent, filePath, markerName, detection.insertBeforeOffset) };
}

// Auto-creates the SEOAI:HEAD region itself when a head-scoped field is
// missing solely because that region doesn't exist yet — real <head>
// detection (structural-detect.js's detectHeadRegion), not a guess.
function ensureHeadRegion(fileContent, filePath) {
  const detection = detectHeadRegion(fileContent);
  if (!detection.ok) return detection;
  return { ok: true, content: insertMarkerAt(fileContent, filePath, 'HEAD', detection.insertBeforeOffset) };
}

// Returns `{content, unresolved}`. `unresolved` is a per-field list of
// `{field, markerName, reason, error}` for anything that could not be
// safely resolved this call.
export async function resolveInsertion(site, fileContent, filePath, markerMap) {
  // Pass 1: today's safe, structural-detection-free self-heals — LINE
  // (front-matter) fields, and HEAD-scoped fields when the HEAD region
  // already exists.
  let content = ensureMarkers(fileContent, markerMap, filePath).content;

  const stillMissingHeadScoped = Object.entries(markerMap)
    .filter(([field, markerName]) => isHeadScopedField(field) && !hasMarker(content, markerName));

  // Pass 2: a HEAD-scoped field is still missing only because the
  // SEOAI:HEAD region itself doesn't exist — detect a real <head> and
  // create it once, then re-run ensureMarkers so every head-scoped field
  // (not just the one currently being applied) nests into it in one shot.
  if (stillMissingHeadScoped.length) {
    const headResult = ensureHeadRegion(content, filePath);
    if (headResult.ok) content = ensureMarkers(headResult.content, markerMap, filePath).content;
  }

  // Pass 3: every field still missing at this point falls into exactly one
  // of three categories — reported explicitly and honestly either way, per
  // this platform's daily-batch contract (never silently skipped, never
  // recorded as resolved when nothing was actually inserted):
  //   - head-scoped: the auto-created HEAD region attempt above still
  //     didn't produce a real <head> to anchor to.
  //   - LINE-convention (front matter): ensureMarkers' own narrow, safe
  //     rewrite (pass 1) already tried and couldn't find a safe front-matter
  //     value to annotate — never routed through structural detection,
  //     which has nothing to do with a YAML/front-matter value.
  //   - everything else: a genuine body-content BLOCK field — real
  //     structural detection, never a blind end-of-file append on a
  //     component-shaped file.
  const unresolved = [];
  for (const [field, markerName] of Object.entries(markerMap)) {
    if (hasMarker(content, markerName)) continue;
    if (isHeadScopedField(field)) {
      unresolved.push({ field, markerName, reason: 'no-head-region', error: `No real <head> element could be found in ${filePath} to auto-create a SEOAI:HEAD region.` });
      continue;
    }
    if (isLineConventionField(field)) {
      unresolved.push({ field, markerName, reason: 'no-front-matter', error: `No safe front-matter value for "${field}" could be found/annotated in ${filePath}.` });
      continue;
    }
    const result = await ensureBodyMarker(site, content, filePath, markerName);
    if (result.ok) { content = result.content; continue; }
    unresolved.push({ field, markerName, reason: result.reason, error: result.error });
  }

  return { content, unresolved };
}

// The per-draft terminal-state contract (acceptance criteria §1/§2/§6 in
// this feature's design): turns `resolveInsertion`'s `unresolved` list and
// spliceMarkers' own `missingMarkers` into ONE honest, named failure — never
// a generic "add this marker manually" message, and never silently dropped.
// Pulled out of backend.js's computeMarkerMerge as its own pure function
// (no GitHub/DB access — just the two already-computed results) specifically
// so this exact contract has direct, fast unit coverage independent of the
// live-repo network calls the rest of computeMarkerMerge needs (see this
// module's test file for why: this repo has no convention for mocking
// GitHub network calls, so the surrounding fetch/push logic isn't unit-
// tested anywhere — this is the one piece of that pipeline that CAN be,
// because it's pure).
//
// `spliced` is spliceMarkers' return value (`{ok, missingMarkers}` or
// `{ok:true, ...}`); `unresolved` is resolveInsertion's own list. Returns
// `null` when there is genuinely nothing to report (both succeeded) — the
// caller applies the change and reaches the PR; otherwise the same
// `{ok:false, reason, error, unresolved}` shape computeMarkerMerge returns
// today, with `unresolved` preserved verbatim (not just summarized into the
// message string) so a future UI — or any other caller, e.g. an API
// response — can render accurate per-field status even before it's wired
// up to show it.
export function buildUnresolvedInsertionFailure(filePath, spliced, unresolved) {
  if (spliced.ok && !unresolved.length) return null;

  const allMissing = new Set([...(spliced.missingMarkers || []), ...unresolved.map((u) => u.markerName)]);
  const names = [...allMissing].map((m) => `SEOAI:${m}`).join(', ');
  const reasons = unresolved.map((u) => `${u.field} (${u.reason}): ${u.error}`).join(' ');
  return {
    ok: false, reason: 'no-confident-insertion-point',
    error: `Could not safely resolve marker(s) in ${filePath}: ${names}.${reasons ? ` ${reasons}` : ''}`,
    unresolved,
  };
}
