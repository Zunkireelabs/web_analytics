// Derives the two pieces of url_file_map that onboarding previously left for
// a human to hand-author, and that nothing ever actually authored:
// `renderCapabilities` and `newContentTargets`.
//
// Why this is derivation and not guessing. Both are consumed by fail-closed
// code (implementers/lib/rendering-gate.js refuses to commit a file it cannot
// positively vouch for; implementers/frontend.js refuses to create a page with
// no recorded target), so a wrong entry does not silently ship bad output --
// it either blocks or is caught. The rule here is nonetheless the same one
// discovery/auto-configure.js follows: write ONLY what the repository's own
// contents prove, and surface everything else as a named gap rather than a
// default.
//
// Live evidence for why this matters: on 2026-09-09, 248 abandoned drafts and
// 17 open blocked recommendations across the two production tenants traced to
// a missing newContentTargets entry for landing-page, translation,
// cookie-policy, terms-of-service or missing-page-create -- the single largest
// cause of blocked autonomous work.

import { extname } from 'node:path';
import { updateSiteRepoConfig } from '../db.js';

// Frameworks whose documented, default behaviour is to render Markdown page
// files to HTML. This is the claim renderCapabilities exists to record, and
// for these generators it is a property of the framework itself, not of the
// individual repo's config -- which is exactly what makes it derivable.
// Anything not listed here stays markdown:false (fail closed).
const MARKDOWN_NATIVE_FRAMEWORKS = new Set([
  'eleventy', 'astro', 'jekyll', 'hugo', 'gatsby', 'nuxt', 'docusaurus',
]);

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

// The 8 net-new page types (implementers/frontend.js meta.handles). Each needs
// a directory + extension to create a file in.
const NET_NEW_TYPES = [
  'landing-page', 'blog-outline', 'direct-answer', 'translation',
  'cookie-policy', 'privacy-policy', 'terms-of-service', 'missing-page-create',
];

// Directory-name conventions strong enough to bind a specific type to a
// specific directory. Everything else falls back to the general page target.
const DIRECTORY_ROLES = [
  { type: 'blog-outline', re: /^(blog|posts|_posts|articles|news|insights|stories)$/i },
  { type: 'direct-answer', re: /^(answers|faq|faqs|questions|help)$/i },
];

function markdownPageDirectories(pageTypes) {
  return pageTypes
    .filter((pt) => pt.directory && pt.directory !== '(root)')
    .map((pt) => ({
      directory: pt.directory,
      // The extension the directory actually uses for its pages. Only a
      // directory that is consistently Markdown is a usable target -- a mixed
      // directory tells us nothing about where a new file should go.
      extension: (pt.extensions || []).find((e) => MARKDOWN_EXTENSIONS.has(e)) || null,
      onlyMarkdown: (pt.extensions || []).length > 0 && (pt.extensions || []).every((e) => MARKDOWN_EXTENSIONS.has(e)),
      fileCount: pt.fileCount || 0,
      name: pt.name || '',
    }))
    .filter((d) => d.extension && d.onlyMarkdown)
    .sort((a, b) => b.fileCount - a.fileCount);
}

// `framework` is detectTechnology()'s `tech.framework` ({id, name, ...}) or
// null; `pageTypes` is discoverPageStructure()'s pageTypes array.
export function deriveRenderCapabilities({ framework, pageTypes = [], existing = null } = {}) {
  const observed = new Set();
  for (const pt of pageTypes) for (const ext of pt.extensions || []) if (ext) observed.add(ext);

  const frameworkId = framework?.id || null;
  const markdownNative = frameworkId ? MARKDOWN_NATIVE_FRAMEWORKS.has(frameworkId) : false;

  // A Markdown extension only counts as proven when the framework is one that
  // renders Markdown AND this repo actually publishes pages with that
  // extension. Either alone is not evidence: a stray README.md proves nothing
  // about rendering, and a Markdown-native framework with no Markdown pages
  // gives us no directory to target anyway.
  const extensions = {};
  const derivedFrom = [];
  for (const ext of [...observed].sort()) {
    const isMarkdown = MARKDOWN_EXTENSIONS.has(ext) && markdownNative;
    extensions[ext] = { markdown: isMarkdown };
    if (isMarkdown) {
      derivedFrom.push(`${ext}: ${framework.name || frameworkId} renders Markdown pages by default, and this repo publishes ${ext} page files`);
    }
  }

  const unproven = [...observed].filter((e) => MARKDOWN_EXTENSIONS.has(e) && !markdownNative);

  // Never widen an entry a human already recorded -- their entry may encode a
  // per-repo template-engine override this cannot see (e.g. Eleventy's
  // templateEngineOverride: "njk,md"). Existing keys always win.
  const merged = { ...(existing?.extensions || {}) };
  for (const [ext, value] of Object.entries(extensions)) {
    if (!(ext in merged)) merged[ext] = value;
  }

  return {
    renderCapabilities: {
      ...(existing || {}),
      generator: existing?.generator || frameworkId || 'unknown',
      extensions: merged,
      ...(existing?.overrides ? { overrides: existing.overrides } : {}),
      derivedAt: new Date().toISOString(),
      derivedFrom,
    },
    // Reported, never silently swallowed.
    gaps: unproven.length
      ? [`${unproven.join(', ')} page file(s) exist but ${frameworkId || 'this framework'} is not known to render Markdown — recorded as not Markdown-safe. If this repo does run a Markdown pass on them, record a renderCapabilities override by hand.`]
      : [],
    markdownProven: Object.values(merged).some((v) => v.markdown === true),
  };
}

// Picks a directory per net-new type, using only directories that are
// provably, consistently Markdown page directories in this repo.
export function deriveNewContentTargets({ pageTypes = [], renderCapabilities = null, existing = null } = {}) {
  const dirs = markdownPageDirectories(pageTypes);
  const targets = { ...(existing || {}) };
  const derived = [];
  const gaps = [];

  const markdownSafe = (ext) => renderCapabilities?.extensions?.[ext]?.markdown === true;

  const usable = dirs.filter((d) => markdownSafe(d.extension));
  if (!usable.length) {
    return {
      newContentTargets: targets,
      derived,
      gaps: [
        'No directory in this repo is a proven Markdown page directory, so no new-page target could be derived. ' +
        'Net-new page generators (landing-page, blog-outline, direct-answer, translation, the three compliance pages, missing-page-create) ' +
        'stay blocked until a target is recorded by hand via `npm run connect-repo --url-file-map`.',
      ],
    };
  }

  // The general-purpose target: the largest proven Markdown page directory
  // that is not claimed by a specific role below.
  const roleClaimed = new Map();
  for (const role of DIRECTORY_ROLES) {
    const match = usable.find((d) => role.re.test(d.name));
    if (match) roleClaimed.set(role.type, match);
  }
  const claimedDirs = new Set([...roleClaimed.values()].map((d) => d.directory));
  const general = usable.find((d) => !claimedDirs.has(d.directory)) || usable[0];

  for (const type of NET_NEW_TYPES) {
    if (targets[type]) continue; // never overwrite a recorded target
    const chosen = roleClaimed.get(type) || general;
    if (!chosen) continue;
    targets[type] = { dir: chosen.directory, extension: chosen.extension };
    derived.push({
      type,
      dir: chosen.directory,
      extension: chosen.extension,
      reason: roleClaimed.get(type)
        ? `directory named "${chosen.name}" matches this page type, and holds ${chosen.fileCount} Markdown page(s)`
        : `largest proven Markdown page directory (${chosen.fileCount} page(s))`,
    });
  }

  return { newContentTargets: targets, derived, gaps };
}

// One call for both, given a completed runDiscovery() result. Returns the
// url_file_map patch to persist plus everything that could not be derived.
export function deriveContentConfig({ technology, structure, existingUrlFileMap = {} } = {}) {
  const pageTypes = structure?.pageTypes || [];

  const render = deriveRenderCapabilities({
    framework: technology?.framework || null,
    pageTypes,
    existing: existingUrlFileMap.renderCapabilities || null,
  });

  const targets = deriveNewContentTargets({
    pageTypes,
    renderCapabilities: render.renderCapabilities,
    existing: existingUrlFileMap.newContentTargets || null,
  });

  const patch = {};
  if (Object.keys(render.renderCapabilities.extensions).length) patch.renderCapabilities = render.renderCapabilities;
  if (Object.keys(targets.newContentTargets).length) patch.newContentTargets = targets.newContentTargets;

  return {
    patch,
    derivedTargets: targets.derived,
    markdownProven: render.markdownProven,
    gaps: [...render.gaps, ...targets.gaps],
  };
}

// Merges the derived config into the site's existing url_file_map and saves
// it. Merge, never replace: discovery/auto-configure.js has already written
// pages/patterns into this same column by the time this runs, and siteRoot
// carries the Design Agent's profile.
export async function persistDerivedContentConfig(site, discovery, { saveConfig = updateSiteRepoConfig } = {}) {
  const existingUrlFileMap = site.url_file_map || {};
  const result = deriveContentConfig({
    technology: discovery?.technology,
    structure: discovery?.structure,
    existingUrlFileMap,
  });

  if (!Object.keys(result.patch).length) return { ...result, applied: false, site };

  const merged = { ...existingUrlFileMap, ...result.patch };
  const updated = await saveConfig({ siteId: site.id, urlFileMap: merged });
  return { ...result, applied: true, site: updated };
}

export const __testables = { MARKDOWN_NATIVE_FRAMEWORKS, NET_NEW_TYPES, markdownPageDirectories, extnameOf: extname };
