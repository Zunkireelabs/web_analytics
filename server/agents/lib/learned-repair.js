import { riskTierForGenerator } from './risk-tiers.js';
import { findPortableRepairs, recordFixOutcome } from '../../agent-memory.js';
import { getSiteById } from '../../store/read.js';
import { resolveFile } from '../../implementers/lib/url-file-map.js';
import { computeSiteFingerprint, fingerprintCompatible } from './site-fingerprint.js';
import { topLevelCategoryForGenerator } from '../../generators/lib/pattern-categories.js';
import { TAG_TO_GENERATOR, GAP_TYPE_TO_GENERATOR } from './page-content.js';

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

// Reverse of TAG_TO_GENERATOR / GAP_TYPE_TO_GENERATOR — the real tag slugs a
// generator's draft is meant to resolve. Derived from the same mapping each
// agent sets recommendedAction.generatorId from, so it can never drift from
// it (the same derivation fix-verification.js has always done for its own
// still-flagged comparison).
//
// It lives here because BOTH sides of the signature need it and they are not
// otherwise symmetric: the writer has a fix_verifications row carrying real
// tags, while the reader has a grounded recommendation carrying only a human
// display label ("Add FAQ section"). Keying off that label would produce a
// signature that could never match anything the writer wrote — a silent,
// permanent miss. Both sides now derive the identical slugs from
// generatorId + source instead.
const GENERATOR_TO_TAGS = {};
for (const [tag, generatorId] of Object.entries(TAG_TO_GENERATOR)) {
  if (generatorId) (GENERATOR_TO_TAGS[generatorId] ||= []).push(tag);
}
const GENERATOR_TO_GAP_TYPES = {};
for (const [gapType, generatorId] of Object.entries(GAP_TYPE_TO_GENERATOR)) {
  if (generatorId) (GENERATOR_TO_GAP_TYPES[generatorId] ||= []).push(gapType);
}

export function tagsForGenerator(generatorId, source) {
  const map = source === 'content-gap' ? GENERATOR_TO_GAP_TYPES : GENERATOR_TO_TAGS;
  return map[generatorId] || [];
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

// ── Interception ───────────────────────────────────────────────────────────
//
// Runs between buildRecommendations() and syncFromGrounded() in job.js. That
// gap is the only place with all three properties this needs:
//   - buildRecommendations has already done every hard applicability check
//     (isPageMapped, a real GitHub file-existence read, adapter data
//     readiness), so an item here is genuinely actionable;
//   - the items are NOT yet persisted, so removing one means it never becomes
//     a recommendation row at all — which is what "fixed before it reaches
//     the Action Center" actually requires;
//   - it is one call site, and neither function has to change.
//
// Fails open everywhere. Any error, missing config, or absent evidence leaves
// the item exactly where it was: flowing to the Action Center as it does
// today. The worst case for this whole feature is that it does nothing.
const DRY_RUN = () => process.env.LEARNED_REPAIR_DRY_RUN === '1';

export async function interceptWithLearnedRepairs(siteId, grounded, deps = {}) {
  const { shipDraftForRecommendation } = deps.ship
    ? { shipDraftForRecommendation: deps.ship }
    : await import('./auto-remediation.js');

  const site = await getSiteById(siteId);

  // Three independent consents, all required. auto_remediation_enabled means
  // "act unattended on issues found on my site"; learned_repair_enabled means
  // "act using a repair whose only evidence comes from someone else's site".
  // A client can reasonably agree to the first and not the second.
  if (!site?.learned_repair_enabled || !site?.auto_remediation_enabled) return grounded;

  const items = grounded?.items || [];
  const repaired = new Set();

  for (const item of items) {
    const required = requiredEvidenceFor(item.generatorId);
    if (required === null) continue;

    // Derived from generatorId + source, NOT from item.tag — that field is a
    // human display label and would never match what the writer stored.
    const signature = problemSignatureFor(item.generatorId, tagsForGenerator(item.generatorId, item.source), item.source);
    const targetFingerprint = computeSiteFingerprint(site, {
      targetFilePath: item.params?.page ? resolveFile(site, item.params.page) : null,
    });

    let candidates = [];
    try {
      candidates = await findPortableRepairs({
        problemSignature: signature,
        category: topLevelCategoryForGenerator(item.generatorId),
        targetSiteId: siteId,
        minDistinctSites: required,
      });
    } catch (err) {
      console.error(`[learned-repair] site ${siteId} lookup failed for ${signature}:`, err.message);
      continue;
    }
    if (!candidates.length) continue;

    // Applicability is decided here, not in the SQL — the fingerprint compare
    // needs both sides in memory. First compatible candidate wins; they are
    // already ordered by confidence.
    let chosen = null;
    let lastRefusal = null;
    for (const c of candidates) {
      const compat = fingerprintCompatible(c.siteFingerprint, targetFingerprint);
      if (compat.ok) { chosen = c; break; }
      lastRefusal = compat.missing;
    }
    if (!chosen) {
      // Logged rather than silent: "no repair applied" and "no repair applied
      // because this site has no renderCapabilities.generator recorded" are
      // very different operational answers, and only one of them is a bug.
      console.log(`[learned-repair] site ${siteId} has ${candidates.length} proven repair(s) for ${signature} but none applicable here — blocked by: ${(lastRefusal || []).join(', ')}`);
      continue;
    }

    if (DRY_RUN()) {
      console.log(`[learned-repair] DRY RUN — would repair "${item.tag}" (${item.generatorId}) on site ${siteId} using memory #${chosen.id}, proven on ${chosen.provenSiteCount} other site(s), confidence ${chosen.confidence}.`);
      continue; // deliberately does NOT mark repaired — nothing was fixed
    }

    try {
      await shipDraftForRecommendation(siteId, {
        generatorId: item.generatorId, params: item.params,
        findingId: item.id, source: 'learned-repair', memoryRefId: chosen.id,
      });
      repaired.add(item.id);
      console.log(`[learned-repair] site ${siteId} repaired "${item.tag}" (${item.generatorId}) from memory #${chosen.id} — PR opened, awaiting human merge.`);
    } catch (err) {
      // A borrowed repair that fails on a foreign site is real evidence
      // against its portability, recorded immediately rather than waiting for
      // the 48h live re-check that will now never run (no draft reached
      // 'implemented'). Two of these flip the memory to flagged_for_review,
      // and findPortableRepairs' failed_reuse_count = 0 rule disqualifies it
      // from cross-client reuse after even one.
      console.warn(`[learned-repair] site ${siteId} could not apply memory #${chosen.id} to "${item.tag}", leaving it for the Action Center:`, err.message);
      await recordFixOutcome({
        memoryRefId: chosen.id, outcome: 'failure', agentId: 'learned-repair',
        generatorId: item.generatorId, siteId, notes: `cross-client repair failed: ${err.message}`,
      }).catch(() => {});
    }
  }

  if (!repaired.size) return grounded;

  // detectedKeys is passed through UNTOUCHED on purpose. The issue is
  // genuinely still live on the site until a human merges the PR, so the key
  // must stay "detected" — dropping it would let closeStaleRecommendations
  // treat the problem as resolved before anything actually shipped.
  return { ...grounded, items: items.filter((i) => !repaired.has(i.id)) };
}
