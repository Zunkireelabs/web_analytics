// Phase 4 §5's safe/manual split, keyed by generatorId (= recommendations.recommendation_type).
// SAFE generators are eligible for the Execution Engine's auto-chain
// (executeSafeFixes/approveAndShipRecommendation, execution-engine.js) —
// everything else always goes through the existing stepped
// Generate -> Submit -> Approve flow with a human decision at each step.
//
// Confirmed with the user 2026-08-04: broken-link-fix and blog-outline
// swapped from their first-draft classification (broken-link-fix moved to
// manual — a wrong redirect/link fix breaks live navigation; blog-outline
// moved to safe — it drafts an outline for review, doesn't publish net-new
// pages on its own). cookie-policy/privacy-policy/terms-of-service default
// to manual (not in the spec's explicit safe list, legal-content risk).
// analytics-install deliberately stays out of the safe set: its draft is
// blocked on a real tracking ID a human has to supply (see
// generators/analytics-install.js), so it can never be a genuine zero-review
// auto-publish candidate the way the rest of this list is.
//
// Re-confirmed with the user 2026-08-07: blog-outline moved back to manual.
// It no longer drafts an outline — generators/blog-outline.js now produces a
// complete, publication-ready article — so the original "it's just an
// outline for review" justification for the safe tier no longer holds. A
// full net-new blog post reaching a live PR gets one human glance first,
// same as landing-page/legal content, even though the completeness gate
// (content-scaffolding-guard.js + the word-count floor in the generator
// itself) should already keep stubs from ever reaching a draft.
const SAFE_GENERATOR_IDS = new Set([
  'meta-title', 'faq', 'schema', 'llms-txt', 'internal-links', 'sitemap',
  'robots-fix', 'security-headers', 'html-lang', 'canonical', 'viewport',
  'open-graph', 'expand-content', 'qa-content',
  // Deterministic from the page's real URL path, no LLM — same shape as
  // canonical.js, which is already in this set for the same reason.
  'breadcrumbs',
  // Safe to auto-attempt because the actual file patch (implementers/lib/
  // schema-repair-inject.js) only ever applies when the exact broken/
  // duplicate JSON-LD text is still found byte-for-byte in the site's real
  // source — a failed match already means auto-remediation.js leaves the
  // recommendation open for a human, same "exact-match auto-patch, else
  // fall back to manual" rule confirmed for alt-text below.
  'schema-repair',
  // Re-confirmed with the user 2026-08-07: moved from implicitly-manual
  // (no SAFE_GENERATOR_IDS entry) now that implementers/lib/alt-text-inject.js
  // gives it the same exact-match-or-refuse auto-patch as schema-repair
  // above — a missing/ambiguous anchor already means the whole draft is
  // refused at apply time, which is what leaves the recommendation open for
  // a human instead of silently failing.
  'alt-text',
  // Promoted 2026-08-12 during a full audit of all 29 generators. It has the
  // same exact-match-or-refuse shape as schema-repair and alt-text above:
  // href-rewrite-inject.js rewrites one specific <a href> and returns
  // 'no-match' (or 'nested-anchor') rather than touching a file it isn't sure
  // about, so a draft it can't apply cleanly is refused whole and the
  // recommendation stays open for a human.
  //
  // The obvious objection is that broken-link-fix is manual precisely because
  // "a wrong redirect/link fix breaks live navigation", and this also rewrites
  // a link. The difference is where the replacement URL comes from, and it is
  // a real one: broken-link-fix has to FIND a plausible replacement for a dead
  // link (its params.page is only the first page the href was crawled from,
  // and it falls back to GitHub code search), whereas redirect-fix's
  // destination was already observed — technical-seo.js followed the actual
  // redirect chain to its real endpoint. There is no guess to get wrong. The
  // generator is pure and deterministic with no LLM call at all.
  'redirect-fix',
]);

// Everything NOT in the set above is manual, and stays that way for a stated
// reason rather than by omission. Recorded here so a future audit re-litigates
// evidence instead of guessing at intent (all 29 generator ids reviewed
// 2026-08-12):
//
//   analytics-install  — its draft is blocked on a real tracking ID a human has
//                        to supply, so it can never be a zero-review auto-apply.
//   broken-link-fix    — must infer a replacement for a dead link; see above.
//   duplicate-id-fix   — renaming an id safely needs every CSS/JS/anchor
//                        reference to it, which a static fetch cannot see. Its
//                        one provably-safe shape (an SVG gradient referenced
//                        only by url(#id) within its own <svg>) auto-applies,
//                        and every other occurrence falls back to an advisory
//                        draft with no file diff — which would fail at apply if
//                        it reached an unattended chain.
//   geo-audit          — report/score only, deliberately never actionable
//                        (confirmed 2026-08-10).
//   cookie-policy,     — legal content. Publishing unreviewed legal text is a
//   privacy-policy,      different category of risk from a meta tag, regardless
//   terms-of-service     of how good the draft is.
//   translation        — publishes a whole machine-translated, indexable page.
//                        Quality and brand risk, unreviewed.
//   landing-page       — net-new page, and unlike blog-outline it has no
//                        word-count floor or expansion retry of its own.
//   blog-outline,      — net-new CONTENT: both are genuinely safe candidates,
//   direct-answer        but both resolve their target through
//                        url_file_map.newContentTargets, which no site is
//                        configured for yet. Promoting them before that config
//                        exists would only manufacture drafts that fail at
//                        apply time. Revisit together once net-new targets are
//                        configured — see the plan's Phase 5.

export function riskTierForGenerator(generatorId) {
  return SAFE_GENERATOR_IDS.has(generatorId) ? 'safe' : 'manual';
}
