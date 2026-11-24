// The real article, in the real template. For a blog draft, this puts the draft's text into a live article page of the same site (its own header, fonts, spacing,
// footer) and takes pictures at desktop and phone width, so the reviewer approves what the page will look like, not a lookalike. Everything outside the article
// body is the site's own; if the render differs from the site's own articles (flat headings, odd spacing), the deviations come back with the pictures.
import { marked } from 'marked';
import { renderArticlePreview } from '../generators/lib/article-preview.js';
import { pickReferencePage } from '../generators/lib/newpage-render-gate.js';
import { getDesignProfile } from '../implementers/lib/design-drift.js';

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
