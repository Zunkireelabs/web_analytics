import { extensionOf } from '../../implementers/lib/rendering-gate.js';

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
const REQUIRED_PREFIXES = ['render:', 'target-ext:'];

function push(tokens, prefix, value) {
  if (value === null || value === undefined) return;
  const v = String(value).trim().toLowerCase();
  if (v) tokens.add(`${prefix}${v}`);
}

// `targetFilePath` is the file this specific repair would touch (resolved via
// url-file-map.js's resolveFile). It is read for its EXTENSION only — the
// path itself is never tokenized.
export function computeSiteFingerprint(site, { targetFilePath = null } = {}) {
  const tokens = new Set();
  const caps = site?.url_file_map?.renderCapabilities;

  push(tokens, 'render:', caps?.generator);
  // Optional, and currently NULL on every real site — kept because it is
  // free, and treated as a conflict signal rather than a requirement in
  // fingerprintCompatible below. Requiring it would make this feature
  // permanently inert on every site as currently configured.
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

  for (const id of adapterIds(site)) push(tokens, 'adapter:', id);

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
