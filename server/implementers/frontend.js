import { resolveConvertedBlogPost } from './lib/converted-blog-resolve.js';
import { resolveFile, resolveNewContentTarget, resolveNewContentTargetConfig, resolveNewContentUrl, resolveNewContentLayout, resolveTranslationTarget, resolveMissingPageTarget, slugifyTitle } from './lib/url-file-map.js';
import { deriveNewContentContract, deriveContractFromSourceFile, missingRequiredKeys, findBetterBlogDirectory } from './lib/newcontent-contract.js';
import { deriveLegalTarget, isPlaceholderDir } from './lib/legal-target.js';
import { getFileContent } from '../github/client.js';
import { pushDraftBranch, openPrForBranch, getOrInitBatchBranch, resolveBatchBranch, baseBranch, batchBranchConflictError } from './lib/github-ops.js';
import { renderLandingPageBody, renderBlogOutlineBody, renderBlogOutlineBodyTsx, renderTranslationBody, renderTranslationBodyTsx, renderDirectAnswerBody, renderDirectAnswerBodyTsx, renderCompliancePageBody, renderMissingPageBody, extractPreservedFrontMatter } from './lib/newpage-render.js';
import { buildGradientCover } from '../generators/lib/gradient-cover.js';
import { siteHasUsableDesignProfile, checkDesignIntegrityGate, getDesignProfile } from './lib/design-drift.js';
import { runDesignGates } from './lib/design-gates.js';
import { renderableBody } from '../generators/lib/newpage-render-gate.js';
import { findRootArrayBounds, spliceMarkedArray, assertValidContent } from './adapters/lib/js-data-splice.js';

export const meta = {
  id: 'frontend',
  name: 'Frontend/Content Implementer',
  description: 'Places long-form draft content (landing pages, blog outlines, direct-answer sections, translated pages, trust/compliance pages) into the site\'s real templates as a pull request.',
  handles: ['landing-page', 'blog-outline', 'direct-answer', 'translation', 'cookie-policy', 'privacy-policy', 'terms-of-service', 'missing-page-create'],
};

export const COMPLIANCE_ACTION_TYPES = new Set(['cookie-policy', 'privacy-policy', 'terms-of-service']);

// Same set as meta.handles, as a Set — routes/action-center.js's
// generateDraft uses this to decide which action types get their full
// design/render/validate pipeline run at generation time (see this file's
// resolveTargetAndBody).
export const FRONTEND_ACTION_TYPES = new Set(meta.handles);

// landing-page/blog-outline are net-new content — resolveNewContentTarget
// gives a deterministic new file path, removing the "don't corrupt an
// existing file" risk backend.js's marker-splice has to guard against.
// translation targets a language-suffixed sibling of the real SOURCE page's
// resolved path (see resolveTranslationTarget). All three then render a
// real, minimal Markdown-with-front-matter body (lib/newpage-render.js) —
// shared by preview() and apply() below so they can never diverge. Also
// exported for routes/action-center.js's generateDraft — computing this
// (design/template resolution + render) at generation time, BEFORE a draft
// ever reaches Action Center for review, is what lets approval become a
// pure "push the already-prepared bytes" action instead of recomputing.
// `repoDeps` is the seam for the repo reads the net-new-content branches do
// (newcontent-contract.js's getRepoTree/getFileContent, and its `cache`).
// Production never passes it — the defaults are the real GitHub client and the
// module-level contract cache. It exists because the layout a new page ends up
// declaring is decided by what is really in the repo, and a regression test
// for "this directory's posts declare no layout, so neither does ours" has to
// be able to state what is in the directory. Without it the only coverage
// possible was "no config -> no-file-mapping", which is precisely the branch
// where the bug could not happen.
// A new file whose front matter lacks a key EVERY sibling declares fails a schema-validated build (Astro content collections: "author: Required"). The
// platform cannot invent an author or a cover, so such a file is refused with the exact keys and where to set them, instead of shipped broken.
// `newContentTargets[type].frontMatterDefaults` ({ author: 'team', cover: { kind: 'agent' } }) is how a site states them once.
function frontMatterDefaultsFor(site, actionType) {
  const d = site?.url_file_map?.newContentTargets?.[actionType]?.frontMatterDefaults;
  return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
}
function incompleteFrontMatter(body, contract, actionType) {
  const missing = missingRequiredKeys(body, contract);
  if (!missing.length) return null;
  return { ok: false, reason: 'front-matter-incomplete', error: `Every existing post in this directory declares ${missing.map((k) => `"${k}"`).join(', ')}, and the site's build rejects a post without ${missing.length === 1 ? 'it' : 'them'}. This new file would not build, so nothing was written. Set url_file_map.newContentTargets["${actionType}"].frontMatterDefaults for ${missing.join(', ')} (for example author, category, cover) and apply again.` };
}

export async function resolveTargetAndBody(site, draft, repoDeps = {}) {
  // Generation-time-prepared fast path: generateDraft (action-center.js)
  // already computed and rendering-gate-validated this exact output before
  // the draft was ever created, using the SAME resolveTargetAndBody this
  // function is. Reusing it verbatim (rather than recomputing — the two
  // would always produce the same bytes for an unedited draft anyway) is
  // what makes approval a pure "push the already-prepared thing" action
  // with no fresh generation/design work happening at click-time.
  // updateDraft (store/drafts.js) clears these two columns back to NULL the
  // moment a human edits draft.content, so an edited draft always falls
  // through to a fresh, correct recompute below — never a stale cached body.
  if (draft.rendered_body != null && draft.target_file_path != null) {
    // Every branch below always produces contentFormat: 'markdown' — the
    // one constant this fast path can safely assume without its own column.
    return { ok: true, filePath: draft.target_file_path, body: draft.rendered_body, contentFormat: 'markdown' };
  }

  const actionType = draft.action_type;
  const content = draft.content || {};

  // The title each of the branches below slugifies into its file path — the
  // permalink must be resolved from the SAME title, or the page would be
  // written at one slug and declare it lives at another.
  if (actionType === 'landing-page') {
    const title = content.metaTitle || content.headline || content.target;
    const filePath = resolveNewContentTarget(site, 'landing-page', title);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["landing-page"] configured — add e.g. {"dir":"src/pages","extension":".njk"} via `npm run connect-repo` before this can be applied.' };
    }
    const permalink = resolveNewContentUrl(site, 'landing-page', title);
    // Same sibling-derived contract as blog-outline/direct-answer below, for
    // the same reason: a landing page written into src/pages inherits whatever
    // that directory's real pages do about layout, and a config-derived
    // `layout: base.njk` on a directory whose pages declare none (or declare a
    // different one) drops the new page out of its template exactly the way it
    // did on zunkireelabs.com's blog. resolveNewContentLayout stays as the
    // fallback for a directory with no readable siblings. fieldNames is also
    // threaded through now (renderLandingPageBody only ever WRITES an image
    // field when fieldNames.featuredImage came from real sibling evidence —
    // see its own comment — so a directory with no image convention still
    // gets exactly today's behavior).
    const contract = await deriveNewContentContract(site, {
      ...resolveNewContentTargetConfig(site, 'landing-page'),
    }, repoDeps);
    const layout = contract.unknown ? resolveNewContentLayout(site, 'landing-page') : contract.layout;
    const lpBody = renderLandingPageBody(content, site, { permalink, layout, fieldNames: contract.fieldNames, frontMatterDefaults: frontMatterDefaultsFor(site, 'landing-page') });
    const lpIncomplete = incompleteFrontMatter(lpBody, contract, 'landing-page');
    if (lpIncomplete) return lpIncomplete;
    return { ok: true, filePath, body: lpBody, contentFormat: 'markdown' };
  }

  if (actionType === 'blog-outline') {
    const title = content.title || content.topic;
    const filePath = resolveNewContentTarget(site, 'blog-outline', title);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["blog-outline"] configured — add e.g. {"dir":"src/blog","extension":".md"} via `npm run connect-repo` before this can be applied.' };
    }
    const permalink = resolveNewContentUrl(site, 'blog-outline', title);

    // A `filename` on the target config (url-file-map.js's
    // resolveNewContentTarget) means this site routes by directory — a
    // Next.js App Router page, not a flat Eleventy-style file — so the real
    // page component is JSX, never Markdown+front-matter, which would be
    // invalid TypeScript in a .tsx file and fail the client's build outright.
    const targetConfig = resolveNewContentTargetConfig(site, 'blog-outline');
    // A "converted" static site (every page carries its own front matter and head file) is written by copying a real sibling post. See
    // lib/converted-blog-resolve.js. Checked first: such a target also names a filename, which would otherwise route it to the Next.js writer below.
    if (targetConfig.mode === 'clone-sibling') {
      return resolveConvertedBlogPost(site, content, targetConfig, { filePath, readFile: repoDeps.getFileContent || getFileContent, ref: baseBranch(site) });
    }
    if (targetConfig.filename) {
      return {
        ok: true,
        filePath,
        body: renderBlogOutlineBodyTsx(content, site, { canonicalUrl: permalink }),
        contentFormat: 'jsx',
      };
    }

    // Siblings first: the posts already in this directory are the authority on
    // whether a post declares its own layout and what it calls its hero image.
    // resolveNewContentLayout stays as the fallback for a directory with no
    // readable siblings. See newcontent-contract.js for why.
    // BLOG STANDARD: a post is only ever written into the folder the site's real posts live in. A configured folder that is not it (a notes/docs
    // folder) gets no blog layout, so the draft is refused with the folder to use, not shipped looking wrong.
    const betterDir = await findBetterBlogDirectory(site, targetConfig, repoDeps);
    if (betterDir) {
      return {
        ok: false, reason: 'blog-target-wrong-folder',
        error: `This site's blog target is "${targetConfig.dir}", but its blog posts live in "${betterDir.dir}" (${betterDir.files} files). A post written to "${targetConfig.dir}" would not get the blog layout. Nothing was written. Set newContentTargets["blog-outline"].dir to "${betterDir.dir}" and this can ship.`,
      };
    }
    const contract = await deriveNewContentContract(site, targetConfig, repoDeps);
    const layout = contract.unknown ? resolveNewContentLayout(site, 'blog-outline') : contract.layout;
    // Opt-in generated gradient cover: an SVG committed next to the post in the
    // same atomic commit, referenced from its front matter. A site that did not
    // opt in gets null here and keeps whatever image the generator found. A
    // draft that already carries an image (an Insights post's Pexels photo under
    // `featuredImage: 'insights-only'`) keeps it: the cover is for posts without one.
    const cover = content.featuredImage ? null : buildGradientCover(site, { slug: filePath.split('/').pop().replace(/\.[^.]+$/, '') });
    const boBody = renderBlogOutlineBody(cover ? { ...content, featuredImage: cover.featuredImage } : content, site, { permalink, layout, fieldNames: contract.fieldNames, frontMatterDefaults: { ...(contract.siblingConstants || {}), ...(frontMatterDefaultsFor(site, 'blog-outline') || {}) }, sourcesInFrontMatter: Boolean(contract.declaresSources) });
    const boIncomplete = incompleteFrontMatter(boBody, contract, 'blog-outline');
    if (boIncomplete) return boIncomplete;
    return {
      ok: true,
      filePath,
      body: boBody,
      contentFormat: 'markdown',
      ...(cover ? { extraFiles: [cover.file] } : {}),
    };
  }

  // Unlike every other branch here, the file path is NOT slugified from the
  // title and the permalink is NOT urlPattern-derived: both come from the
  // dead href this page exists to make resolve. The target directory is
  // derived from the siblings the decision was made on (see
  // resolveMissingPageTarget) rather than from a newContentTargets entry, so
  // this needs no per-site onboarding config — a site that has siblings under
  // the section already has everything required.
  if (actionType === 'missing-page-create') {
    const href = content.href;
    const siblings = Array.isArray(content.siblings) ? content.siblings : [];
    const target = href ? resolveMissingPageTarget(site, href, siblings) : null;
    if (!target) {
      return {
        ok: false,
        reason: 'no-file-mapping',
        error: `No url_file_map entry resolves any sibling page under ${href || 'this section'} to a real repo file, so there is no directory to create the page in — remove the dead link instead.`,
      };
    }
    let permalink = null;
    try { permalink = new URL(href).pathname; } catch { /* leave null — the build decides, same as every other renderer */ }
    // Siblings are real existing pages in this same directory, so they are a
    // strictly better contract source than the target-config path used by
    // landing-page/blog-outline above — deriveContractFromSourceFile reads the
    // actual file one of them resolves to.
    const contract = await deriveContractFromSourceFile(site, target.modelFile, {}, repoDeps).catch(() => ({ unknown: true }));
    const layout = contract.unknown ? null : contract.layout;
    return {
      ok: true,
      filePath: target.filePath,
      body: renderMissingPageBody(content, site, { permalink, layout }),
      contentFormat: 'markdown',
    };
  }

  if (actionType === 'direct-answer') {
    const title = content.title || content.heading || content.query;
    const filePath = resolveNewContentTarget(site, 'direct-answer', title);
    if (!filePath) {
      return { ok: false, reason: 'no-file-mapping', error: 'No url_file_map.newContentTargets["direct-answer"] configured — add e.g. {"dir":"src/answers","extension":".md"} via `npm run connect-repo` before this can be applied.' };
    }
    const permalink = resolveNewContentUrl(site, 'direct-answer', title);

    // Same directory-per-page signal as blog-outline: a `filename` on the
    // target config means this site routes by directory (Next.js App
    // Router), so the real page must be JSX, not Markdown+front-matter.
    const directAnswerTargetConfig = resolveNewContentTargetConfig(site, 'direct-answer');
    if (directAnswerTargetConfig.filename) {
      return {
        ok: true,
        filePath,
        body: renderDirectAnswerBodyTsx(content, site, { canonicalUrl: permalink }),
        contentFormat: 'jsx',
      };
    }

    // Same sibling-derived contract as blog-outline: on this platform's own
    // first client both types write into the very same src/blog directory, so
    // a layout that is wrong for one is wrong for the other.
    const contract = await deriveNewContentContract(site, {
      ...directAnswerTargetConfig,
    }, repoDeps);
    const layout = contract.unknown ? resolveNewContentLayout(site, 'direct-answer') : contract.layout;
    const daBody = renderDirectAnswerBody(content, site, { permalink, layout, fieldNames: contract.fieldNames, frontMatterDefaults: frontMatterDefaultsFor(site, 'direct-answer') });
    const daIncomplete = incompleteFrontMatter(daBody, contract, 'direct-answer');
    if (daIncomplete) return daIncomplete;
    return { ok: true, filePath, body: daBody, contentFormat: 'markdown' };
  }

  // No permalink for a translation: its target is a language-suffixed sibling
  // of the SOURCE page's real file (resolveTranslationTarget), not a
  // newContentTargets directory, so there is no urlPattern to resolve against
  // and no honest way to know the site's translated-URL convention. It keeps
  // today's behavior — the build decides — rather than guessing one.
  if (actionType === 'translation') {
    const sourcePath = resolveFile(site, content.page);
    if (!sourcePath) {
      return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches the source page "${content.page || '(none)'}" — add one via \`npm run connect-repo\` before this can be applied.` };
    }
    const filePath = resolveTranslationTarget(sourcePath, content.targetLanguage);

    // Same directory-per-page signal as blog-outline/direct-answer above.
    const translationTargetConfig = resolveNewContentTargetConfig(site, 'translation');
    if (translationTargetConfig.filename) {
      return {
        ok: true,
        filePath,
        body: renderTranslationBodyTsx(content, site),
        contentFormat: 'jsx',
      };
    }

    // No permalink (see above), but a translated page is still a brand-new
    // file that needs the site's real chrome around it — and unlike every
    // other type here, this one already knows the exact file it must look
    // like. A translation is the SAME page in another language, so its
    // authority is that source page's own front matter, not a majority vote
    // over a directory that holds pages built on several different layouts
    // (see deriveContractFromSourceFile). resolveNewContentLayout stays as the
    // fallback for a source file that couldn't be read.
    const contract = await deriveContractFromSourceFile(site, sourcePath, {}, repoDeps);
    const layout = contract.unknown ? resolveNewContentLayout(site, 'translation') : contract.layout;
    return { ok: true, filePath, body: renderTranslationBody(content, site, { layout }), contentFormat: 'markdown' };
  }

  if (COMPLIANCE_ACTION_TYPES.has(actionType)) {
    // A real, already-linked page (trust-compliance.js's 'broken' finding —
    // homepage links to it, but it doesn't render real content) should be
    // overwritten in place via the normal pages[] mapping, not shadowed by
    // a second, unlinked page at a slugified path. Only fall back to
    // resolveNewContentTarget when there's no existing page to target (the
    // 'missing' finding — homepage has no link to a page at all yet) or the
    // site hasn't mapped that URL in url_file_map.pages.
    const page = content.page || draft.input?.page;
    const existingFile = page ? resolveFile(site, page) : null;
    const title = content.metaTitle || content.headline;
    // A new legal page whose configured target is a placeholder folder (docs/, content-drafts/) would be a file nothing builds: a 404 on the site and a draft
    // marked done. Learn the real location from the site's own privacy/terms pages instead (legal-target.js). No sibling to learn from keeps the config.
    let derivedLegal = null;
    if (!existingFile) {
      const cfg = resolveNewContentTargetConfig(site, actionType) || {};
      if (!cfg.dir || isPlaceholderDir(cfg.dir)) {
        derivedLegal = await deriveLegalTarget(site, actionType, { readFile: repoDeps.getFileContent || getFileContent, ref: baseBranch(site) });
        if (derivedLegal?.conflict) {
          return { ok: false, reason: 'slug-conflict', error: `${derivedLegal.filePath} already exists in this site but is not listed in url_file_map.pages, so it was not overwritten. Map that page (or point this draft at it) and apply again.` };
        }
      }
    }
    const filePath = existingFile || derivedLegal?.filePath || resolveNewContentTarget(site, actionType, title);
    if (!filePath) {
      const pageHint = page ? ` (real target "${page}" isn't in url_file_map.pages either)` : '';
      return { ok: false, reason: 'no-file-mapping', error: `No url_file_map.newContentTargets["${actionType}"] configured${pageHint} — add one via \`npm run connect-repo\` before this can be applied.` };
    }
    // Overwriting a real, already-linked page — preserve its own
    // layout/permalink front matter (see extractPreservedFrontMatter) so
    // this doesn't silently orphan the live URL.
    const readFile = repoDeps.getFileContent || getFileContent;
    const existing = existingFile ? await readFile(site, existingFile, baseBranch(site)) : null;
    const preserved = extractPreservedFrontMatter(existing?.content);
    // Only for the genuinely-new-file case — an existing page's own preserved
    // permalink always wins inside the renderer.
    const permalink = existingFile ? null : (derivedLegal?.permalink || resolveNewContentUrl(site, actionType, title));
    // Only the genuinely-new-file case derives a contract. Overwriting a real
    // page is already answered by that page's own preserved front matter
    // (which wins inside the renderer regardless), so sampling its neighbours
    // would spend a repo tree plus eight file reads on an answer nothing uses.
    // For a NEW compliance page the directory's siblings are the authority,
    // same as every other net-new type — a `layout: base.njk` emitted into a
    // src/pages whose pages declare none overrides the directory's real one.
    const contract = existingFile || derivedLegal
      ? null
      : await deriveNewContentContract(site, { ...resolveNewContentTargetConfig(site, actionType) }, repoDeps);
    const layout = derivedLegal
      ? derivedLegal.layout
      : contract && !contract.unknown
        ? contract.layout
        : resolveNewContentLayout(site, actionType);
    return { ok: true, filePath, body: renderCompliancePageBody(content, preserved, site, { permalink, layout }), contentFormat: 'markdown' };
  }

  return { ok: false, reason: 'merge-strategy-not-implemented', error: `No merge strategy for action type "${actionType}".` };
}

// Appends this new post's listing metadata to the site's own "generated
// posts" manifest — url_file_map.newContentTargets['blog-outline'].manifestFile
// (e.g. Admizz's src/data/generated-posts.json) — in the SAME commit as the
// post file itself, so a post can never be created successfully without
// also being discoverable by the blog listing page (which does a plain
// static import of this file — no runtime fs scan, no dynamic import,
// deterministic on Vercel). Reuses the same tested "managed flat-array"
// splice (spliceMarkedArray/findRootArrayBounds) data-array-content.js's
// flat-array shape already uses for FAQ items, keyed by `slug` instead of
// question/answer, tagged `_aiManaged` so re-applying never disturbs a
// hand-authored manifest entry.
//
// Only sites that configured a manifestFile get this second write — every
// other tenant's blog-outline (markdown/Eleventy) keeps today's
// single-file behavior unchanged, since their static-site generator
// discovers new pages by directory/collection, not a manifest.
//
// Returns null (nothing to do) when unconfigured, or {ok:false,...} on a
// genuine failure — callers must treat a failure here as fatal to the whole
// apply, never push the post file without its manifest entry landing in the
// same commit.
// A client's own build may require content a generator cannot honestly invent (an answer-first summary, visible FAQ items, official
// sources). Per-site newContentTargets['blog-outline'].postContract.requiredContent lists them by name; a draft missing any is refused
// BEFORE it is written, with the exact list, so a human supplies it (never a guess, never a post the client's build then rejects).
export function checkPostContract(site, content) {
  const required = site.url_file_map?.newContentTargets?.['blog-outline']?.postContract?.requiredContent || [];
  const has = {
    quickAnswer: typeof content?.quickAnswer === 'string' && content.quickAnswer.trim().length >= 20,
    faqItems: Array.isArray(content?.faqItems) && content.faqItems.some((x) => x?.question && x?.answer),
    sources: Array.isArray(content?.sources) && content.sources.some((x) => x?.label && /^https:\/\//.test(x.url || '')),
  };
  const missing = required.filter((k) => !has[k]);
  return missing.length
    ? { ok: false, reason: 'draft-not-ready', error: `This site's build requires ${missing.join(', ')} on every new post, and this draft has none of ${missing.length === 1 ? 'it' : 'them'}. A person must supply ${missing.length === 1 ? 'it' : 'them'} (official sources in particular are never generated) before this can be applied.` }
    : { ok: true };
}

export async function computeGeneratedPostsManifestUpdate(site, entry, fetchFile, beforeRef, { ownFilePath = null, categoriesLookupFailed = false } = {}) {
  const target = site.url_file_map?.newContentTargets?.['blog-outline'] || {};
  const manifestPath = target.manifestFile;
  if (!manifestPath) return null;

  // Required manifest fields (per-site, from the client's own build rules): refuse BEFORE writing rather than push a post the
  // client's build will reject. A failed category lookup is named as the cause when that is why categories are empty.
  for (const field of target.manifestRequired || []) {
    const v = entry[field];
    if (v == null || String(v).trim() === '' || (Array.isArray(v) && !v.length)) {
      const why = field === 'categories' && categoriesLookupFailed ? ' (the category source could not be read — retry later, nothing was written)' : '';
      return { ok: false, reason: 'draft-not-ready', error: `This site requires "${field}" on every new post and the draft has none${why}.` };
    }
  }

  // The post's slug must not collide with an existing route or post (site-specific paths, `{slug}` substituted). Skipped for the
  // draft's own file so re-applying the same draft stays idempotent.
  for (const tpl of target.collisionChecks || []) {
    const path = tpl.replaceAll('{slug}', entry.slug);
    if (path === ownFilePath) continue;
    if (await fetchFile(site, path, beforeRef)) {
      return { ok: false, reason: 'slug-conflict', error: `"${entry.slug}" already exists in this site (${path}) — refusing to create a second page at the same address.` };
    }
  }

  const file = await fetchFile(site, manifestPath, beforeRef);
  // A configured manifest that cannot be read must never be silently re-created as a one-entry file: that would drop every existing
  // post from listings and sitemaps. Only an explicit opt-in may start a new manifest.
  if (!file && !target.manifestMayBeCreated) {
    return { ok: false, reason: 'invalid-edit', error: `${manifestPath} is configured but does not exist on "${beforeRef}" — refusing to create it from scratch (set manifestMayBeCreated to allow).` };
  }
  const content = file ? file.content : '[]';
  const arrayRange = findRootArrayBounds(content, 'json-array');
  if (!arrayRange) {
    return { ok: false, reason: 'invalid-edit', error: `${manifestPath} does not contain a valid top-level JSON array — refusing to guess its shape.` };
  }
  const interior = content.slice(arrayRange.start, arrayRange.end);
  let existing;
  try { existing = interior.trim() ? JSON.parse(`[${interior}]`) : []; } catch {
    return { ok: false, reason: 'invalid-edit', error: `${manifestPath} is not valid JSON — refusing to guess its shape.` };
  }
  const handAuthoredClash = existing.find((it) => it && !it._aiManaged && it.slug === entry.slug);
  if (handAuthoredClash) {
    return { ok: false, reason: 'slug-conflict', error: `${manifestPath} already has a hand-authored post "${entry.slug}" — refusing to overwrite or duplicate it.` };
  }
  const aiManaged = existing.filter((it) => it && it._aiManaged);
  const nextSet = [...aiManaged.filter((it) => it.slug !== entry.slug), entry];
  const newContent = spliceMarkedArray(content, arrayRange, nextSet, 'json-array');
  const check = assertValidContent(newContent, 'json-array');
  if (!check.ok) {
    return { ok: false, reason: 'invalid-edit', error: `Auto-generated edit would break ${manifestPath}'s syntax (${check.error}) — refused to apply.` };
  }
  return { ok: true, filePath: manifestPath, newContent };
}

// Pushes a real branch (forked from the site's default branch) with the
// real new-file content — not merged yet (see mergeToStage below). Staff
// reviews the real diff (Draft Preview panel, unchanged — same
// resolveTargetAndBody output) before deciding to merge the PR.
// Tier B of the page-role resolver: what the target directory's own
// human-written posts declare. Cached per directory by the contract module.
// Shared by apply() and preview() so the two can never judge differently.
function designGateDeps() {
  return {
    deriveContract: async (s, actionType) => {
      const cfg = resolveNewContentTargetConfig(s, actionType);
      return cfg.dir ? deriveNewContentContract(s, cfg) : null;
    },
  };
}

// The same pre-ship design gates apply() runs, run EARLIER and quietly so the
// approval flow's repair loop (generators/lib/design-repair.js) can act on a
// failure while the draft can still be changed. Quiet = no owner notification
// and no per-attempt lesson: the loop sends one of each per episode, with the
// diagnosis. Returns the structured evidence the loop diagnoses from.
async function designGateForPreview(site, draft, resolved) {
  const noop = async () => {};
  const gate = await runDesignGates(site, draft, resolved, { ...designGateDeps(), notify: noop, learnFailure: noop, learnFix: noop });
  if (gate.ok) return { ok: true };
  const body = renderableBody(resolved.body, resolved.contentFormat);
  return {
    ok: false,
    reason: gate.reason,
    error: gate.error,
    deviations: gate.renderGate?.detail?.deviations || [],
    referenceUrl: gate.renderGate?.referenceUrl || null,
    designAssessment: gate.designAssessment || null,
    draftHtml: body.html ?? null,
  };
}

export async function apply(site, draft) {
  const resolved = await resolveTargetAndBody(site, draft);
  if (!resolved.ok) return resolved;

  // The design-integrity gate's frontend.js counterpart to backend.js's own
  // computeMarkerMerge check (design-integrity-gate proposal, change 04).
  // Every FRONTEND_ACTION_TYPES page is styled body copy — there is no
  // schema-only mode here the way marker-merge.js's content types have — and
  // newpage-render.js's wrapInSiteProse falls through to a live
  // projectPageWrapper(designProfile) projection whenever no repo-verified
  // contentWrapper is configured, same "on-the-fly, unstamped" exposure
  // checkDesignIntegrityGate closes automatically (verifyProfileRoles,
  // design-drift.js) rather than via human sign-off. Simpler than trying to
  // detect whether THIS specific draft's wrapper actually came from the
  // profile (which would mean re-deriving wrapInSiteProse's own branching
  // here and risking the two drifting apart) — a confirmed role-mismatch
  // quarantines this one draft, never the whole site's other pages.
  // Design gates (completeness, then a real render comparison): fail closed
  // in 'enforce', record-and-ship in 'log', absent in 'off'. See
  // lib/design-gates.js for the policy and design_gate_decisions (186) for the
  // log-only evidence that decides when it is safe to enforce.
  const designGate = await runDesignGates(site, draft, resolved, designGateDeps());
  if (!designGate.ok) return designGate;

  // STRICT DESIGN PROTECTION (lib/design-protection, Phase 3): a new page is rendered into a real page of its own template (baseline captured, never assumed).
  // 'log' (default) records only; 'enforce' waits when there is no baseline or it cannot be rendered, and refuses a measured break.
  {
    const { protectNewPage, toPendingError } = await import('../lib/design-protection/hooks.js');
    const protection = await protectNewPage({ site, draft, resolved })
      .catch((err) => ({ ok: true, verdict: 'error', error: err.message, reasons: [] })); // protection's own failure never ships or blocks by itself
    if (!protection.ok) {
      if (protection.pending) throw await toPendingError(protection);
      return { ok: false, reason: `design-protection-${protection.verdict}`, error: protection.error };
    }
  }

  if (siteHasUsableDesignProfile(site)) {
    const gate = await checkDesignIntegrityGate(site, { actionType: draft.action_type, findingId: draft.finding_id });
    if (!gate.ok) {
      // Kept for this tenant so the same mismatch is recognised next time.
      await (await import('../store/design-knowledge.js')).recordDesignFailure(site.id, {
        patternId: 'design-integrity-failed', generatorId: draft.action_type,
        detail: gate.error || `${gate.field} uses classes this site only ever uses for its ${gate.observedAs}.`,
        draftId: draft.id ?? null, validation: { passed: false, gate: 'integrity' },
      }).catch(() => {});
      return {
        ok: false, reason: 'design-integrity-failed',
        error: gate.error || `${gate.field} uses classes this site only ever uses for its ${gate.observedAs}.`,
      };
    }
  }

  const { batchInfo, failure: batchFailure } = await resolveBatchBranch(site);
  if (batchFailure) return batchFailure;
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);

  const files = [{
    path: resolved.filePath, content: resolved.body,
    contentFormat: resolved.contentFormat, actionType: draft.action_type,
  }];
  for (const f of resolved.extraFiles || []) files.push({ ...f, actionType: draft.action_type });

  // blog-outline + filename-mode (App Router directory-per-post) is the
  // only combination with a manifest to update — see
  // computeGeneratedPostsManifestUpdate's own comment.
  if (draft.action_type === 'blog-outline' && resolved.contentFormat === 'jsx') {
    const contract = checkPostContract(site, draft.content);
    if (!contract.ok) return contract;
    const beforeRef = batchInfo.exists ? batchInfo.branchName : baseBranch(site);
    const title = draft.content?.title || draft.content?.topic || 'Untitled';
    const manifestUpdate = await computeGeneratedPostsManifestUpdate(site, {
      slug: slugifyTitle(title),
      title,
      excerpt: draft.content?.metaDescription || null,
      imageUrl: draft.content?.featuredImage?.url || null,
      imageAlt: draft.content?.featuredImage?.alt || null,
      categories: Array.isArray(draft.content?.categories) ? draft.content.categories : [],
      publishedAt: draft.content?.publishedAt || new Date().toISOString(),
      href: resolveNewContentUrl(site, 'blog-outline', title),
    }, getFileContent, beforeRef, { ownFilePath: resolved.filePath, categoriesLookupFailed: !!draft.content?.categoriesLookupFailed });
    if (manifestUpdate) {
      // Fatal to the whole apply — never push the post file without its
      // manifest entry landing in the same commit (see the atomic-workflow
      // requirement in this function's own doc comment above).
      if (!manifestUpdate.ok) return manifestUpdate;
      files.push({ path: manifestUpdate.filePath, content: manifestUpdate.newContent, actionType: draft.action_type });
    }
  }

  return pushDraftBranch(site, draft, files, batchInfo);
}

// branch_pushed -> PR opened into the site's default branch (human merges
// on GitHub). Despite the name — kept as-is because implementers/registry.js
// checks for this exact export name at load time (see
// server/implementers/registry.js) — this doesn't merge into stage at all,
// it opens a PR. draft.branch_name is already real (persisted by
// markDraftBranchPushed after apply() above succeeded) — this step only
// opens the PR, no new file writes.
export async function mergeToStage(site, draft) {
  if (!draft.branch_name) return { ok: false, reason: 'no-branch', error: 'No branch has been pushed for this draft yet.' };
  return openPrForBranch(site, draft, draft.branch_name);
}

// Zero-write dry run, same shared-computation principle as backend.js's
// preview(): a brand-new file's "before" is simply whatever's on that path
// today (empty/none for a genuinely new page, real existing content if a
// prior attempt already opened this exact file, e.g. a retried translation).
export async function preview(site, draft, opts = {}) {
  const resolved = await resolveTargetAndBody(site, draft);
  if (!resolved.ok) return resolved;
  // Opt-in (the approval flow only): rendering in a real browser is far too slow
  // for the Draft Preview panel's every open. Nothing changes for any other caller.
  if (opts.validateDesign) {
    const designResult = await designGateForPreview(site, draft, resolved);
    if (!designResult.ok) return designResult;
  }
  const { batchInfo, failure: batchFailure } = await resolveBatchBranch(site);
  if (batchFailure) return batchFailure;
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  const branch = batchInfo.exists ? batchInfo.branchName : baseBranch(site);
  const existing = await getFileContent(site, resolved.filePath, branch);
  // A post that comes with other files (its own head file, a listing card) shows them too: the reviewer approves exactly what will be committed.
  const extraRegions = [];
  for (const f of resolved.extraFiles || []) {
    const before = await getFileContent(site, f.path, branch).catch(() => null);
    extraRegions.push({ field: `file: ${f.path}`, before: before?.content || '(new file)', after: f.content });
  }
  return {
    ok: true,
    filePath: resolved.filePath,
    oldContent: existing?.content || '',
    newContent: resolved.body,
    contentFormat: resolved.contentFormat,
    changedRegions: [{ field: draft.action_type, before: existing?.content || '(new file)', after: resolved.body }, ...extraRegions],
    ...(resolved.notes?.length ? { notes: resolved.notes } : {}),
  };
}
