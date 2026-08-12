import { safeMessage } from '../../lib/errors.js';
import { updateSiteRepoConfig } from '../../db.js';
import { recordAuditEvent } from '../../store/admin/audit-log.js';
import { recordFixOutcome } from '../../agent-memory.js';
import { createComponentTemplateHandler, DESIGN_AGENT_GENERATOR_ID } from '../../design-agent/openhands-handler.js';
import { FRONTEND_ACTION_TYPES } from '../frontend.js';
import { createComponentTemplateJob, getQueuedComponentTemplateJob } from '../../store/execution-jobs.js';

// componentTemplates (marker-merge.js) are a one-time, hand-captured
// snapshot of a site's REAL design — real Tailwind classes copied out of the
// live site at config time. Nothing keeps that snapshot in sync with the
// site's own design changing later: if the site redesigns and the classes
// baked into the stored template stop being generated at all (Tailwind only
// ships CSS for classes it can see referenced somewhere at build time), the
// stored template still LOOKS correct (same class names in the HTML) but
// renders with zero actual styling — exactly the "looks bigger/different
// than the rest of the site" failure this module exists to catch before it
// ships, not after a human notices it live.
//
// Only action types with a real componentTemplates entry can go stale this
// way — meta-title/schema/canonical/open-graph are plain values with no CSS
// component to drift. Net-new content (blog-outline/landing-page/translation/
// direct-answer and the compliance pages, frontend.js) was once assumed to be
// "always current by construction" because it lands in the site's own layout
// template; that is only true of the layout CHROME. The body itself gets no
// typography from the layout unless the site's real prose wrapper is applied
// to it, which is what componentTemplates.contentWrapper supplies — so these
// are gated like any other rendered component. qa-content is deliberately excluded even though
// it has a componentTemplates entry: its DEFAULT_QA_TEMPLATE (marker-merge.js)
// uses a native <details>/<summary> element with no site-specific classes at
// all when unconfigured, so there's nothing that can go stale until a site
// actually opts into a custom qaContent template — see checkTemplateFreshness's
// own early-return for a template with zero literal classes.
export const COMPONENT_TEMPLATE_KEY = {
  faq: 'faq',
  'expand-content': 'expandContent',
  'internal-links': 'internalLinks',
  'qa-content': 'qaContent',
  // Net-new whole-page markdown content — every frontend.js action type
  // (terms/privacy/cookie-policy, landing-page, blog-outline, direct-answer,
  // translation; see newpage-render.js) — has no repeating-item
  // "rows" the way faq/expand-content/internal-links do, just a single
  // {{BODY}} slot — same per-site, Design-Agent-derived template mechanism,
  // one entry, no `row` placeholder requirement (see REQUIRED_PLACEHOLDERS
  // and validatePlaceholders below).
  'content-wrapper': 'contentWrapper',
};

// Bounded so a stalled/hanging origin can't wedge a draft-generation request
// (or the unattended auto-remediation loop) indefinitely — every caller here
// already treats null as "couldn't check," and a timeout is exactly that: an
// infra failure, not evidence the template is bad. Callers fail OPEN on null
// (see checkTemplateFreshness's contract below), so a slow site degrades to
// "unverified freshness" rather than to a wrong verdict.
const FETCH_TIMEOUT_MS = Number(process.env.DESIGN_DRIFT_FETCH_TIMEOUT_MS || 10000);

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function resolveUrl(base, href) {
  try { return new URL(href, base).href; } catch { return href; }
}

// Real class names literally present in a template's `class="..."` attributes
// — the only thing checked against the live CSS. Deliberately does NOT parse
// Alpine's `:class="{ 'x': expr }"` conditional bindings (e.g. the FAQ
// accordion's chevron rotation) — those are a minor visual embellishment,
// not the structural styling (typography/spacing/layout) that actually
// causes the "looks mismatched" failure this exists to catch, and reliably
// parsing arbitrary JS-object-literal syntax out of an attribute isn't worth
// the complexity for that.
// (?<!:) excludes Alpine's `:class="..."` dynamic binding attribute — a
// bare \b word boundary alone still matches right after the `:` (a
// non-word character), so this regex was matching :class="{ 'rotate-45':
// activeIndex === {{INDEX}} || expandAll }" too despite the comment above
// already documenting the intent to skip it. Extracted that whole JS
// object-literal expression as if it were a space-separated class list,
// then correctly failed to find garbage tokens like "activeIndex"/"==="/
// "||" in any real stylesheet — a real template (e.g. the FAQ accordion,
// now also reused for qaContent) was being rejected as stale for a page
// design mismatch that was never real.
const CLASS_ATTR_RE = /(?<!:)\bclass="([^"]*)"/g;
export function extractLiteralClassNames(templateEntry) {
  const source = `${templateEntry?.wrapper || ''}\n${templateEntry?.row || ''}`;
  const classes = new Set();
  let m;
  while ((m = CLASS_ATTR_RE.exec(source))) {
    for (const token of m[1].split(/\s+/)) {
      if (token && !token.includes('{{')) classes.add(token);
    }
  }
  return [...classes];
}

const LINK_TAG_RE = /<link\b[^>]*>/gi;
export function extractStylesheetHrefs(html) {
  const hrefs = [];
  let m;
  while ((m = LINK_TAG_RE.exec(html))) {
    const tag = m[0];
    if (!/rel=["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const hrefMatch = /href=["']([^"']+)["']/i.exec(tag);
    if (hrefMatch) hrefs.push(hrefMatch[1]);
  }
  return hrefs;
}

// Tailwind escapes any character that isn't valid in a bare CSS identifier
// with a backslash when it generates the selector for a class whose name
// contains it (e.g. `md:text-2xl` -> `.md\:text-2xl`, `w-1/2` -> `.w-1\/2`,
// `mb-0.5` -> `.mb-0\.5`) — this mirrors that so the check looks for the
// selector Tailwind would ACTUALLY emit, not the raw class text.
const NEEDS_CSS_ESCAPE = /[:/.%[\](),]/g;
function escapeForCssSelector(cls) {
  return cls.replace(NEEDS_CSS_ESCAPE, '\\$&');
}

// Substring search for `.escaped-class` immediately followed by a character
// that only appears there in a real selector (`{` a plain rule, `:` a
// pseudo-class/variant like `:hover`, `,` a selector list, or whitespace
// before a descendant combinator) — deliberately not just "class exists
// anywhere in the file" (a class name could appear inside a comment or an
// unrelated string) or "class exists as its own complete rule" (variants
// nest the base selector inside `@media`/`:hover` wrappers in real Tailwind
// output, never as a bare top-level rule).
function classExistsInCss(cls, css) {
  const needle = `.${escapeForCssSelector(cls)}`;
  let idx = css.indexOf(needle);
  while (idx !== -1) {
    const after = css[idx + needle.length];
    if (after === '{' || after === ':' || after === ',' || after === ' ') return true;
    idx = css.indexOf(needle, idx + 1);
  }
  return false;
}

// Single source of truth for "is this stored template still real" — fetches
// the exact live page this draft is about to publish to (not some other
// reference page), so the check reflects the exact CSS that page will
// actually load, and checks every class the template claims to use against
// it. `ok: false` means the check itself couldn't run (network/infra) —
// callers should fail OPEN on that (proceed as before), the same "a real
// infra failure isn't a policy judgment call" discipline render-inspector.js
// already follows; only `ok: true, stale: true` is real evidence the
// template needs updating.
export async function checkTemplateFreshness({ pageUrl, templateEntry, fetchPage = fetchText, fetchStylesheet = fetchText }) {
  const classes = extractLiteralClassNames(templateEntry);
  if (!classes.length) return { ok: true, stale: false, missingClasses: [], checkedClasses: [] };

  const html = await fetchPage(pageUrl);
  if (!html) return { ok: false, error: `Could not fetch ${pageUrl} to check its current live design.` };

  const hrefs = extractStylesheetHrefs(html);
  if (!hrefs.length) return { ok: false, error: `No <link rel="stylesheet"> found on ${pageUrl} — cannot verify the current design.` };

  const cssParts = [];
  for (const href of hrefs) {
    const css = await fetchStylesheet(resolveUrl(pageUrl, href));
    if (css) cssParts.push(css);
  }
  if (!cssParts.length) return { ok: false, error: `Could not fetch any stylesheet linked from ${pageUrl}.` };

  const css = cssParts.join('\n');
  const missingClasses = classes.filter((cls) => !classExistsInCss(cls, css));
  return { ok: true, stale: missingClasses.length > 0, missingClasses, checkedClasses: classes };
}

// The same placeholder contract marker-merge.js's renderFaqHtml/
// renderLinksHtml/renderExpandedHtml already require of any componentTemplates
// entry — checked here too so a regenerated template can never silently drop
// a token the real splice depends on (that would fail loudly at apply time
// anyway via fillTemplate's plain string substitution leaving a literal
// "{{QUESTION}}" in the page, but catching it here is a clearer, earlier
// failure with an honest reason instead of shipping broken-looking content).
const REQUIRED_PLACEHOLDERS = {
  faq: { wrapper: ['{{ROWS}}'], row: ['{{QUESTION}}', '{{ANSWER}}'] },
  'expand-content': { wrapper: ['{{ROWS}}'], row: ['{{HEADING}}', '{{BODY}}'] },
  'internal-links': { wrapper: ['{{ROWS}}'], row: ['{{URL}}', '{{ANCHOR_TEXT}}'] },
  'qa-content': { wrapper: ['{{ROWS}}'], row: ['{{QUESTION}}', '{{ANSWER}}'] },
  // No `row` — a whole-page markdown body isn't a repeating list, it's one
  // {{BODY}} slot filled once. validatePlaceholders below treats a missing
  // `row` requirement as "nothing to check", not "row is required but empty".
  'content-wrapper': { wrapper: ['{{BODY}}'] },
};

export function validatePlaceholders(actionType, template) {
  const required = REQUIRED_PLACEHOLDERS[actionType];
  const missing = [
    ...required.wrapper.filter((p) => !template.wrapper?.includes(p)),
    ...(required.row || []).filter((p) => !template.row?.includes(p)),
  ];
  if (missing.length) {
    return { ok: false, error: `Proposed template is missing required placeholder(s): ${missing.join(', ')}.` };
  }
  return { ok: true };
}

// Whether actionType's componentTemplate shape has a `row` at all — only
// 'content-wrapper' doesn't (see REQUIRED_PLACEHOLDERS above). A caller
// that needs to know whether a given action type's template is the
// repeating-row shape (faq/expand-content/internal-links/qa-content) or the
// single-slot shape (content-wrapper) uses this instead of assuming.
export function templateActionRequiresRow(actionType) {
  return (REQUIRED_PLACEHOLDERS[actionType]?.row || []).length > 0;
}

// ---------------------------------------------------------------------------
// Template provenance — "who verified this template, and against what?"
// ---------------------------------------------------------------------------
// componentTemplates used to carry no provenance at all: a hand-captured
// snapshot and a real-repo-grounded Design Agent derivation were byte-identical
// in storage, so nothing downstream could tell a verified template from a
// guess someone pasted in months ago. That ambiguity is what let unverified
// templates reach apply time and fail there (the "looks bigger/different than
// the rest of the site" class of failure this module already existed to catch,
// plus a large share of the observed apply-failure rate).
//
// The stamp lives INSIDE the template object rather than in a parallel table
// or column: every existing reader (marker-merge.js's fillTemplate,
// newpage-render.js, extractLiteralClassNames, validatePlaceholders) reads
// only `.wrapper`/`.row`, so extra keys are inert to all of them and no
// migration or backfill is required. An UNSTAMPED template is treated as
// unverified, which is the correct reading of every template stored before
// this existed — none of them were ever checked against a live page.
//
// Deliberately only two, both grounded/deterministic — there is no HUMAN
// entry. A staff member's opinion that a template "looks right" is not
// evidence it will render correctly; only a real repo checkout (DESIGN_AGENT)
// or a real live-CSS check (FRESHNESS_CHECK) is. The autonomous pipeline
// (resolveOrCreateComponentTemplate below, and the verify-component-templates
// script) is the only path that can produce a verified template.
export const TEMPLATE_VERIFIED_BY = {
  DESIGN_AGENT: 'design-agent', // derived from the site's real repo by OpenHands
  FRESHNESS_CHECK: 'freshness-check', // every claimed class proven live against the real site
};

// Attaches provenance without mutating the caller's object. `ref` is whatever
// identifies the evidence — a design_generate job id, a user id, or the page
// URL a freshness check ran against — so a later "why is this trusted?" has a
// real answer instead of a bare boolean.
export function stampTemplateVerification(template, { verifiedBy, verifiedRef = null, at = new Date() } = {}) {
  if (!template) return template;
  return { ...template, verifiedAt: at.toISOString(), verifiedBy, verifiedRef: verifiedRef == null ? null : String(verifiedRef) };
}

// The single predicate the gate asks. Deliberately structural-only (is there a
// stamp, and does the template still satisfy its placeholder contract) — it
// makes NO network call, so it is safe to call on the hot path in
// generateDraft and inside the per-item loop in buildRecommendations. Live-CSS
// freshness is the separate, expensive checkTemplateFreshness above, used by
// server/scripts/verify-component-templates.js.
export function isTemplateVerified(actionType, template) {
  if (!template?.wrapper) return { ok: false, reason: 'missing', detail: 'No component template is configured for this site yet.' };
  if (!template.verifiedAt || !template.verifiedBy) {
    return { ok: false, reason: 'unverified', detail: 'This site\'s component template has never been verified against the real site design.' };
  }
  const placeholders = validatePlaceholders(actionType, template);
  if (!placeholders.ok) return { ok: false, reason: 'invalid-placeholders', detail: placeholders.error };
  return { ok: true, verifiedAt: template.verifiedAt, verifiedBy: template.verifiedBy };
}

// generatorId -> the componentTemplates action type it renders through. Every
// net-new whole-page generator (frontend.js's FRONTEND_ACTION_TYPES: the three
// compliance pages, landing-page, blog-outline, direct-answer, translation)
// shares the single generic 'content-wrapper' key rather than each having its
// own — they all render the same shape, one markdown body dropped into one
// {{BODY}} slot (newpage-render.js). Every other generator maps to itself.
//
// This used to be COMPLIANCE_ACTION_TYPES only, which meant the other four
// net-new page types had no component-template concept at all: both gates saw
// 'no-concept', returned ok, and waved them straight through — while
// newpage-render.js emitted their bodies with no site wrapper, i.e. bare
// unstyled <h1>/<h2>/<p> into a real PR. That is the exact failure already
// confirmed live on zunkireelabs-web's /terms/, /privacy/ and /cookies/ before
// contentWrapper was captured for it; the compliance trio was fixed then and
// these four were left behind.
//
// Lives here, next to COMPONENT_TEMPLATE_KEY, so the draft-generation gate
// (routes/action-center.js) and the recommendation gate
// (agents/lib/recommendations.js) cannot drift apart on which action type a
// generator is actually checked against.
export function componentTemplateActionTypeFor(generatorId) {
  return FRONTEND_ACTION_TYPES.has(generatorId) ? 'content-wrapper' : generatorId;
}

// Convenience read used by both gates: resolves the stored template for a
// site+actionType and returns its verification verdict in one step. Pure read
// of the already-loaded `site` row — no DB or network access.
export function componentTemplateVerification(site, actionType) {
  const componentKey = COMPONENT_TEMPLATE_KEY[actionType];
  if (!componentKey) return { ok: true, reason: 'no-concept', componentKey: null };
  const template = site?.url_file_map?.siteRoot?.componentTemplates?.[componentKey];
  return { ...isTemplateVerified(actionType, template), componentKey, actionType };
}

// LEARN side of the loop this module's RETRIEVE half
// (openhands-handler.js's createComponentTemplateHandler) already reads
// from. Single source of truth for what a rejected-template lesson looks
// like — called from resolveOrCreateComponentTemplate below, the sole
// path (autonomous, no human step) that can produce a componentTemplate in
// production, so there is exactly one write path into agent_fix_memory for
// a Design Agent placeholder rejection, not a fork between an autonomous
// path and a separate staff-triggered one.
//
// validatePlaceholders is a deterministic, ground-truth check (a plain
// string-contains test, not an LLM judgment call), so a rejection clears
// the same "genuinely validated" bar every other recordFixOutcome call site
// in this codebase requires — same shape action-center.js uses to record a
// Quality Gate hit. Never lets a memory-write failure block the caller —
// same fail-open discipline as everywhere else this table is touched.
export function recordRejectedTemplateLesson({ siteId, actionType, error, recordFixOutcomeFn = recordFixOutcome }) {
  return recordFixOutcomeFn({
    category: 'content', scope: 'client', siteId, generatorId: DESIGN_AGENT_GENERATOR_ID,
    validationRuleId: `missing-placeholders:${actionType}`, outcome: 'success', sourceType: 'runtime-auto',
    problemSignature: `missing-placeholders:${actionType}`,
    symptoms: `Design Agent derived a "${actionType}" component template missing a required placeholder token.`,
    rootCause: error,
    affectedPattern: `Design Agent component-templates output for action type "${actionType}".`,
    fixStrategy: `Every placeholder token required for "${actionType}" must appear verbatim in the derived template — ${error}`,
  }).catch((err) => console.error(`[design-drift] failed to record rejected-template memory for ${actionType}:`, err.message));
}

// The site's own real homepage URL — the page a freshness check runs against
// when no more specific one is known. website_domain is the configured value;
// gsc_property is the fallback for a site connected via Search Console only
// (its `sc-domain:` prefix is not part of the URL). Returns null when neither
// is set, which every caller treats as "cannot check against a live page."
export function sitePageUrl(site) {
  const domain = site?.website_domain || site?.gsc_property?.replace(/^sc-domain:/, '');
  if (!domain) return null;
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

// A synthetic req-like shape for recordAuditEvent — this resolver runs
// during draft GENERATION (generateDraft, called from the manual UI route,
// the MCP tool, and the unattended execution engine alike), never from one
// specific staff HTTP request, so there's no real req to pass through.
// req.userId left null resolves to audit-log.js's own 'system' actor type,
// which is exactly the right attribution for a template a human never
// clicked to create.
function systemActorReq(siteId) {
  return { userId: null, siteId, ip: null, get: () => null };
}

// The ONE place a Design-Agent-derived template becomes a saved, verified
// template on a site — validate, stamp, persist, audit. Extracted out of
// resolveOrCreateComponentTemplate below because there are two ways a
// derivation can arrive and they must produce byte-identical stored state:
//
//   1. INLINE — resolveOrCreateComponentTemplate ran the OpenHands session
//      itself (first-time derivation, no template to fall back on).
//   2. QUEUED — the design-agent worker ran it off the execution_jobs queue
//      (worker.js's processOneJob), which is the repair path for an existing
//      but unverified template.
//
// Path 2 had NO consumer at all before this: the worker wrote the derived
// templates onto execution_jobs.result and stopped, and every reader of that
// column (component-template-proposal.js and the /design-jobs + /confirm
// staff routes) was deleted by f7156ef along with the human-confirm workflow.
// So a queued re-derivation ran, succeeded, and its output was discarded —
// the template stayed unstamped, the gate kept rejecting it, and the next
// attempt queued another job to throw away. That is why the four templates on
// the only repo-connected site never healed.
//
// Takes the whole `componentTemplates` map the handler returned (keyed by
// ACTION TYPE, e.g. 'faq' / 'expand-content') rather than one entry, because a
// single job can be asked for several keys at once — one config write for all
// of them, not one per key.
export async function persistDerivedComponentTemplates(site, componentTemplates, {
  jobId = null,
  saveConfig = updateSiteRepoConfig,
  recordAudit = recordAuditEvent,
  recordFixOutcomeFn = recordFixOutcome,
} = {}) {
  const accepted = [];
  const rejected = [];

  for (const [actionType, derived] of Object.entries(componentTemplates || {})) {
    const componentKey = COMPONENT_TEMPLATE_KEY[actionType];
    if (!componentKey) { rejected.push({ actionType, reason: 'no-concept' }); continue; }
    if (!derived?.wrapper) { rejected.push({ actionType, reason: 'not-derived' }); continue; }

    const check = validatePlaceholders(actionType, derived);
    if (!check.ok) {
      recordRejectedTemplateLesson({ siteId: site.id, actionType, error: check.error, recordFixOutcomeFn });
      rejected.push({ actionType, reason: 'invalid-placeholders', error: check.error });
      continue;
    }

    // Stamped verified-by-design-agent at the moment of derivation: this
    // template was just read out of the site's REAL repo by an OpenHands
    // session (openhands-handler.js), which is exactly the grounding the gate
    // in generateDraft is asking for. `jobId` is the evidence trail — null for
    // the inline (non-job) path, which is fine; the stamp's value is
    // `verifiedBy`, and `verifiedRef` is supporting detail.
    accepted.push({
      actionType,
      componentKey,
      template: stampTemplateVerification(derived, {
        verifiedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT,
        verifiedRef: jobId,
      }),
    });
  }

  if (!accepted.length) return { ok: false, saved: {}, rejected };

  const urlFileMap = {
    ...site.url_file_map,
    siteRoot: {
      ...site.url_file_map?.siteRoot,
      componentTemplates: {
        ...site.url_file_map?.siteRoot?.componentTemplates,
        ...Object.fromEntries(accepted.map((a) => [a.componentKey, a.template])),
      },
    },
  };
  await saveConfig({ siteId: site.id, urlFileMap });

  for (const { actionType, componentKey } of accepted) {
    await recordAudit(systemActorReq(site.id), {
      action: 'tenant.component_template_auto_created',
      targetType: 'site',
      targetId: String(site.id),
      tenantSiteId: site.id,
      tenantName: site.name,
      metadata: { actionType, componentKey, source: 'design-agent-auto', verifiedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT, jobId },
      success: true,
    });
  }

  return {
    ok: true,
    saved: Object.fromEntries(accepted.map((a) => [a.actionType, a.template])),
    rejected,
  };
}

// The find-or-create entry point every draft-generation/apply call site
// should use instead of reading site.url_file_map.siteRoot.componentTemplates
// directly: returns the site's real template if one is already configured
// (the fast path — true for every recommendation after the first, on any
// given site+actionType), or derives one from the site's real repo via the
// Design Agent and saves it — with no staff button, manual "seed" step, or
// human confirmation of any kind. This is the ONLY path that creates or
// verifies a componentTemplate in production; there is no separate
// staff-triggered inspection UI to keep in sync with it.
//
// Never throws and never blocks the caller on a Design Agent failure —
// `ok: false` (site.design_agent_enabled off, no repo configured, the
// OpenHands session itself failing, or an invalid derived template) means
// "nothing to use," and every caller of this function already has its own
// safe, zero-config fallback (marker-merge.js's DEFAULT_* templates,
// newpage-render.js's plain-markdown output) for exactly this case — a
// site that hasn't opted into (or can't currently reach) the Design Agent
// keeps working exactly as it did before this function existed.
export async function resolveOrCreateComponentTemplate(site, actionType, {
  createHandler = createComponentTemplateHandler,
  saveConfig = updateSiteRepoConfig,
  recordAudit = recordAuditEvent,
  recordFixOutcomeFn = recordFixOutcome,
  enqueueDerivation = createComponentTemplateJob,
  findQueuedDerivation = getQueuedComponentTemplateJob,
} = {}) {
  const componentKey = COMPONENT_TEMPLATE_KEY[actionType];
  if (!componentKey) return { ok: false, reason: 'no-concept', template: null, componentKey: null };

  const existing = site.url_file_map?.siteRoot?.componentTemplates?.[componentKey];

  // The fast path now requires the template to be VERIFIED, not merely to
  // exist. That distinction is the whole bug this branch shipped with: an
  // existing-but-unstamped template returned ok:true here, which meant the
  // Design Agent was never invoked to re-derive it — and only a fresh
  // derivation stamps verifiedBy. The generateDraft gate directly downstream
  // then rejected that same template with a 422, permanently, with no
  // autonomous way out. Confirmed live: all four templates on the only
  // repo-connected site were in exactly this state, blocking every faq /
  // qa-content / expand-content / internal-links draft, escapable only by
  // running `npm run verify-component-templates` by hand — precisely the
  // human-confirmation dependency f7156ef set out to remove.
  if (existing && isTemplateVerified(actionType, existing).ok) {
    return { ok: true, template: existing, source: 'existing', componentKey };
  }

  if (!site.design_agent_enabled || !site.repo_owner || !site.repo_name) {
    return { ok: false, reason: 'not-available', template: null, componentKey };
  }

  // An unverified template is a REPAIR, not a first-time derivation, and the
  // difference matters operationally: there is already a usable-looking
  // template on the row, so nothing is newly broken by taking a moment to
  // redo it properly. Queue it on the existing design-agent worker rather
  // than running an OpenHands Docker session inline — this function sits on
  // generateDraft's hot path, which every manual click, MCP call and
  // unattended attempt funnels through, and a container session there can
  // outlast the request that started it.
  //
  // First-time derivation (no `existing` at all) deliberately stays inline
  // below: there is no template to fall back on, so blocking once is the
  // only way that call can produce anything at all, and that path is already
  // proven.
  if (existing) {
    // Keyed by actionType, matching what createComponentTemplateJob stores.
    const queued = await findQueuedDerivation(site.id, actionType).catch(() => null);
    // Enqueue at most one outstanding job per site+key. Without this, every
    // draft attempt on a blocked site would add another job for work already
    // pending — the daily run alone would queue dozens.
    if (!queued) {
      // pageUrl rides along so the derived result can be checked against the
      // site's real live CSS (checkTemplateFreshness) — createComponentTemplateJob
      // has always accepted it and every caller was dropping it.
      await enqueueDerivation(site.id, [actionType], { requestedBy: null, pageUrl: sitePageUrl(site) }).catch((err) => {
        console.error(`[design-drift] could not queue re-derivation for site ${site.id}/${actionType}:`, err.message);
      });
    }
    return {
      ok: false,
      reason: 'derivation-queued',
      detail: 'This site\'s component template has not been verified against the real site design yet. The Design Agent has been queued to re-derive it — this will resolve on its own shortly.',
      template: null,
      componentKey,
    };
  }

  let result;
  try {
    const handler = createHandler();
    result = await handler({ id: null, site_id: site.id, params: { componentKeys: [actionType] } });
  } catch (err) {
    const { message } = safeMessage('design-drift.resolveOrCreateComponentTemplate', err, 'Design Agent could not derive a template right now.');
    return { ok: false, reason: 'design-agent-error', error: message, template: null, componentKey };
  }

  // Same validate -> stamp -> save -> audit the queued worker path runs, so
  // an inline derivation and a queued re-derivation can never leave the site
  // row in two different shapes.
  const persisted = await persistDerivedComponentTemplates(site, result?.componentTemplates, {
    jobId: result?.jobId ?? null, saveConfig, recordAudit, recordFixOutcomeFn,
  });
  const stamped = persisted.saved?.[actionType];
  if (!stamped) {
    // This call asked for exactly one action type, so any rejection reported
    // is this one's — surfaced verbatim rather than flattened to a generic
    // failure, since 'not-derived' and 'invalid-placeholders' mean different
    // things to the caller.
    const failure = persisted.rejected.find((r) => r.actionType === actionType);
    return {
      ok: false,
      reason: failure?.reason || 'not-derived',
      error: failure?.error,
      template: null,
      componentKey,
    };
  }

  return { ok: true, template: stamped, source: 'design-agent', justCreated: true, componentKey };
}
