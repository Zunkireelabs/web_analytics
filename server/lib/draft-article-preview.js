// The real article, in the real template. For a blog draft, this puts the draft's text into a live article page of the same site (its own header, fonts, spacing,
// footer) and takes pictures at desktop and phone width, so the reviewer approves what the page will look like, not a lookalike. Everything outside the article
// body is the site's own; if the render differs from the site's own articles (flat headings, odd spacing), the deviations come back with the pictures.
import { marked } from 'marked';
import { renderArticlePreview } from '../generators/lib/article-preview.js';
import { pickReferencePage } from '../generators/lib/newpage-render-gate.js';
import { getDesignProfile } from '../implementers/lib/design-drift.js';
import { findUngroundedClaims } from '../generators/lib/claim-grounding-guard.js';
import { learnFaqDesign } from '../generators/lib/site-faq-learn.js';
import { getArticleShell, buildPreviewDocument, buildOptionDocument, blocksOf, readBlock, writeBlock, rewriteBlock } from './draft-live-preview.js';

// The draft kinds that are an article: the body is the sections the draft carries, in order.
export function articleHtmlFor(draft) {
  const c = draft?.content || {};
  if (draft?.action_type === 'blog-outline') {
    if (!c.title) return null;
    const secs = (c.sections || []).map((s) => `<h2>${esc(s.heading || '')}</h2>${String(s.body || '').split(/\n{2,}/).map((t) => t.trim()).filter(Boolean).map((t) => marked.parse(t, { async: false })).join('')}`).join('');
    const faq = c.suggestedFaqTopics?.length ? `<h2>Questions readers ask</h2>${c.suggestedFaqTopics.map((q) => `<h3>${esc(typeof q === 'string' ? q : q.question || q.topic || '')}</h3>`).join('')}` : '';
    return { title: c.title, html: secs + faq };
  }
  return null;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** @returns {Promise<{ok:true, shots:{viewport:string,width:number,height:number,png:string}[], referenceUrl:string, deviations:object[], matchesSiteDesign:boolean} | {ok:false, reason:string, error:string}>} png is base64 */
export async function previewDraftInSiteArticle(site, draft, { render = renderArticlePreview } = {}) {
  const article = articleHtmlFor(draft);
  if (!article) return { ok: false, reason: 'not-an-article', error: 'This kind of draft is not an article, so there is no article page to put it in.' };
  const profile = getDesignProfile(site);
  const referenceUrl = pickReferencePage(profile, 'inline-article', null, { pageType: 'blog-article' });
  if (!referenceUrl) return { ok: false, reason: 'no-reference-article', error: 'No article of this site has been captured yet, so there is nothing real to put the draft into. The design capture has to find one first.' };
  const r = await render({ referenceUrl, bodyHtml: article.html, title: article.title });
  if (!r.ok) return { ok: false, reason: r.reason || 'render-failed', error: r.error || 'The preview could not be drawn.' };
  if (r.skip) return { ok: false, reason: r.reason, error: 'The reference article has no body region the draft can be placed into.' };
  return { ok: true, referenceUrl, deviations: r.deviations, matchesSiteDesign: r.matchesSiteDesign, shots: r.shots.map((s) => ({ viewport: s.viewport, width: s.width, height: s.height, png: Buffer.from(s.png).toString('base64') })) };
}

// ---- A blog OPTION (before any draft exists) in the site's real article page -------------------------------------------------------
// The approval screen offers three structures for a blog idea. Each is drawn into a real article of the same site (its own header, fonts, spacing and
// footer), with the idea's own title, so the client sees the site's design and not a generic sketch. The wording of the body is sample text; the structure
// is what differs between the options.
const SAMPLE = 'A short, useful paragraph that answers the point directly and links to the next step.';
export function optionArticleFor(optionKey, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!t || !['A', 'B', 'C'].includes(optionKey)) return null;
  let html;
  if (optionKey === 'A') html = `<p>An introduction to what this guide covers and who it is for.</p><h2>Why it matters</h2><p>${SAMPLE}</p><h2>How to start</h2><p>${SAMPLE}</p>`;
  else if (optionKey === 'B') html = `<p><strong>Short answer.</strong> A direct answer to the question in the title, in plain words, with a clear next step.</p><h2>The detail</h2><p>${SAMPLE}</p>`;
  else html = ['How long does it take?', 'Do I need to change my website?', 'What does it cost?'].map((q) => `<h3>${esc(q)}</h3><p>A direct answer in two or three sentences.</p>`).join('');
  return { title: t, html };
}

// A landing page or a translation option, drawn the same way: into ONE real captured page of the site's own template (a landing page for landing options;
// the page being translated for translation options), with only the content swapped in.
export function optionPageFor(generatorId, optionKey, title) {
  if (generatorId === 'blog-outline') return optionArticleFor(optionKey, title);
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!t || !['A', 'B', 'C'].includes(optionKey)) return null;
  const benefits = ['Clear answers', 'Found in search', 'Easy to act on'].map((b) => `<h3>${esc(b)}</h3><p>Plain wording that says what you do and who it is for.</p>`).join('');
  if (generatorId === 'landing-page') {
    const html = optionKey === 'A' ? `<p>What we do, who it is for, and how it works.</p>${benefits}`
      : optionKey === 'B' ? `<p>Tell us what you need and we will reply the same day.</p><h2>Send an enquiry</h2><p>Your name, your email, and one line about what you need.</p>${benefits}`
        : '<h2>What our clients say</h2><blockquote><p>“They made our site easy to find.”</p></blockquote><blockquote><p>“Clear, fast and honest work.”</p></blockquote>';
    return { title: t, html };
  }
  if (generatorId === 'translation') {
    const html = optionKey === 'A' ? '<p>Construimos sistemas de IA de nivel de infraestructura para empresas modernas.</p>'
      : optionKey === 'B' ? '<p>Construimos sistemas de inteligencia artificial de nivel de infraestructura para empresas modernas, desde el primer día y con todo el detalle.</p>'
        : '<p>Sistemas de IA para empresas modernas.</p>';
    return { title: t, html };
  }
  return null;
}

const optionCache = new Map(); // site|option|title -> { at, result }; a render opens a real browser, so a repeat look is free for a while
const OPTION_TTL_MS = 30 * 60_000;
const OPTION_CACHE_MAX = 60;

/** Same result shape as previewDraftInSiteArticle. Only a successful drawing is cached. `pageUrl` is the page the idea is about (a translation is drawn in that page). */
export async function previewOptionInSiteTemplate(site, { generatorId = 'blog-outline', optionKey, title, pageUrl = null } = {}, { render = renderArticlePreview, now = Date.now } = {}) {
  const article = optionPageFor(generatorId, optionKey, title);
  if (!article) return { ok: false, reason: 'not-an-article', error: 'There is no option or title to draw.' };
  const key = `${site?.id}|${generatorId}|${optionKey}|${article.title}|${pageUrl || ''}`;
  const hit = optionCache.get(key);
  if (hit && now() - hit.at < OPTION_TTL_MS) return hit.result;
  const profile = getDesignProfile(site);
  const referenceUrl = generatorId === 'blog-outline'
    ? pickReferencePage(profile, 'inline-article', null, { pageType: 'blog-article' })
    : pickReferencePage(profile, 'section-page', pageUrl, { pageType: generatorId === 'landing-page' ? 'landing' : null });
  if (!referenceUrl) return { ok: false, reason: 'no-reference-article', error: 'No matching page of this site has been captured yet, so there is nothing real to draw this in. The design capture has to find one first.' };
  const r = await render({ referenceUrl, bodyHtml: article.html, title: article.title });
  if (!r.ok) return { ok: false, reason: r.reason || 'render-failed', error: r.error || 'The preview could not be drawn.' };
  if (r.skip) return { ok: false, reason: r.reason, error: 'The site\'s page has no body region this can be placed into.' };
  const result = { ok: true, referenceUrl, deviations: r.deviations, matchesSiteDesign: r.matchesSiteDesign, shots: r.shots.map((x) => ({ viewport: x.viewport, width: x.width, height: x.height, png: Buffer.from(x.png).toString('base64') })) };
  if (optionCache.size >= OPTION_CACHE_MAX) optionCache.delete(optionCache.keys().next().value);
  optionCache.set(key, { at: now(), result });
  return result;
}
export const previewBlogOptionInSiteArticle = (site, optionKey, title, deps) => previewOptionInSiteTemplate(site, { generatorId: 'blog-outline', optionKey, title }, deps);
export const clearOptionPreviewCacheForTests = () => optionCache.clear();

// ---- The LIVE preview and the edit of one block (lib/draft-live-preview.js) -------------------------------------------------------------------------------------
// The site's article page is captured once and kept for hours; a preview is then the draft's body put into that capture, so it takes milliseconds, not a browser run.
// The statuses a person may still change a draft in: the same ones the save itself (store/drafts.js updateDraftContentInPlace) accepts. A draft sent back for changes is the one most in need of an edit.
// How long a person waits for the writer on one change. The browser gives up at 5 minutes, so the server must answer (or say it could not) well before that.
export const INTERACTIVE_WAIT_MS = 100_000;
export const EDITABLE_STATUSES = ['draft', 'edited', 'submitted_for_approval', 'revision_requested'];

export async function previewDraftLive(site, draft, { getShell = getArticleShell } = {}) {
  if (draft?.action_type !== 'blog-outline' || !draft?.content?.title) return { ok: false, reason: 'not-an-article', error: 'This kind of draft is not an article, so there is no article page to put it in.' };
  const profile = getDesignProfile(site);
  const referenceUrl = pickReferencePage(profile, 'inline-article', null, { pageType: 'blog-article' });
  if (!referenceUrl) return { ok: false, reason: 'no-reference-article', error: 'No article of this site has been captured yet, so there is nothing real to put the draft into.' };
  const shell = await getShell(site.id, referenceUrl, { faqFallback: () => learnFaqDesign(site) });
  if (!shell?.ok) return { ok: false, reason: shell?.reason || 'render-failed', error: shell?.error || 'The site\'s article page could not be captured.' };
  const doc = buildPreviewDocument(draft.content, shell);
  if (!doc.ok) return doc;
  const editable = EDITABLE_STATUSES.includes(draft.status);
  return { ok: true, html: doc.html, referenceUrl, editable, blocks: blocksOf(draft.content) };
}

/** `{ blockId, instruction }` (rewritten by the Claude worker) or `{ blockId, value }` (typed by the person). Saved only if the Quality Gate passes. */
export async function editDraftBlock(site, draft, { blockId, instruction, value, selected } = {}, { runGate, save, callJson = null } = {}) {
  if (draft?.action_type !== 'blog-outline') return { ok: false, status: 422, reason: 'not-an-article', error: 'Only blog posts can be edited here.' };
  if (!EDITABLE_STATUSES.includes(draft.status)) return { ok: false, status: 409, reason: 'not-editable', error: 'This draft has already been approved or shipped, so it cannot be edited here.' };
  const block = readBlock(draft.content, blockId);
  if (!block) return { ok: false, status: 404, reason: 'no-such-block', error: 'That part of the post was not found.' };
  if (!block.editable) return { ok: false, status: 400, reason: 'not-editable-block', error: 'This part cannot be edited here. The sources are verified links; ask the team to change them.' };
  try {
    let nextValue = value;
    if (nextValue === undefined) {
      if (!String(instruction || '').trim()) return { ok: false, status: 400, reason: 'no-instruction', error: 'Tell us what to change, or type the new text.' };
      const call = callJson || (async (system, user, opts) => (await import('../llm.js')).callLLMForJson(system, user, { ...opts, task: 'content', generatorId: 'draft-edit', workerWaitMs: INTERACTIVE_WAIT_MS, retry: false, siteId: site.id }));
      nextValue = await rewriteBlock({ block, instruction: String(instruction).slice(0, 1000), topic: draft.content?.topic || draft.content?.title || '', selected: String(selected || '').replace(/\s+/g, ' ').trim().slice(0, 300), callJson: call });
    }
    if (value === undefined && JSON.stringify(nextValue) === JSON.stringify(block.value)) return { ok: false, status: 422, reason: 'no-change', error: 'The writer did not change anything. Say what you want, for example “make this shorter” or “use a friendlier tone”.' };
    const content = writeBlock(draft.content, blockId, nextValue);
    // Only a problem THIS change introduces blocks it. A draft can already carry problems (a long title, a missing cover, a statistic still waiting for a source): they were there
    // before the edit and are not the editor's to fix here, so they must not stop an unrelated change.
    const issueKey = (i) => `${i.patternId}|${i.path || ''}|${String(i.snippet || i.detail || '').slice(0, 120)}`;
    const before = await runGate(draft.content).catch(() => ({ issues: [] }));
    const existing = new Set((before.issues || []).map(issueKey));
    const gate = await runGate(content);
    const fresh = (gate.issues || []).filter((i) => !existing.has(issueKey(i)));
    // The Quality Gate does not look at the short answer or the FAQ for numbers that nothing supports, but a person can type one there. The text just written gets the same check.
    if (block.kind === 'quick' || block.kind === 'faq') {
      const written = block.kind === 'quick' ? String(nextValue) : `${nextValue.question}\n${nextValue.answer}`;
      const was = block.kind === 'quick' ? String(block.value ?? '') : `${block.value?.question ?? ''}\n${block.value?.answer ?? ''}`;
      const grounding = draft.content?.groundingContext || '';
      // Only a claim this change introduces blocks it; one already in the old text was there before and is not the editor's to fix.
      const claimKey = (i) => `${i.patternId}|${String(i.snippet || i.detail || '').slice(0, 120)}`;
      const old = new Set(findUngroundedClaims({ sections: [{ heading: '', body: was }], groundingContext: grounding }).map(claimKey));
      for (const i of findUngroundedClaims({ sections: [{ heading: '', body: written }], groundingContext: grounding })) if (!old.has(claimKey(i))) fresh.push(i);
    }
    if (fresh.length) return { ok: false, status: 422, reason: 'quality-gate', error: 'That change did not pass the checks every post must pass, so it was not saved.', issues: fresh.map((i) => ({ rule: i.patternId, detail: i.detail || i.snippet || '' })) };
    const saved = await save(content);
    // A save that matched no row (the draft moved on while the person was editing) is a failure, never a success with nothing saved.
    if (!saved) return { ok: false, status: 409, reason: 'not-saved', error: 'This draft changed (approved, sent back or removed) while you were editing, so nothing was saved. Reload and look at it again.' };
    return { ok: true, draft: saved, blocks: blocksOf(content), changed: blockId };
  } catch (err) {
    if (err.status === 400) return { ok: false, status: 400, reason: 'bad-edit', error: err.message };
    if (err.workerUnavailable || err.llmProvider) return { ok: false, status: 503, reason: 'ai-unavailable', error: 'The writing assistant is not available right now (the Claude worker is offline). Try again in a few minutes, or type the new text yourself.' };
    throw err;
  }
}

/** An idea's option (blog / landing page / translation) drawn in the site's real page: the same captured page a draft uses, so it opens in milliseconds, not a browser run. */
export async function previewOptionLive(site, { generatorId = 'blog-outline', optionKey, title, pageUrl = null } = {}, { getShell = getArticleShell } = {}) {
  const article = optionPageFor(generatorId, optionKey, title);
  if (!article) return { ok: false, reason: 'not-an-article', error: 'There is no option or title to draw.' };
  const profile = getDesignProfile(site);
  const referenceUrl = generatorId === 'blog-outline'
    ? pickReferencePage(profile, 'inline-article', null, { pageType: 'blog-article' })
    : pickReferencePage(profile, 'section-page', pageUrl, { pageType: generatorId === 'landing-page' ? 'landing' : null });
  if (!referenceUrl) return { ok: false, reason: 'no-reference-article', error: 'No matching page of this site has been captured yet, so there is nothing real to draw this in. The design agent captures it automatically.' };
  const shell = await getShell(site.id, referenceUrl, { faqFallback: () => learnFaqDesign(site) });
  if (!shell?.ok) return { ok: false, reason: shell?.reason || 'render-failed', error: shell?.error || 'The site\'s page could not be captured.' };
  const doc = buildOptionDocument({ bodyHtml: article.html, title: article.title }, shell);
  if (!doc.ok) return doc;
  return { ok: true, html: doc.html, referenceUrl, parts: doc.parts };
}
