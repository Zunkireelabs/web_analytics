import { riskTierForGenerator } from './risk-tiers.js';
import { findPortableRepairs, recordFixOutcome } from '../../agent-memory.js';
import { sanitizeForCustomer } from '../../lib/errors.js';
import { getSiteById } from '../../store/read.js';
import { resolveFile } from '../../implementers/lib/url-file-map.js';
import { computeSiteFingerprint, fingerprintCompatible } from './site-fingerprint.js';
import { getOrClassifyPageContentType } from './page-content-classifier.js';
import { topLevelCategoryForGenerator } from '../../generators/lib/pattern-categories.js';
import { TAG_TO_GENERATOR, GAP_TYPE_TO_GENERATOR } from './page-content.js';

// Policy layer for cross-client learned repair: which problems are keyed how,
// which generators may act on a stranger's repository, and how much proof
// each needs first. Deliberately separate from agent-memory.js (which stores
// and retrieves) and from auto-remediation.js (which executes) — this module
// only decides.
//
// CROSS-SITE SAFETY BOUNDARY — read this before touching either side of it.
// This feature is INTENTIONALLY not site-isolated: the entire point is that
// a repair proven on client A's site can act on client B's repository
// (findPortableRepairs in agent-memory.js does not filter by site_id). That
// is a deliberate product decision, not an oversight, and it must stay that
// way — do not "fix" it into per-site isolation.
//
// What makes that safe is NOT tenant isolation, it's that only a GENERIC
// repair lesson is eligible to cross that boundary, enforced by construction
// rather than by review:
//   - the only thing that actually moves from site A to site B is
//     `repair_recipe` (buildRepairRecipe above) — `{kind, generatorId,
//     version}`. It names WHICH generator chain to re-run, never the bytes
//     it produced. The implementer re-derives every anchor/edit from B's own
//     real source and refuses if it doesn't match (see buildRepairRecipe's
//     comment) — so even a malformed recipe cannot inject A's content into B.
//   - `site_fingerprint` (site-fingerprint.js) is technology-only tokens
//     (render engine, file extension, adapter id, content-type LABEL) — no
//     client name, domain, URL or path; enforced by
//     site-fingerprint.test.js's PRIVACY assertions.
//   - the free-text fields that DO travel with a memory row (symptoms,
//     affected_pattern, fix_strategy, fix_pattern) are all generalized
//     descriptions the writer composes from generatorId/tags/source, never
//     from page content or a customer's draft copy (see
//     fix-verification.js's learnFromOutcome), and are additionally passed
//     through agent-memory.js's sanitizeLessonText before every insert as a
//     second, independent net.
//   - findPortableRepairs' returned shape (agent-memory.js) exposes only
//     id/generatorId/problemSignature/siteFingerprint/repairRecipe/
//     confidence/counts — symptoms/notes/affected_pattern/fix_strategy are
//     never part of it, so even if one of those fields somehow carried
//     something client-specific, this reuse path has no way to read it.
// The actual isolation for THIS feature is the technical/structural/
// content-context/evidence gate below, not `site_id` — see
// interceptWithLearnedRepairs.

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
// riskier ones just need proof from more independent sites first. Values are
// the number of distinct other sites required, not a tier label — kept
// deliberately unequal across tiers (1 / 2 / 4, not a fixed step) so a
// tightened or loosened bar for one class never has to touch another's.
//
//   exact-match-or-refuse (1 site required) — alt-text, schema-repair. The
//       implementer re-derives its anchor from the target repo and refuses
//       the whole draft if it is missing or ambiguous (alt-text-inject.js,
//       schema-repair-inject.js). A wrong match cannot half-write a file; it
//       declines and the issue flows to the Action Center exactly as it does
//       today — so a single prior success is enough proof.
//
//   deterministic, no LLM (2 sites required) — canonical, viewport,
//       html-lang, breadcrumbs, robots-fix, security-headers, sitemap,
//       llms-txt. Output is reproducible from the same inputs, so a bad
//       match produces a predictable wrong value rather than invented prose,
//       but these write whole files or config with no anchor refusal to
//       catch it — hence more than 1, but still far below the LLM tier.
//
//   LLM prose through marker merge (4 sites required) — meta-title, faq,
//       expand-content, qa-content, internal-links, open-graph, schema. No
//       anchor refusal, and the content is real customer-facing copy. A
//       lesson learned on client A shaping client B's visible text is the
//       highest-consequence case here, so it keeps the most independent
//       corroboration. The Quality Gate, approval re-validation and the
//       human PR review all still apply underneath.
const REPAIR_EVIDENCE_TIERS = {
  'alt-text': 1,
  'schema-repair': 1,

  canonical: 2,
  viewport: 2,
  'html-lang': 2,
  breadcrumbs: 2,
  'robots-fix': 2,
  'security-headers': 2,
  sitemap: 2,
  'llms-txt': 2,

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

    let candidates = [];
    try {
      // No minDistinctSites here on purpose — that would apply the EVIDENCE
      // gate before the TECHNICAL/STRUCTURAL/CONTENT-CONTEXT gate below has
      // even run (see agent-memory.js's default). The generator-specific
      // evidence bar (`required`, resolved above from REPAIR_EVIDENCE_TIERS)
      // is applied by this module, after compatibility, in the loop below.
      candidates = await findPortableRepairs({
        problemSignature: signature,
        category: topLevelCategoryForGenerator(item.generatorId),
        targetSiteId: siteId,
      });
    } catch (err) {
      console.error(`[learned-repair] site ${siteId} lookup failed for ${signature}:`, err.message);
      continue;
    }
    if (!candidates.length) continue;

    // Content-type classification (page-content-classifier.js) is the one
    // fingerprint input that costs real money (a DB read, occasionally an
    // LLM call), so it only runs here — for a page that already has a real
    // evidence-backed candidate — never for the common case of a page with
    // no learned repair at all. A cache hit on a page already classified for
    // an earlier candidate/run costs nothing further.
    //
    // This IS the "investigate" step of the technical -> structural ->
    // content-context -> evidence decision chain: an uncached page gets
    // classified right here, live, before the applicability verdict is made
    // — not a separate persisted state, just a lazily-resolved fact.
    const targetContentType = item.params?.page
      ? await getOrClassifyPageContentType(siteId, item.params.page).catch(() => null)
      : null;
    const targetFingerprint = computeSiteFingerprint(site, {
      targetFilePath: item.params?.page ? resolveFile(site, item.params.page) : null,
      pageUrl: item.params?.page || null,
      actionType: item.generatorId,
      contentType: targetContentType?.contentType || null,
    });

    // The decision chain, explicit and in order — each candidate must clear
    // every earlier gate before a later one is even consulted:
    //
    //   1-3. TECHNICAL -> STRUCTURAL -> CONTENT CONTEXT, all three folded
    //        into one fingerprintCompatible() call (site-fingerprint.js):
    //        render:/target-ext: (technical), page-adapter: (structural),
    //        content-type: (content context). Any one of them failing is a
    //        flat refusal regardless of how much reuse evidence exists.
    //   4.   EVIDENCE — `c.provenSiteCount >= required` — is checked ONLY
    //        after a candidate has already passed step 1-3. A candidate with
    //        abundant cross-site evidence but an incompatible fingerprint is
    //        never chosen; a compatible candidate with too little evidence
    //        is skipped in favor of a later, sufficiently-proven one. Nothing
    //        in this loop can let evidence alone stand in for compatibility.
    //
    // Applicability is decided here, not in the SQL — the fingerprint
    // compare needs both sides in memory. First candidate to clear ALL FOUR
    // gates wins; candidates arrive ordered by confidence.
    let chosen = null;
    let lastRefusal = null;
    for (const c of candidates) {
      const compat = fingerprintCompatible(c.siteFingerprint, targetFingerprint);
      if (!compat.ok) { lastRefusal = compat.missing; continue; }
      if (c.provenSiteCount < required) {
        lastRefusal = [`evidence:${c.provenSiteCount}<${required}`];
        continue;
      }
      chosen = c;
      break;
    }
    if (!chosen) {
      // Logged rather than silent: "no repair applied" and "no repair applied
      // because this site has no renderCapabilities.generator recorded" are
      // very different operational answers, and only one of them is a bug.
      // A refusal whose `missing` names content-type: specifically is a
      // content-context mismatch/uncertainty rather than a technical/
      // structural one, and one naming `evidence:` is neither — both still
      // fall through to the same Action Center path, but the self-describing
      // token names in the log line below (e.g. "content-type:blog!=
      // content-type:product" vs "render:eleventy!=render:nextjs" vs
      // "evidence:1<4") already keep the distinction inspectable.
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
        findingId: item.id, source: 'learned-repair', findingOrigin: item.source || null, memoryRefId: chosen.id,
        // Unattended cron pass — see auto-remediation.js's identical option.
        waitForDesignAgent: true,
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
      // ITEM-STATE refusals ('awaiting-human-review': a person is mid-review
      // of this exact draft; 'draft-reset': a stranded row was reset for a
      // clean retry — see auto-remediation.js's draftShipState handling) say
      // nothing about whether this MEMORY's repair is portable. They are
      // plumbing/state noise on the target site, not a defect in the
      // borrowed pattern. Recording them as a genuine 'failure' would
      // penalize a real, working repair for hitting someone else's mid-review
      // draft — two of these flip the memory to flagged_for_review and
      // disqualify it from further cross-client reuse for a reason that has
      // nothing to do with the repair itself.
      const isItemStateRefusal = err.reason === 'awaiting-human-review' || err.reason === 'draft-reset';
      if (isItemStateRefusal) continue;
      // reuse_history is persisted (agent_fix_memory), not just logged — the
      // raw exception text stops at the console.warn above. sanitizeForCustomer
      // is the same persistence-boundary net server/lib/errors.js already
      // documents for drafts/agent-runs/audit-runs; this notes field is the
      // same kind of boundary, just on a different table.
      await recordFixOutcome({
        memoryRefId: chosen.id, outcome: 'failure', agentId: 'learned-repair',
        generatorId: item.generatorId, siteId,
        notes: `cross-client repair failed: ${sanitizeForCustomer(err.message, '(internal error — see server logs)')}`,
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
