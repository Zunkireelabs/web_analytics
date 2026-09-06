import { extensionOf } from '../../implementers/lib/rendering-gate.js';
import { resolveAdapter } from '../../implementers/lib/url-file-map.js';

// Answers "is a repair proven on client A plausibly applicable to client B?"
//
// The existing agent_fix_memory retrieval (agent-memory.js's
// findRelevantMemory) matches on an exact problem_signature plus keyword
// overlap against `symptoms` — pure text. Nothing about the TARGET SITE
// participates, which is fine for injecting an advisory line into a prompt
// but nowhere near enough to justify executing a repair on a different
// client's repository. This module is that missing signal.
//
// Deliberately a small set of technology-only tokens, not an embedding and
// not an LLM call:
//   - it has to be cheap enough to run per candidate during the daily job,
//     the same constraint agent-memory.js states for its own hot path;
//   - it has to be INSPECTABLE. When a repair fires (or doesn't) on a real
//     customer repo, "render:eleventy != render:nextjs" is a debuggable
//     answer; a cosine distance is not.
//
// PRIVACY: every token is a technology fact. No client name, no domain, no
// URL, no repo owner, and file EXTENSIONS only — never a path. This is what
// makes a stored fingerprint safe to keep on a cross-tenant row, and it is
// enforced by test (site-fingerprint.test.js asserts no token can contain a
// URL, domain, email, or path separator).

// `renderCapabilities.generator` is documented in implementers/types.js as
// "free-text, informational only". This module promotes it to a load-bearing
// matching key — deliberately, because it is the single best available proxy
// for "will an anchor/marker derived on that site mean the same thing on
// this one", and it is populated on the real sites while sites.tech_stack is
// not. If it ever becomes enum-constrained, this is the consumer to check.
// page-adapter: joins render:/target-ext: as required — not because most
// pages HAVE an adapter (most don't; default marker-merge routing is the
// common case), but because "adapter-routed" vs "default-routed" is itself
// the structural fact that matters. Silently missing this distinction is
// exactly the gap that let a repair proven on a data-array-adapter page get
// treated as portable to a page the default implementer owns instead (or
// the reverse) — different write mechanisms entirely, and per url-file-map.js's
// own comment on resolveAdapter, "a wrong adapter-routing guess can corrupt a
// file every page's build imports." Always pushed as 'page-adapter:none' when
// there is no adapter for this (page, actionType), rather than left absent,
// so a default-routed page and an adapter-routed page register as a real
// conflict instead of two silent gaps that pass by accident (see the `stack:`
// token below for how a genuinely-absent-on-both-sides signal behaves instead
// — that distinction is deliberate, not an oversight).
//
// content-type: is the third applicability layer — CONTENT CONTEXT, not
// technology. render:/target-ext:/page-adapter: can all agree and a repair
// can still be wrong to reuse if the target page is a different KIND of page
// than the one it was proven on (see page-content-classifier.js). Required
// for the same reason as page-adapter: — "this site has no classification
// for this page yet" must refuse, not pass, so an uncertain classification
// never reads as "compatible with everything". Unlike page-adapter:, there is
// no cheap synchronous way to compute this value (classification needs a DB
// read and sometimes an LLM call), so — unlike every other token in this
// file — it is resolved by the CALLER (see the contentType param below)
// rather than derived from `site` here; computeSiteFingerprint stays pure
// and synchronous either way.
const REQUIRED_PREFIXES = ['render:', 'target-ext:', 'page-adapter:', 'content-type:'];

function push(tokens, prefix, value) {
  if (value === null || value === undefined) return;
  const v = String(value).trim().toLowerCase();
  if (v) tokens.add(`${prefix}${v}`);
}

// `targetFilePath` is the file this specific repair would touch (resolved via
// url-file-map.js's resolveFile). It is read for its EXTENSION only — the
// path itself is never tokenized.
//
// `pageUrl`/`actionType` (the recommendation's own generatorId) identify
// which SPECIFIC page and action this fingerprint is for, so page-adapter:
// below can answer "does resolveAdapter route THIS page's THIS action
// through an adapter" — a page-level structural fact, not a site-wide one.
// Both optional and independent of targetFilePath on purpose: a caller that
// only has one or the other still gets everything it can prove.
//
// `contentType` is pre-resolved by the caller (page-content-classifier.js's
// getOrClassifyPageContentType — async, so it can't be computed in here) and
// simply pushed as a token when given, `null`/omitted otherwise.
export function computeSiteFingerprint(site, { targetFilePath = null, pageUrl = null, actionType = null, contentType = null } = {}) {
  const tokens = new Set();
  const caps = site?.url_file_map?.renderCapabilities;

  push(tokens, 'render:', caps?.generator);
  // Optional, and currently NULL on every real site — kept because it is
  // free, and treated as a conflict signal rather than a requirement in
  // fingerprintCompatible below. Requiring it would make this feature
  // permanently inert on every site as currently configured.
  //
  // AUDITED (2026-08): `sites.tech_stack` is free-text, staff-entered
  // exclusively via `connect-repo.js --tech-stack <value>` (see migration
  // 028's column comment — "not enum-constrained with only one pilot site").
  // Nothing in this codebase derives it automatically from a repo's
  // package.json/framework config, and no such reliable auto-detection
  // exists to wire in. `caps?.generator` (the `render:` token above) is
  // already the load-bearing, always-populated technology signal for every
  // real site — do not invent a heuristic here to fill `stack:` (e.g.
  // guessing from file extensions or `render:`) just to make it non-null:
  // an invented value could produce either a false conflict (refusing a
  // portable repair) or, worse, a false agreement between two sites that
  // merely share a guess. Absent stays absent; this token is populated only
  // when an operator has actually set `tech_stack` for that site.
  push(tokens, 'stack:', site?.tech_stack);

  for (const ext of Object.keys(caps?.extensions || {})) push(tokens, 'ext:', ext);

  if (targetFilePath) {
    // extensionOf (rendering-gate.js) rather than a local reimplementation:
    // it handles compound suffixes like `.11ty.md`, and it is the exact
    // function that decides which renderCapabilities.extensions entry a file
    // resolves to. A second copy here could drift and silently match a
    // lesson against a capability the real gate would resolve differently.
    const ext = extensionOf(targetFilePath);
    push(tokens, 'target-ext:', ext);
    const markdown = caps?.extensions?.[ext]?.markdown;
    if (typeof markdown === 'boolean') push(tokens, 'md:', markdown);
  }

  if (pageUrl && actionType) {
    // 'none' rather than leaving the token absent — see REQUIRED_PREFIXES's
    // comment above for why an unwritten token here would silently pass a
    // real structural mismatch.
    push(tokens, 'page-adapter:', resolveAdapter(site, pageUrl, actionType)?.id || 'none');
  }

  for (const id of adapterIds(site)) push(tokens, 'adapter:', id);

  // No 'none' fallback here (unlike page-adapter: above) — an unclassified
  // page is a genuinely different case from a page classified as 'other',
  // and both must refuse, which omitting the token already achieves via
  // REQUIRED_PREFIXES's own "absent = refuse" default. Writing a fake
  // 'content-type:none' would make an unclassified page match every OTHER
  // unclassified page, which is exactly the false-compatibility this layer
  // exists to prevent.
  push(tokens, 'content-type:', contentType);

  return [...tokens].sort();
}

// Every distinct adapter id configured anywhere on the site. A site that
// routes content through data-array-content behaves materially differently
// from one that only does marker merges, so this is real applicability
// signal — but it is ranking-only, since a lesson can be perfectly portable
// between a site that happens to use an adapter elsewhere and one that
// doesn't.
function adapterIds(site) {
  const map = site?.url_file_map || {};
  const out = new Set();
  const collect = (entry) => {
    for (const cfg of Object.values(entry?.adapters || {})) {
      if (cfg?.id) out.add(cfg.id);
    }
  };
  for (const entry of Object.values(map.pages || {})) collect(entry);
  for (const pattern of map.patterns || []) collect(pattern);
  return out;
}

// Mirrors applyExactMatchPatches' `{ok, missing}` refusal contract on
// purpose: same discipline (refuse rather than guess), same debuggability.
//
// `missing` names the exact tokens that blocked the match, so the dry-run log
// can say WHY a repair didn't fire — the difference between "no lesson
// applied" and "no lesson applied because this site has no
// renderCapabilities.generator recorded".
export function fingerprintCompatible(lessonTokens, targetTokens) {
  const lesson = new Set(lessonTokens || []);
  const target = new Set(targetTokens || []);
  const missing = [];

  for (const prefix of REQUIRED_PREFIXES) {
    const l = [...lesson].find((t) => t.startsWith(prefix));
    const t = [...target].find((tok) => tok.startsWith(prefix));
    // Absent on EITHER side is a refusal, not a pass. A lesson learned before
    // fingerprints existed, or a site with incomplete renderCapabilities,
    // must not be treated as "compatible with everything".
    if (!l || !t) { missing.push(`${prefix}(unknown)`); continue; }
    if (l !== t) missing.push(`${prefix}${l.slice(prefix.length)}!=${t.slice(prefix.length)}`);
  }

  // Not required (see stack: above), but a DECLARED mismatch is disqualifying:
  // if both sides say what they are and they disagree, that is real evidence
  // against portability, unlike one side simply not saying.
  const lStack = [...lesson].find((t) => t.startsWith('stack:'));
  const tStack = [...target].find((t) => t.startsWith('stack:'));
  if (lStack && tStack && lStack !== tStack) missing.push(`${lStack}!=${tStack}`);

  if (missing.length) return { ok: false, missing, score: 0 };

  const intersection = [...lesson].filter((t) => target.has(t)).length;
  const union = new Set([...lesson, ...target]).size;
  return { ok: true, missing: [], score: union ? intersection / union : 0 };
}
