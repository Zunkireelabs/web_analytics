// Assembles the read-only "what did the design agent learn, and what will it
// write" report a staff human reviews before signing off — see
// db.js's updateSiteDesignReview and design-drift.js's designReviewState,
// the ship-time gate this review exists to satisfy.
//
// Pure: takes the site row the route already fetched, does no DB/network
// I/O of its own, so it is testable without a database (the design-integrity
// gate's whole point is a checkable mechanism, not a trust-me screen).
import {
  observedClassesByRole, checkTypographyRole, TYPOGRAPHY_ROLE_SOURCE,
  designReviewFingerprint, designReviewState, getDesignProfile,
} from '../../implementers/lib/design-drift.js';
import { projectAllComponentTemplates } from '../../design-agent/lib/design-profile.js';
import { renderFaqHtml, renderQaHtml, renderExpandedHtml, renderLinksHtml } from '../../implementers/lib/marker-merge.js';

// Real, clearly-labeled sample content — never lorem ipsum, so a reviewer is
// reading something that reads like a plausible real draft, not filler.
const SAMPLE_QA_ITEMS = [
  { question: 'Do you offer same-day service?', answer: 'Yes — most requests booked before 2pm are completed the same day, subject to availability in your area.' },
];
const SAMPLE_EXPAND_SECTIONS = [
  { heading: 'What to expect during your visit', body: 'A technician arrives within your scheduled window, reviews the issue with you, and explains pricing before any work begins.' },
];
const SAMPLE_LINKS = [{ targetUrl: '/pricing/', anchorText: 'View our pricing' }];
const SAMPLE_BODY_MARKDOWN = 'This is a sample paragraph of body copy, rendered in the site\'s real typography so you can confirm it looks right before anything real ships in it.';

// Same split-open/close-around-{{BODY}} newpage-render.js's own
// fillContentWrapper uses for content-wrapper's single slot — kept as its
// own copy rather than an import so this module's dependency footprint stays
// limited to design-drift.js/design-profile.js/marker-merge.js, not the
// whole net-new-page renderer.
function fillBodySlot(wrapper, body) {
  const [open, close] = wrapper.split('{{BODY}}');
  return `${open.trimEnd()}\n\n${body}\n\n${close.trimStart()}`;
}

// actionType -> the typography fields it actually reads at render time, in
// the SAME fallback order the real projector uses (design-profile.js) — so
// "which verdict applies to this template" can never drift from "what the
// template actually renders with". content-wrapper reads no typography role
// field at all (structural only: layout.container/prose + spacing.section),
// so it is deliberately absent — see reviewTemplate's `ok: null` for it.
const ACTION_TYPE_ROLE_FIELDS = {
  faq: () => ['typography.heading.item', 'typography.body'],
  'qa-content': () => ['typography.heading.item', 'typography.body'],
  // expand-content prefers heading.section, falling back to heading.item —
  // report on whichever one WILL actually be used for this profile, same
  // fallback projectExpandContent itself evaluates (`t.heading.section ||
  // t.heading.item`).
  'expand-content': (profile) => [
    profile?.typography?.heading?.section ? 'typography.heading.section' : 'typography.heading.item',
    'typography.body',
  ],
  // internal-links prefers link, falling back to body — the real fallback
  // projectInternalLinks uses (`t.link || t.body`).
  'internal-links': (profile) => [profile?.typography?.link ? 'typography.link' : 'typography.body'],
};

const SOURCE_BY_FIELD = Object.fromEntries(TYPOGRAPHY_ROLE_SOURCE.map((s) => [s.field, s]));

// The one real section that carries `classes`, in ANY role — not filtered to
// the role being checked, deliberately: for a role-mismatch verdict this is
// what lets a reviewer click through to the real element the class actually
// belongs to (its true role), which is the more useful answer than "not
// found in the expected role". Returns null when the class was never
// observed anywhere in the capture — the class-unobserved case.
function findExampleSection(profile, classes) {
  if (!classes) return null;
  const normalized = classes.trim().split(/\s+/).filter(Boolean).join(' ');
  for (const page of profile?.pages || []) {
    for (const section of page.sections || []) {
      for (const item of section.textHierarchy || []) {
        if (!item.classes) continue;
        if (item.classes.trim().split(/\s+/).filter(Boolean).join(' ') !== normalized) continue;
        return { page: page.url, sectionRole: section.role, itemRole: item.role, tag: item.tag };
      }
    }
  }
  return null;
}

// One template's full review row: its rendered sample markup (via the SAME
// render functions the ship path uses, marker-merge.js — never a
// re-implemented approximation a reviewer could be shown something
// different from what actually ships), plus every typography field it
// actually draws from, each with its role-verification verdict and a real
// example of where that class string was (or wasn't) observed.
function reviewTemplate(actionType, profile, template, observed) {
  const fields = (ACTION_TYPE_ROLE_FIELDS[actionType]?.(profile)) || [];

  const roleChecks = fields.map((field) => {
    const source = SOURCE_BY_FIELD[field];
    const result = checkTypographyRole(profile, source, observed);
    return { ...result, example: findExampleSection(profile, source.get(profile)) };
  });

  let sample = null;
  if (template) {
    if (actionType === 'faq') sample = renderFaqHtml(SAMPLE_QA_ITEMS, template);
    else if (actionType === 'qa-content') sample = renderQaHtml(SAMPLE_QA_ITEMS, template);
    else if (actionType === 'expand-content') sample = renderExpandedHtml(SAMPLE_EXPAND_SECTIONS, template);
    else if (actionType === 'internal-links') sample = renderLinksHtml(SAMPLE_LINKS, template);
    else if (actionType === 'content-wrapper') sample = fillBodySlot(template.wrapper, SAMPLE_BODY_MARKDOWN);
  }

  return {
    actionType,
    available: !!template,
    sample,
    roleChecks,
    // A template only genuinely fails review when one of its OWN role checks
    // is a CONFIRMED mismatch — class-unobserved is weak evidence and must
    // not read as broken on the review screen either, the same rule
    // verifyProfileRoles itself uses to decide what blocks. null (not
    // true/false) for content-wrapper, which has no role field to judge.
    ok: !template ? null : (fields.length === 0 ? null : roleChecks.every((r) => r.ok || r.reason !== 'role-mismatch')),
  };
}

// Every captured page's sections, grouped by pageType, sections kept in
// their real captured order — the "what we found on your site" half of the
// review.
export function sectionInventory(profile) {
  const byType = new Map();
  for (const page of profile?.pages || []) {
    if (!byType.has(page.pageType)) byType.set(page.pageType, []);
    byType.get(page.pageType).push({
      url: page.url,
      sections: [...(page.sections || [])].sort((a, b) => a.order - b.order),
    });
  }
  return Object.fromEntries(byType);
}

const REVIEWABLE_ACTION_TYPES = ['faq', 'qa-content', 'expand-content', 'internal-links', 'content-wrapper'];

// The full report a staff review screen renders: everything the design agent
// learned, and everything it would write, side by side with the real
// evidence behind each — plus the current sign-off state (designReviewState)
// so the screen can say plainly whether this profile is already approved,
// stale (re-derived since approval), or has never been reviewed.
export function buildDesignReviewReport(site) {
  const profile = getDesignProfile(site);
  // Just enough to render a page header without a second fetch — never the
  // full site row (repo owner, tokens, etc. have no business on this screen).
  const siteSummary = { id: site?.id ?? null, name: site?.name ?? null };
  if (!profile) {
    return {
      site: siteSummary, hasProfile: false, sections: {}, templates: [],
      currentFingerprint: null, reviewedAt: null, reviewedBy: null,
      reviewState: { ok: false, reason: 'unreviewed' },
    };
  }

  const templates = projectAllComponentTemplates(profile);
  const observed = observedClassesByRole(profile);
  const templateReviews = REVIEWABLE_ACTION_TYPES.map((actionType) => reviewTemplate(actionType, profile, templates[actionType], observed));

  return {
    site: siteSummary,
    hasProfile: true,
    sections: sectionInventory(profile),
    templates: templateReviews,
    currentFingerprint: designReviewFingerprint(profile),
    reviewedAt: site.design_review_at || null,
    reviewedBy: site.design_review_by || null,
    reviewState: designReviewState(site),
  };
}
