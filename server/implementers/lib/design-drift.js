import { callLLM } from '../../llm.js';
import { safeMessage } from '../../lib/errors.js';

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
// component to drift, and net-new content (blog-outline/landing-page/
// translation, frontend.js) is placed straight into the site's own live
// layout template rather than a stored markup snapshot, so it's always
// current by construction. qa-content is deliberately excluded even though
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
};

async function fetchText(url) {
  try {
    const res = await fetch(url);
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
const CLASS_ATTR_RE = /\bclass="([^"]*)"/g;
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
};

export function validatePlaceholders(actionType, template) {
  const required = REQUIRED_PLACEHOLDERS[actionType];
  const missing = [
    ...required.wrapper.filter((p) => !template.wrapper?.includes(p)),
    ...required.row.filter((p) => !template.row?.includes(p)),
  ];
  if (missing.length) {
    return { ok: false, error: `Proposed template is missing required placeholder(s): ${missing.join(', ')}.` };
  }
  return { ok: true };
}

// Derives a replacement template from the site's CURRENT real page HTML,
// grounded the same way faq.js/expand-content.js ground their own content:
// never invent a class that isn't actually visible in the real fetched
// markup. This is a PROPOSAL only — callers must get human approval before
// saving it into site.url_file_map.siteRoot.componentTemplates, since a bad
// extraction (wrong element mistaken for "the real component") would
// otherwise roll out to every future draft of this action type sitewide.
export async function proposeUpdatedTemplate({ pageUrl, actionType, oldTemplate, missingClasses, fetchPage = fetchText, callLLMFn = callLLM }) {
  const required = REQUIRED_PLACEHOLDERS[actionType];
  if (!required) return { ok: false, error: `No known template shape for action type "${actionType}".` };

  const html = await fetchPage(pageUrl);
  if (!html) return { ok: false, error: `Could not fetch ${pageUrl} to derive an updated template from its current real design.` };

  const system = 'You are a front-end engineer. A previously-configured HTML component template for this site no ' +
    'longer matches its real, live design — the CSS classes it uses are no longer defined on the site (the design ' +
    'changed since the template was captured). Given the site\'s CURRENT real page HTML, derive an UPDATED template ' +
    'with the exact same structure and placeholder tokens as the old one, but using ONLY real classes/patterns you ' +
    'can actually see used elsewhere in the given live HTML — never invent a class name that doesn\'t appear ' +
    'anywhere in the page. Keep the placeholder tokens verbatim (e.g. {{ROWS}}, {{QUESTION}}) — only the ' +
    'surrounding real markup/classes should change. Respond with ONLY JSON: {"wrapper": "...", "row": "..."}.';
  const user = `Action type: ${actionType}\nOld template (now stale — classes no longer defined: ` +
    `${(missingClasses || []).join(', ') || 'unknown'}):\n${JSON.stringify(oldTemplate)}\n\n` +
    `Current live page HTML (excerpt):\n${html.slice(0, 6000)}`;

  let parsed;
  try {
    const raw = await callLLMFn(system, user, { maxTokens: 1200 });
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (err) {
    const { message } = safeMessage('design-drift.deriveUpdatedTemplate', err, 'Could not derive an updated template right now — try again shortly.');
    return { ok: false, error: message };
  }
  if (!parsed?.wrapper || !parsed?.row) {
    return { ok: false, error: 'Model did not return a valid {wrapper, row} template.' };
  }

  const validated = validatePlaceholders(actionType, parsed);
  if (!validated.ok) return validated;

  return { ok: true, template: { wrapper: parsed.wrapper, row: parsed.row } };
}
