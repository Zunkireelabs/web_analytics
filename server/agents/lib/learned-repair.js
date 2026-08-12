import { riskTierForGenerator } from './risk-tiers.js';

// Policy layer for cross-client learned repair: which problems are keyed how,
// which generators may act on a stranger's repository, and how much proof
// each needs first. Deliberately separate from agent-memory.js (which stores
// and retrieves) and from auto-remediation.js (which executes) — this module
// only decides.

// THE retrieval key, used by BOTH the writer (fix-verification.js, when a
// live re-check confirms a fix worked) and the reader (the interception path).
// A cross-client repair is looked up by exact signature equality, so the two
// sides drifting by even a character means every lookup silently misses and
// the whole feature quietly does nothing.
//
// Tags are SORTED here for exactly that reason: they arrive from
// recommendationsFor/contentGapsFor as arrays whose order is not guaranteed
// stable, and the same two tags in a different order would otherwise produce
// two different signatures for one problem — the single most likely way this
// feature breaks without anyone noticing, since the failure mode is silence.
export function problemSignatureFor(generatorId, tags, fallback = null) {
  const list = (tags || []).filter(Boolean).map(String).sort();
  return `${generatorId}:${list.join(',') || fallback || ''}`;
}

// How a repair is re-performed on a different site.
//
// Deliberately a CHAIN DESCRIPTOR, not an {anchor, replacement} edit. An
// anchor is one site's own source bytes (see implementers/lib/
// exact-match-patch.js — every anchor is matched against that file's real
// current content) and is meaningless in another repo. What actually
// transfers between clients is the ROUTING DECISION: "this problem class is
// reliably resolved by generator G". The generator then re-derives its own
// anchors from the target's real source, and its implementer refuses
// all-or-nothing if they don't match.
//
// So the learned part is deterministic where it can be (which chain) and
// locally-derived where it must be (the actual bytes).
export function buildRepairRecipe(generatorId) {
  if (!generatorId || !REPAIR_EVIDENCE_TIERS[generatorId]) return null;
  return { kind: 'generator-chain', generatorId, version: 1 };
}

// Every generator in risk-tiers.js's SAFE set is eligible, per the product
// decision to cover all 17. But 'safe' and 'safe to run on a stranger's repo
// on the strength of someone else's outcome' are different bars, and these
// generators do not share a failure mode — so the EVIDENCE required scales
// with how a bad match would actually fail. Every tier is reachable; the
// riskier ones just need proof from more independent sites first.
//
//   2 — exact-match-or-refuse. The implementer re-derives its anchor from the
//       target repo and refuses the whole draft if it is missing or ambiguous
//       (alt-text-inject.js, schema-repair-inject.js). A wrong match cannot
//       half-write a file; it declines and the issue flows to the Action
//       Center exactly as it does today.
//
//   3 — deterministic, no LLM. Output is reproducible from the same inputs,
//       so a bad match produces a predictable wrong value rather than
//       invented prose. But these write whole files or config (nginx, robots,
//       sitemap) with no anchor refusal to catch it.
//
//   4 — LLM prose through marker merge. No anchor refusal, and the content is
//       real customer-facing copy. A lesson learned on client A shaping
//       client B's visible text is the highest-consequence case here, so it
//       needs the most independent corroboration. The Quality Gate, approval
//       re-validation and the human PR review all still apply underneath.
const REPAIR_EVIDENCE_TIERS = {
  'alt-text': 2,
  'schema-repair': 2,

  canonical: 3,
  viewport: 3,
  'html-lang': 3,
  breadcrumbs: 3,
  'robots-fix': 3,
  'security-headers': 3,
  sitemap: 3,
  'llms-txt': 3,

  'meta-title': 4,
  faq: 4,
  'expand-content': 4,
  'qa-content': 4,
  'internal-links': 4,
  'open-graph': 4,
  schema: 4,
};

// How many DISTINCT other sites must have seen this repair succeed before it
// may run here. null = this generator may never be repaired cross-client.
export function requiredEvidenceFor(generatorId) {
  // Defence in depth: the tier table is hand-maintained, so anything that has
  // fallen out of the safe tier since is refused here regardless of what the
  // table still says. risk-tiers.js stays the single source of truth for
  // "may this ever run unattended at all".
  if (riskTierForGenerator(generatorId) !== 'safe') return null;
  return REPAIR_EVIDENCE_TIERS[generatorId] ?? null;
}

export function isRepairEligible(generatorId) {
  return requiredEvidenceFor(generatorId) !== null;
}
