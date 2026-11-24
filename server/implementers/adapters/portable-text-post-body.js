import { getFileContent } from '../../github/client.js';
import { pushDraftBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from '../lib/github-ops.js';
import { resolveAdapter } from '../lib/url-file-map.js';
import { keyFromPage } from './ts-named-export-content.js';
import { openPrWithSnapshot, rollbackFromSnapshot } from './lib/data-file-writer.js';
import { analyzeRichPost, nextSectionId, richSectionHtml, richQaHtml, resolveTableMarkup, extractTableCss, applyInsertions, verifyRichBlockEdit, normHeading } from './lib/rich-post-html.js';
import {
  rendererCapabilities, sectionToBlocks, insertionIndex, existingHeadings, normalizeHeading, qaToBlocks, isCanonicalJson, canonicalJson, verifyBodyEdit, newAiKey, rawHtmlDominates,
} from './lib/portable-text-body.js';

// Adds expanded (or refreshed) sections to a post whose body is Portable Text JSON, e.g. admizz-web-dev
//   src/content/blog/posts/<slug>.json   { ..., "content": [ {_type:'block', style:'h2', ...}, {_type:'rawHtml', html:'<div class="table-scroll">...'} ] }
// rendered by one shared template (/[slug]/page.tsx) through src/components/PortableTextRenderer.tsx.
//
// A post can also be ONE raw-HTML block built from the site's rich-post template (sections, call-to-action, FAQ). Those are edited in the page's own markup
// (lib/rich-post-html.js): a new <section class="section"> using only tags and table markup the page already uses, directly above its call to action.
//
// The template is design and is never touched. The post's own file is the page's content store, and this writes only into it: new blocks, inserted above the
// post's closing part and above its call to action, and nothing else in the file. What it writes is limited to what the site's own renderer draws (read from the
// renderer's source), and a table is the site's own table markup taken from its existing posts, so the page looks like the rest of the site. Anything it cannot
// draw is refused with a reason (never approximated), and an edit is only returned when verifyBodyEdit proves nothing else in the file changed.
//
// Config (url_file_map.pages[url].adapters['expand-content'] or ['refresh-content'], or a pattern):
//   (tableCssFile?: 'src/components/lib/blog-rich-styles.ts' is the site's stylesheet whose table rules may be copied into a raw-HTML page's own <style>)
//   { id: 'portable-text-post-body', contentFile: 'src/content/blog/posts/{key}.json', urlPattern: '^/([^/]+)/?$',   // group 1 IS the key
//     rendererFile?: 'src/components/PortableTextRenderer.tsx', bodyField?: 'content',
//     tableMarkup?: { wrapperClass: 'table-scroll', tableClass: 'elig-table' } }   // the site's own table markup; absent = this site gets no tables from us
// The post must already exist: the file is never created.
export const meta = {
  id: 'portable-text-post-body',
  description: 'Adds expanded sections to a post stored as Portable Text JSON, using only blocks the site\'s own renderer draws, above its call to action.',
};

// refresh-content drafts the same `sections` shape (one "Updated" section, see generators/refresh-content.js), so it is written the same way.
// qa-content is question headings with short answers woven into the body (generators/qa-content.js), a slot of its own and not the FAQ box.
export const SUPPORTED_ACTIONS = ['expand-content', 'refresh-content', 'qa-content'];

const sub = (s, key) => String(s).replaceAll('{key}', key);

export async function identifyTarget(site, page, config, fetchFile = getFileContent, ref = baseBranch(site)) {
  if (!config?.contentFile?.includes('{key}')) return { ok: false, reason: 'invalid-config', error: 'Adapter config needs contentFile with a {key} placeholder.' };
  const k = keyFromPage(page, { ...config, shape: 'keyed-record' });
  if (!k.ok) return { ok: false, reason: 'no-file-mapping', error: k.error };
  const filePath = sub(config.contentFile, k.key);
  const file = await fetchFile(site, filePath, ref);
  if (!file) return { ok: false, reason: 'target-not-identified', error: `No ${filePath} on "${ref}": "${k.key}" is not a known post, so nothing is created for it.` };
  if (!isCanonicalJson(file.content)) return { ok: false, reason: 'no-insertion-marker', error: `${filePath} is not in the format this adapter can edit byte-for-byte, so it is not edited.` };
  const post = JSON.parse(file.content);
  const field = config.bodyField || 'content';
  if (!Array.isArray(post[field])) return { ok: false, reason: 'no-insertion-marker', error: `${filePath} has no "${field}" array.` };
  if (rawHtmlDominates(post[field])) {
    // A whole page stored as one raw-HTML block with its own styling: edited in ITS markup, never with plain blocks that would not match it.
    const raws = post[field].map((b, i) => [b, i]).filter(([b]) => b?._type === 'rawHtml');
    if (raws.length !== 1) return { ok: false, reason: 'no-insertion-marker', error: `${filePath} is a page stored as raw HTML in ${raws.length} pieces, so there is no single page to place a section in. It is not edited.` };
    const analysis = analyzeRichPost(raws[0][0].html);
    if (!analysis.ok) return { ok: false, reason: 'no-insertion-marker', error: `${filePath} is a page stored as raw HTML, and ${analysis.error}, so it is not edited.` };
    return { ok: true, file, filePath, post, field, key: k.key, mode: 'rich-html', blockIndex: raws[0][1], analysis };
  }
  return { ok: true, file, filePath, post, field, key: k.key };
}

export async function isDataReady(site, page, config, fetchFile = getFileContent, ref = baseBranch(site)) {
  return (await identifyTarget(site, page, config, fetchFile, ref)).ok;
}

export async function computeChange(site, draft, fetchFile = getFileContent, ref = baseBranch(site)) {
  const page = draft.content?.page || draft.input?.page;
  if (!SUPPORTED_ACTIONS.includes(draft.action_type)) return { ok: false, reason: 'unsupported-action', error: `${meta.id} does not write "${draft.action_type}" drafts.` };
  const config = resolveAdapter(site, page, draft.action_type);
  if (config?.id !== meta.id) return { ok: false, reason: 'no-file-mapping', error: `No ${meta.id} config resolves for "${page || '(no page)'}".` };
  const isQa = draft.action_type === 'qa-content';
  const sections = isQa ? draft.content?.items : draft.content?.sections;
  if (!Array.isArray(sections) || !sections.length) return { ok: false, reason: 'draft-not-ready', error: isQa ? 'The draft has no Q&A items to add.' : 'The draft has no sections to add.' };

  const id = await identifyTarget(site, page, config, fetchFile, ref);
  if (!id.ok) return id;
  const { file, filePath, post, field } = id;
  if (id.mode === 'rich-html') return richChange({ id, draft, config, sections, isQa, site, fetchFile, ref });

  const rendererFile = config.rendererFile || 'src/components/PortableTextRenderer.tsx';
  const renderer = await fetchFile(site, rendererFile, ref);
  if (!renderer) return { ok: false, reason: 'file-not-found', error: `${rendererFile} does not exist on "${ref}", so what the site can draw is unknown and nothing is written.` };
  const capabilities = rendererCapabilities(renderer.content);

  // A section the post already has (same heading) is never added a second time.
  const have = existingHeadings(post[field]);
  const kind = draft.content?.focus === 'external-citations' ? 'sources' : 'body';
  const inserted = []; const skipped = [];
  if (isQa) {
    const qa = qaToBlocks(sections, { capabilities, existing: have, newKey: newAiKey });
    if (!qa.ok) return qa;
    inserted.push(...qa.blocks); skipped.push(...qa.skipped);
  } else for (const section of sections) {
    if (have.has(normalizeHeading(section?.heading))) { skipped.push(section.heading); continue; }
    const built = sectionToBlocks(section, { capabilities, tableMarkup: config.tableMarkup || null, newKey: newAiKey });
    if (!built.ok) return built;
    inserted.push(...built.blocks);
    have.add(normalizeHeading(section.heading));
  }
  if (!inserted.length) return { ok: false, reason: 'already-satisfied', error: `Every proposed section already exists in ${filePath}: ${skipped.join('; ')}.` };

  const index = insertionIndex(post[field], kind);
  const next = { ...post, [field]: [...post[field].slice(0, index), ...inserted, ...post[field].slice(index)] };
  const newContent = canonicalJson(next);
  const proof = verifyBodyEdit(file.content, newContent, { field, index, inserted });
  if (!proof.ok) return { ok: false, reason: 'invalid-edit', error: `Edit to ${filePath} failed the safety proof (${proof.error}), so it was refused.` };

  return {
    ok: true, filePath, oldContent: file.content, newContent,
    changedRegions: [{ field: `${field}[${index}..${index + inserted.length - 1}]`, markerName: 'AI-managed', before: '(none)', after: `${inserted.length} block(s): ${sections.map((s) => s.heading ?? s.question).filter((h) => !skipped.includes(h)).join(' | ')}` }],
    skippedExisting: skipped,
    renderMode: 'visible',
  };
}


// The raw-HTML path: one new <section class="section"> (or one for each proposed section), in the page's own markup, directly above its call to action or FAQ.
async function richChange({ id, draft, config, sections, isQa, site, fetchFile, ref }) {
  const { file, filePath, post, field, blockIndex, analysis } = id;
  const html = post[field][blockIndex].html;
  const taken = new Set(analysis.ids); const have = new Set(analysis.headings);
  const fragments = []; const skipped = [];
  const insertions = [];
  if (isQa) {
    const qa = richQaHtml(sections, { idFor: (label) => nextSectionId(analysis, label, taken), uses: analysis.uses, existing: have });
    if (!qa.ok) return qa;
    skipped.push(...qa.skipped); if (qa.html) fragments.push(qa.html);
  } else {
    let tableMarkup = resolveTableMarkup(analysis, config.tableMarkup);
    // The page has its own CSS that does not define the site's table classes. The site's own stylesheet does: copy ITS rules for those classes into the page's
    // existing <style> (one more proven insertion), so the table looks exactly like the site's tables. Without that stylesheet, or without a <style> to add to,
    // no table is written.
    if (!tableMarkup && sections.some((x) => x?.table?.length) && config.tableMarkup && config.tableCssFile && analysis.styleEnd >= 0) {
      const cssFile = await fetchFile(site, config.tableCssFile, ref);
      const rules = cssFile ? extractTableCss(cssFile.content, config.tableMarkup) : null;
      if (rules) { tableMarkup = config.tableMarkup; insertions.push({ at: analysis.styleEnd, text: `\n${rules}\n` }); }
    }
    for (const section of sections) {
      if (have.has(normHeading(section?.heading))) { skipped.push(section.heading); continue; }
      const built = richSectionHtml(section, { id: nextSectionId(analysis, section?.heading, taken), uses: analysis.uses, tableMarkup });
      if (!built.ok) return built;
      fragments.push(built.html); have.add(normHeading(section.heading));
    }
  }
  if (!fragments.length) return { ok: false, reason: 'already-satisfied', error: `Everything proposed already exists in ${filePath}: ${skipped.join('; ')}.` };

  const fragment = fragments.join('');
  const at = analysis.insertAt;
  insertions.push({ at, text: fragment });
  const newHtml = applyInsertions(html, insertions);
  const next = { ...post, [field]: post[field].map((b, i) => (i === blockIndex ? { ...b, html: newHtml } : b)) };
  const newContent = canonicalJson(next);
  const proof = verifyRichBlockEdit(file.content, newContent, { field, blockIndex, insertions });
  if (!proof.ok) return { ok: false, reason: 'invalid-edit', error: `Edit to ${filePath} failed the safety proof (${proof.error}), so it was refused.` };
  return {
    ok: true, filePath, oldContent: file.content, newContent,
    changedRegions: [{ field: `${field}[${blockIndex}].html@${at}`, markerName: 'AI-managed', before: '(none)', after: `${fragments.length} section(s): ${sections.map((s) => s.heading ?? s.question).filter((h) => !skipped.includes(h)).join(' | ')}${insertions.length > 1 ? ' (+ the site\'s own table rules added to the page\'s style)' : ''}` }],
    skippedExisting: skipped, renderMode: 'visible',
  };
}

export async function preview(site, draft) {
  const batchInfo = await getOrInitBatchBranch(site);
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  return computeChange(site, draft, getFileContent, batchInfo.exists ? batchInfo.branchName : baseBranch(site));
}

export async function apply(site, draft) {
  const batchInfo = await getOrInitBatchBranch(site);
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  const computed = await computeChange(site, draft, getFileContent, batchInfo.exists ? batchInfo.branchName : baseBranch(site));
  if (!computed.ok) return computed;
  return pushDraftBranch(site, draft, [{ path: computed.filePath, content: computed.newContent }], batchInfo);
}

async function pathFor(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  const config = resolveAdapter(site, page, draft.action_type);
  const k = keyFromPage(page, { ...config, shape: 'keyed-record' });
  return config?.contentFile && k.ok ? sub(config.contentFile, k.key) : null;
}

export async function mergeToStage(site, draft) {
  return openPrWithSnapshot(site, draft, await pathFor(site, draft));
}

export async function rollback(site, draft) {
  return rollbackFromSnapshot(site, draft, await pathFor(site, draft), 'portable-text-body');
}
