// Generic pre-PR SECTION PRESERVATION gate — CLAUDE.md §2 ("PRESERVE EVERY
// EXISTING SECTION") enforced in code rather than trusted to each generator.
//
// Runs in the one choke point every implementer's apply() already shares
// (github-ops.js's pushDraftBranch, alongside the Rendering Validation Gate),
// so every current and future generator inherits it with no per-generator
// code, for every tenant. That placement is the whole point: the failure this
// prevents is not specific to one generator, one action type or one site —
// any path that rewrites a real page file can drop a section that was there
// before, and the only reliable place to notice is the moment the new file
// content is about to be committed, with the old content still fetchable.
//
// WHAT IT ASKS: "did this edit make any structural landmark that existed on
// the base branch disappear?" Not "is the new markup good" (that is the
// Quality Gate's job, upstream) and not "does it match the site's design"
// (design-drift.js's). Only: was something the client already had taken away.
//
// Deliberately framework-agnostic — it must hold for Nunjucks, Astro, Next,
// Hugo, Eleventy, plain HTML and whatever a future client uses, so it reads
// only signals that survive every one of them, and never parses a template
// language it would have to understand to be correct about.
//
// NOT A DESIGN CHECK AND NOT A DIFF REVIEW: an edit may add anything it
// likes, rewrite prose freely, restyle, and reorder within a marker. Only
// DISAPPEARANCE fails, because only disappearance is unambiguously a loss
// regardless of what the draft was trying to do.

import { getFileContent } from '../../github/client.js';

// Real structural containers. A page's sections, its chrome, and its forms —
// the things a reader would name if asked "what's on this page". Counted
// rather than identified, because identity across a rewrite is not reliably
// knowable (attributes and classes legitimately change) while COUNT loss is
// unambiguous: four <section> elements before and three after means one is
// gone, whatever else changed.
const STRUCTURAL_TAGS = ['section', 'header', 'footer', 'nav', 'main', 'article', 'aside', 'form', 'table'];

// Template composition directives across the engines this platform actually
// meets. A dropped `{% include "components/cta.njk" %}` removes a whole
// section just as surely as deleting its markup inline, and is invisible to
// any tag count — the markup it pulls in never appears in this file at all.
const INCLUDE_PATTERNS = [
  { kind: 'nunjucks/liquid include', re: /\{%-?\s*(?:include|render)\s/g },
  { kind: 'nunjucks/liquid block', re: /\{%-?\s*block\s/g },
  { kind: 'handlebars partial', re: /\{\{>\s*[\w./-]+/g },
  { kind: 'astro/jsx component', re: /<[A-Z][A-Za-z0-9_]*[\s/>]/g },
  { kind: 'php/other include', re: /\b(?:include|require)(?:_once)?\s*\(/g },
];

// `id="..."` anchors are the one landmark with a stable IDENTITY, not just a
// count: they are how the rest of the site links INTO a section (#pricing,
// #faq), so losing one silently breaks real navigation and any external link
// or anchor citation pointing at it. Quoted forms only — a dynamic
// `id={expr}` is not a knowable name and is deliberately not tracked.
const ID_ATTR_RE = /\bid=["']([^"']+)["']/g;

// Content inside an HTML comment is not live page structure — a commented-out
// section is already not rendering, so "removing" it removes nothing a
// visitor could see, and counting it would make tidying up dead markup look
// like deleting a section. Stripped from both sides identically, so the
// comparison stays symmetric.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

export function extractStructuralLandmarks(content) {
  const text = String(content || '').replace(HTML_COMMENT_RE, '');

  const tags = {};
  for (const tag of STRUCTURAL_TAGS) {
    const matches = text.match(new RegExp(`<${tag}\\b`, 'gi'));
    tags[tag] = matches ? matches.length : 0;
  }

  const includes = {};
  for (const { kind, re } of INCLUDE_PATTERNS) {
    re.lastIndex = 0;
    const matches = text.match(re);
    includes[kind] = matches ? matches.length : 0;
  }

  const ids = new Set();
  ID_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ID_ATTR_RE.exec(text))) ids.add(m[1]);

  return { tags, includes, ids };
}

// The losses, named specifically enough that the failure message tells a
// human WHAT went missing rather than that "something" did.
export function findRemovedSections(beforeContent, afterContent) {
  const before = extractStructuralLandmarks(beforeContent);
  const after = extractStructuralLandmarks(afterContent);
  const losses = [];

  for (const tag of STRUCTURAL_TAGS) {
    if (after.tags[tag] < before.tags[tag]) {
      losses.push(`${before.tags[tag] - after.tags[tag]} <${tag}> element(s) removed (${before.tags[tag]} → ${after.tags[tag]})`);
    }
  }

  for (const { kind } of INCLUDE_PATTERNS) {
    if (after.includes[kind] < before.includes[kind]) {
      losses.push(`${before.includes[kind] - after.includes[kind]} ${kind}(s) removed (${before.includes[kind]} → ${after.includes[kind]})`);
    }
  }

  const removedIds = [...before.ids].filter((id) => !after.ids.has(id));
  if (removedIds.length) {
    losses.push(`anchor id(s) removed: ${removedIds.slice(0, 5).map((id) => `#${id}`).join(', ')}${removedIds.length > 5 ? ` and ${removedIds.length - 5} more` : ''}`);
  }

  return losses;
}

// Action types whose PURPOSE includes removing markup — CLAUDE.md §2's own
// "unless the task explicitly requires removal" carve-out, kept as an
// explicit, reviewable list rather than inferred, so adding a new removing
// generator is a deliberate decision someone makes rather than a silent
// consequence of how it happens to be named.
//
// content-integrity-repair is the big one: its malformed-table fixType
// replaces broken markup with '' and its duplicate-faq fixType removes a
// confirmed-duplicate visible FAQ section — both are the repair working
// correctly (see visible_faq_cap enforcement), and both would trip every
// rule above.
export const REMOVAL_PERMITTED_ACTION_TYPES = new Set([
  'content-integrity-repair',
  'sitemap-removal',
  'broken-link-fix',
  'duplicate-id-fix',
  'redirect-fix',
  'redirect-chain-nginx',
  'soft-404-nginx',
]);

/**
 * @returns {{ok: true}} | {{ok: false, reason: 'section-removed', error: string, losses: Array}}
 *
 * Fails OPEN on its own plumbing (a file it cannot read on the base branch),
 * the same contract checkTemplateFreshness documents and findSyncCorruption
 * follows: an unreadable base is "we learned nothing", never "the draft
 * deleted a section". A brand-new file has no before-state and nothing to
 * preserve, which is the common case for every net-new page generator.
 *
 * `ref` is passed in by the caller (github-ops.js's own baseBranch(site))
 * rather than imported from there — this module is imported BY github-ops.js,
 * and importing back would make a cycle for one trivial expression.
 */
export async function validateSectionPreservation(site, draft, files, { fetchFile = getFileContent, ref = null } = {}) {
  if (REMOVAL_PERMITTED_ACTION_TYPES.has(draft?.action_type)) return { ok: true };

  const baseRef = ref || site?.repo_default_branch || 'main';

  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- fail on the first real loss, in file order, same as validateRenderingBatch
    const existing = await fetchFile(site, file.path, baseRef).catch(() => null);
    if (!existing?.content) continue; // net-new file, or unreadable: nothing provably lost

    const losses = findRemovedSections(existing.content, file.content);
    if (losses.length) {
      return {
        ok: false,
        reason: 'section-removed',
        error: `This change would remove existing structure from ${file.path} that is live on the site today: `
          + `${losses.join('; ')}. An SEO/content change must add to or update a page, never take away a section the `
          + `client already has (CLAUDE.md §2). The draft was not applied.`,
        losses,
        path: file.path,
      };
    }
  }

  return { ok: true };
}
