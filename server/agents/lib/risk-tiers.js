// Phase 4 §5's safe/manual split, keyed by generatorId (= recommendations.recommendation_type).
// SAFE generators are eligible for the Execution Engine's auto-chain
// (executeSafeFixes/approveAndShipRecommendation, execution-engine.js) —
// everything else always goes through the existing stepped
// Generate -> Submit -> Approve flow with a human decision at each step.
//
// Re-confirmed with the user 2026-08-15: only two generators are still
// deliberately kept manual — landing-page and translation (see the bottom
// of this file for why). Every other generator either already refuses
// cleanly instead of guessing (broken-link-fix, duplicate-id-fix,
// analytics-install), is structurally inert until a site configures a
// target for it (geo-audit, direct-answer), or now has a real programmatic
// safety check backing it (cookie-policy/privacy-policy/terms-of-service —
// see legal-fact-guard.js/quality-gate.js) instead of only a disclaimer.
//
// Confirmed with the user 2026-08-04: blog-outline swapped from its
// first-draft classification — moved to safe because it drafted an outline
// for review, not a net-new page on its own. (blog-outline itself moved to
// manual and back again below; see that entry's own history.)
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
  // Added alongside content-integrity.js/font-consistency.js (the
  // detectors) — every one of its five fix shapes (malformed-table,
  // raw-text-table, faq-schema-mismatch, duplicate-faq, font-size-override)
  // is a pure deterministic transform of content already, verifiably on the
  // page (never invented table data, a guessed FAQ answer, or a judgment
  // about which CSS class/rule is "correct" — see generators/content-
  // integrity-repair.js's own refuse-rather-than-guess conditions), and the
  // actual file patch (implementers/lib/content-integrity-inject.js) has
  // the exact same exact-match-or-refuse shape as schema-repair above: a
  // changed/removed anchor since detection means the draft is refused at
  // apply time, not force-applied. The duplicate-faq shape specifically is
  // only ever offered when detection found substantial (>=80%) real
  // question-text overlap between two FAQ sections — two genuinely
  // different FAQ sections on one page are flagged for visibility but never
  // reach this generator at all. font-size-override is only ever offered
  // when the outlier element carries its OWN inline font-size override — an
  // outlier caused by a shared CSS class/stylesheet rule (which would
  // affect every other element using that class) never gets a
  // recommendedAction — see content-integrity.js/font-consistency.js.
  'content-integrity-repair',
  // Added with agents/blog-image.js (2026-09-01) — same exact-match-or-
  // refuse contract as schema-repair/content-integrity-repair above:
  // implementers/lib/blog-image-inject.js re-fetches the post live and
  // refuses if it already has an image field under any alias (picked up by
  // a human, another agent, or an earlier day's own already-merged batch)
  // rather than appending a second one.
  'blog-image',
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
  // recommendation stays open for a human. redirect-fix's destination was
  // already observed — technical-seo.js followed the actual redirect chain
  // to its real endpoint. There is no guess to get wrong. The generator is
  // pure and deterministic with no LLM call at all.
  'redirect-fix',
  // Promoted 2026-08-15: the "must guess a replacement for a dead link"
  // reasoning that used to keep this manual describes a generator behavior
  // that no longer exists. generators/broken-link-fix.js never proposes a
  // replacement URL — it only ever drafts the REMOVAL of a confirmed-dead
  // link (keeping its real visible text as plain content), and
  // implementers/lib/href-rewrite-inject.js's stripLink() only applies when
  // the exact dead href is still found byte-for-byte in the live file,
  // refusing otherwise. Same exact-match-or-refuse shape as redirect-fix
  // above, just one step more conservative (deletes rather than rewrites).
  'broken-link-fix',
  // Promoted 2026-08-15. The one non-provably-safe shape (anything other
  // than an SVG gradient/clipPath/mask referenced only by url(#id)) already
  // produces an advisory draft with no file diff, which the apply-time
  // implementer refuses with a clean 422 rather than a false "failure" —
  // confirmed to route through the same refusal path (not the circuit
  // breaker) as every other exact-match-or-refuse generator above.
  'duplicate-id-fix',
  // Promoted 2026-08-15. Self-gating: generators/analytics-install.js only
  // ever produces a complete, apply-ready draft when a real tracking ID was
  // already known; otherwise it ships with placeholderFields and
  // implementers/lib/marker-merge.js refuses apply with a clear "fill this
  // in manually" error — the same refusal path as duplicate-id-fix, so this
  // can never silently auto-publish a placeholder.
  'analytics-install',
  // Promoted 2026-08-15. Moot in practice: geo-audit has no registered
  // implementer at all (nothing in implementers/backend.js's `handles`
  // list) — it produces a report/score, never a file diff, so there is
  // nothing for the auto-chain to ever apply. Membership here changes
  // nothing; recorded for consistency with the rest of this file's stated-
  // reason convention.
  'geo-audit',
  // Promoted 2026-08-15. Same net-new content gate as blog-outline above:
  // buildRecommendations demotes a direct-answer recommendation to 'manual'
  // whenever url_file_map.newContentTargets has no entry for it — true for
  // every site today — so this is inert until a site configures a real
  // target dir, at which point it unblocks itself with no further change
  // here, same as blog-outline already relies on.
  'direct-answer',
  // Promoted 2026-08-15, together as a set: cookie-policy, privacy-policy,
  // and terms-of-service all share compliance-draft.js's
  // generateCompliancePage(), which now has a real programmatic safety net
  // instead of only a "have a lawyer review this" disclaimer —
  // quality-gate.js runs legal-fact-guard.js's findUnverifiedLegalClaims()
  // against these three, flagging any third-party service or contact detail
  // the draft mentions that isn't backed by its own real detected facts
  // (content.factsUsed). A draft that invents a fact fails the gate (refused,
  // stays open for a human — the same generate-time-retry-then-refuse,
  // approve-time-recheck flow every other generator already goes through);
  // one that sticks to real facts + generic policy language ships
  // unattended. Also still gated by the same net-new url_file_map.
  // newContentTargets requirement as blog-outline/direct-answer, so this is
  // inert on any site that hasn't configured a target for it.
  'cookie-policy', 'privacy-policy', 'terms-of-service',
  // Promoted 2026-08-12 on an explicit product decision: growing impressions
  // depends on new content, not only on fixing existing pages, so the agent must
  // be able to draft an article and open a PR without a human first clicking
  // Generate. This reverses the 2026-08-07 move to manual, whose reasoning was
  // that a full net-new article "gets one human glance first" — it still does.
  // The glance just happens on the PR, where it happens for every other safe
  // generator, instead of gating whether the work starts at all.
  //
  // What actually stands between a topic and a merged article:
  //   1. MIN_TOTAL_WORDS = 800 in the generator, with one bounded expansion pass
  //      and then a hard 502 — a stub cannot become a draft.
  //   2. content-scaffolding-guard, whose blog-outline exemption was already
  //      removed, plus the rest of the Quality Gate at generate AND approve.
  //   3. newpage-render.js no longer publishes the "FAQ topics to cover" /
  //      "Suggested internal links" editorial checklist into the article body.
  //      That fix is a hard prerequisite for this promotion, not a nicety: it is
  //      the difference between a reviewable article and one that visibly reads
  //      as machine output.
  //   4. A human still merges. Autonomy ends at the PR.
  //
  // Safe for tenants that are NOT configured for net-new content, which is every
  // tenant except site 1 today: buildRecommendations blocks a net-new
  // recommendation with no url_file_map.newContentTargets entry and the
  // coordinator demotes it to 'manual', so it stays visible with a reason rather
  // than being queued into the unattended chain to fail at apply. It unblocks by
  // itself once that config exists.
  //
  // Blogs are not generated daily. The only agents that raise blog-outline
  // findings are content-gap and ai-recommendation, neither of which is in
  // DAILY_AGENT_IDS — so opportunities appear on a weekly/monthly cadence and
  // the daily run ships whatever is genuinely open, rather than inventing a
  // topic every morning.
  'blog-outline',
]);

// Everything NOT in the set above is manual, and stays that way for a stated
// reason rather than by omission. Recorded here so a future audit re-litigates
// evidence instead of guessing at intent (all 29 generator ids reviewed
// 2026-08-12, re-reviewed 2026-08-15 — only these two remain):
//
//   translation  — publishes a whole machine-translated, indexable page.
//                 Quality and brand risk, unreviewed — no programmatic check
//                 here plays the same role legal-fact-guard.js plays for
//                 the legal generators above, so this stays manual.
//   landing-page — net-new page, and unlike blog-outline it has no
//                 word-count floor or expansion retry of its own.

export function riskTierForGenerator(generatorId) {
  return SAFE_GENERATOR_IDS.has(generatorId) ? 'safe' : 'manual';
}
