// A LIVE, CLICKABLE preview of a blog draft inside the site's real article page, and the edit of one block of it.
//
// The old preview was two screenshots drawn by a server-side browser on every click. This captures the site's article page ONCE (its real markup and stylesheets, with
// the article body left as a hole), keeps that capture for hours, and fills the hole with the draft's own body, so a preview is a string substitution (milliseconds), not a
// browser run. What is shown is the whole post as it reads: the short answer, every section, the table, the FAQ in the site's own FAQ design (learned from the real
// article's FAQ block), and the sources. The header, related articles, call to action and footer are the site's own, untouched.
//
// Every part of the draft is a "block" (data-block-id): clicking one tells the dashboard which block, the dashboard opens a side box, and the person either types what to
// change (the Claude worker rewrites just that block) or edits the text directly. The change goes through the same quality gate as generation before it is saved.
import * as cheerio from 'cheerio';
import { marked } from 'marked';
import { faqBlockTemplate } from '../generators/lib/html-faq-learn.js';
import { learnFaqDesign } from '../generators/lib/site-faq-learn.js';

const SHELL_TTL_MS = 6 * 60 * 60 * 1000;
const SETTLE_MS = 3000;
const FONT_BUDGET_BYTES = 1_500_000; // the fonts embedded in a captured page, in total
const shellCache = new Map(); // `${siteId}:${referenceUrl}` -> { at, promise }
export const clearShellCache = () => shellCache.clear();

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
// The draft's text drawn for the PREVIEW: markdown to HTML, then anything that runs or navigates is taken out (scripts, frames, event handlers, javascript: links). The preview already sits in a
// sandboxed frame, but a draft written by an AI or typed by a person must not carry live code into any page that draws it.
const md = (t) => {
  const html = marked.parse(String(t || ''), { async: false });
  if (!/<\s*(script|iframe|object|embed)|\son\w+\s*=|javascript:/i.test(html)) return html;
  const $ = cheerio.load(`<div id="__md__">${html}</div>`, null, false);
  $('script, iframe, object, embed').remove();
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      if (/^on/i.test(name)) $(el).removeAttr(name);
      else if (/^(href|src|xlink:href|action|formaction)$/i.test(name) && /^\s*javascript:/i.test(el.attribs[name])) $(el).removeAttr(name);
    }
  });
  return $('#__md__').html();
};
const CLASSED_TAGS = ['h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'blockquote', 'a', 'strong', 'table', 'thead', 'th', 'td', 'img'];

// ---- Capturing the site's article page, once -------------------------------------------------------------------------------------------------------------------
/* eslint-disable no-undef */
/** Runs in the page, after the body region has been marked. Returns the page with the body region emptied to a hole, and what the region's own elements look like. */
export function captureInPage(classedTags) {
  const region = document.querySelector('[data-gate-region]');
  if (!region) return null;
  const classFor = {};
  for (const tag of classedTags) {
    const pool = [...region.querySelectorAll(tag)].filter((el) => (String(el.className || '').trim() || el.getAttribute('style')) && (tag !== 'p' || (el.textContent || '').trim().length > 40));
    if (pool.length) classFor[tag] = { cls: String(pool[0].className || '').trim(), style: pool[0].getAttribute('style') || '' };
  }
  const refTitle = String((document.querySelector('h1') || {}).textContent || '').trim();
  const regionHtml = region.innerHTML;
  region.removeAttribute('data-gate-region');
  region.innerHTML = '<div id="__draft_body__"></div>';
  // A static picture of the page: scripts would re-run the site's own rendering over the draft.
  document.querySelectorAll('script, noscript').forEach((el) => el.remove());
  const base = document.createElement('base');
  base.href = location.href;
  document.head.insertBefore(base, document.head.firstChild);
  return { shellHtml: `<!DOCTYPE html>${document.documentElement.outerHTML}`, regionHtml, classFor, refTitle };
}

/** Runs in the page BEFORE anything is changed: the page's own @font-face files, fetched from the site and returned as embedded (data:) fonts. A preview shown inside the dashboard
 * is not on the site's own address, and a site's font files are usually not served to other addresses, so without this the draft is drawn in a fallback font. */
export async function inlineFontsInPage({ maxBytes }) {
  const out = []; const seen = new Set(); let total = 0;
  const toDataUri = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); // a font host that stalls must not hold the whole capture
    if (!r.ok) return null;
    const b = await r.blob();
    if (total + b.size > maxBytes) return null;
    total += b.size;
    return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
  };
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; } // another site's stylesheet (Google Fonts, ...) is not readable here and serves its fonts to anyone
    for (const rule of rules) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
      const st = rule.style;
      const urls = [...String(st.getPropertyValue('src')).matchAll(/url\((["']?)(.*?)\1\)\s*(?:format\((["']?)(.*?)\3\))?/g)];
      const pick = urls.find((m) => /woff2/i.test(`${m[4] || ''}${m[2]}`)) || urls.find((m) => /woff/i.test(`${m[4] || ''}${m[2]}`)) || urls[0];
      if (!pick || pick[2].startsWith('data:')) continue;
      let abs; try { abs = new URL(pick[2], sheet.href || location.href).href; } catch { continue; }
      if (seen.has(abs)) continue;
      seen.add(abs);
      const data = await toDataUri(abs).catch(() => null);
      if (!data) continue;
      out.push(`@font-face{font-family:${st.getPropertyValue('font-family')};font-style:${st.getPropertyValue('font-style') || 'normal'};font-weight:${st.getPropertyValue('font-weight') || '400'};${st.getPropertyValue('unicode-range') ? `unicode-range:${st.getPropertyValue('unicode-range')};` : ''}src:url(${data});}`);
    }
  }
  return out.join('\n');
}
/* eslint-enable no-undef */

/** Loads a real article of the site in a browser, marks its body region, and returns { shellHtml, regionHtml, classFor, faq }. Needs a browser: callers cache it. */
export async function captureArticleShell({ referenceUrl, launchBrowserFn = null, navTimeoutMs = 20000, faqFallback = null }) {
  const { measureBodyInPage } = await import('../design-agent/live-analysis/body-measure.js');
  const { launchBrowser, DESKTOP_VIEWPORT } = await import('../design-agent/live-analysis/capture.js');
  // Every step that talks to a browser or a site is bounded: a hung launch, font host or evaluate must end as "unreachable", never hold the request (and the cache entry other callers share) open.
  const bounded = (promise, ms, what) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms))]);
  let browser;
  try { browser = await bounded((launchBrowserFn || launchBrowser)(), 30000, 'Starting the browser'); } catch (err) { return { ok: false, reason: 'unreachable', error: err.message }; }
  try {
    const context = await browser.newContext({ viewport: { width: DESKTOP_VIEWPORT.width, height: DESKTOP_VIEWPORT.height } });
    const page = await context.newPage();
    // The page's own markup is enough: wait for it to load, then give the network a few seconds to settle, never the 25 seconds (twice) a site that never goes quiet used to cost.
    await page.goto(referenceUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
    const found = await bounded(page.evaluate(measureBodyInPage, true), 15000, 'Reading the page');
    if (!found?.found) return { ok: false, reason: 'no-body-region-on-reference', error: 'The reference article has no body region the draft can be placed into.' };
    const fontCss = await bounded(page.evaluate(inlineFontsInPage, { maxBytes: FONT_BUDGET_BYTES }), 25000, 'Reading the fonts').catch(() => '');
    const shell = await bounded(page.evaluate(captureInPage, CLASSED_TAGS), 15000, 'Capturing the page');
    if (!shell) return { ok: false, reason: 'no-body-region-on-reference', error: 'The reference article has no body region the draft can be placed into.' };
    const faq = faqBlockTemplate(shell.regionHtml) || (faqFallback ? await faqFallback().catch(() => null) : null);
    return { ok: true, referenceUrl, shellHtml: fontCss ? shell.shellHtml.replace('</head>', `<style id="__inlined_fonts__">${fontCss}</style></head>`) : shell.shellHtml, fonts: fontCss ? fontCss.split('@font-face').length - 1 : 0, refTitle: shell.refTitle || '', classFor: shell.classFor, faq };
  } catch (err) {
    return { ok: false, reason: 'unreachable', error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** The capture for a site's reference article, kept for hours and shared by concurrent callers. A failed capture is never kept. `force` re-captures: the capture it replaces keeps
 * being served until the new one has succeeded, and a failed refresh leaves it in place. */
export function getArticleShell(siteId, referenceUrl, { capture = captureArticleShell, now = Date.now(), force = false, faqFallback = null } = {}) {
  const key = `${siteId}:${referenceUrl}`;
  const hit = shellCache.get(key);
  if (!force && hit && now - hit.at < SHELL_TTL_MS) return hit.promise;
  const promise = Promise.resolve(capture({ referenceUrl, faqFallback }));
  const entry = { at: now, promise };
  if (!(force && hit)) shellCache.set(key, entry);
  return promise.then((r) => {
    if (r?.ok) { shellCache.set(key, { at: now, promise: Promise.resolve(r) }); return r; }
    if (shellCache.get(key) === entry) shellCache.delete(key);
    return force && hit ? hit.promise : r;
  }, (e) => {
    if (shellCache.get(key) === entry) shellCache.delete(key);
    if (force && hit) return hit.promise;
    throw e;
  });
}

/** The captured pages a site's previews use: a real article (blog drafts and ideas) and a real section page (landing and translation ideas). */
export function referenceUrlsFor(profile, pick) {
  const urls = [pick(profile, 'inline-article', null, { pageType: 'blog-article' }), pick(profile, 'section-page', null, { pageType: 'landing' })];
  return [...new Set(urls.filter(Boolean))];
}

/** Captures every given site's reference pages ahead of time, one after another, so the first person to open a preview never waits for a browser. Never throws. */
export async function warmArticleShells(sites, { getProfile, pick, getShell = getArticleShell, force = false, log = console } = {}) {
  const done = []; 
  for (const site of sites) {
    let urls = [];
    try { urls = referenceUrlsFor(getProfile(site), pick); } catch { urls = []; }
    for (const url of urls) {
      const t = Date.now();
      try {
        const r = await getShell(site.id, url, { force, faqFallback: () => learnFaqDesign(site) });
        done.push({ siteId: site.id, url, ok: Boolean(r?.ok), secs: Math.round((Date.now() - t) / 1000) });
      } catch (err) { done.push({ siteId: site.id, url, ok: false, error: err.message }); }
    }
  }
  log.log?.(`[preview-warm] ${done.filter((d) => d.ok).length}/${done.length} pages captured: ${done.map((d) => `${d.siteId}:${d.ok ? `${d.secs}s` : 'failed'}`).join(' ')}`);
  return done;
}

// ---- The draft as blocks ---------------------------------------------------------------------------------------------------------------------------------------
const sectionBody = (s) => String(s?.body || '');

/** The editable parts of a blog draft, in reading order: { id, kind, label, value, editable }. `value` is what the side box shows and edits. */
export function blocksOf(content) {
  const c = content || {};
  const out = [];
  if (typeof c.quickAnswer === 'string' && c.quickAnswer.trim()) out.push({ id: 'quick', kind: 'quick', label: 'Short answer', value: c.quickAnswer, editable: true });
  (c.sections || []).forEach((s, i) => {
    if (!s?.heading && !s?.body) return;
    out.push({ id: `s:${i}`, kind: 'section', label: s.heading ? `Section: ${s.heading}` : `Section ${i + 1}`, value: { heading: s.heading || '', body: sectionBody(s) }, editable: true });
  });
  (c.faqItems || []).forEach((f, i) => {
    if (!f?.question) return;
    out.push({ id: `faq:${i}`, kind: 'faq', label: `FAQ: ${f.question}`, value: { question: f.question, answer: f.answer || '' }, editable: true });
  });
  const sources = (c.sources || []).filter((x) => x?.label && /^https:\/\//.test(x.url || ''));
  if (sources.length) out.push({ id: 'sources', kind: 'sources', label: 'Sources', value: sources, editable: false });
  return out;
}

const wrap = (id, kind, inner, extra = '') => `<div data-block-id="${esc(id)}" data-block-kind="${kind}"${extra}>${inner}</div>`;

/** The draft's body as HTML in the site's own markup: classes copied from the real article's own elements, the FAQ in the site's learned FAQ design. */
export function renderBodyHtml(content, shell) {
  const blocks = blocksOf(content);
  const parts = [];
  let faqRows = [];
  const faqRow = (b) => {
    const { question, answer } = b.value;
    if (shell?.faq?.row) return `<div data-block-id="${esc(b.id)}" data-block-kind="faq" style="display:contents">${shell.faq.row.replace('{{QUESTION}}', esc(question)).replace('{{ANSWER}}', esc(answer))}</div>`;
    return wrap(b.id, 'faq', `<h3>${esc(question)}</h3><p>${esc(answer)}</p>`);
  };
  const flushFaq = () => {
    if (!faqRows.length) return;
    // The learned FAQ design is the site's own markup, class for class: it is marked native so no other class is added inside it.
    parts.push(shell?.faq?.wrapper ? `<div data-native="1" style="display:contents">${shell.faq.wrapper.replace('{{ROWS}}', faqRows.join(''))}</div>` : `<h2>Frequently asked questions</h2>${faqRows.join('')}`);
    faqRows = [];
  };
  for (const b of blocks) {
    if (b.kind === 'quick') parts.push(wrap(b.id, 'quick', `<p>${esc(b.value)}</p>`, ' style="border-left:4px solid currentColor;padding:4px 0 4px 16px;margin:0 0 28px"'));
    else if (b.kind === 'section') parts.push(wrap(b.id, 'section', `${b.value.heading ? `<h2>${esc(b.value.heading)}</h2>` : ''}${md(b.value.body)}`));
    else if (b.kind === 'faq') faqRows.push(faqRow(b));
    else if (b.kind === 'sources') {
      flushFaq();
      parts.push(wrap(b.id, 'sources', `<h2>Sources</h2><ul>${b.value.map((s) => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.label)}</a></li>`).join('')}</ul>`));
    }
  }
  flushFaq();
  return applySiteClasses(parts.join(''), shell);
}

/** The site's own element classes, on the elements of this HTML that carry none (never overriding a class already there, never inside a native FAQ). */
export function applySiteClasses(html, shell) {
  const $ = cheerio.load(`<div id="__root__">${html}</div>`, null, false);
  for (const [tag, { cls, style }] of Object.entries(shell?.classFor || {})) {
    $('#__root__').find(tag).each((_, el) => {
      const $el = $(el);
      if ($el.closest('[data-native]').length) return;
      if (cls && !String($el.attr('class') || '').trim()) $el.attr('class', cls);
      if (style && !$el.attr('style')) $el.attr('style', style);
    });
  }
  return $('#__root__').html();
}

// What runs inside the preview: outline the block under the pointer, and tell the dashboard which block was clicked. No navigation happens inside the preview.
const PREVIEW_SCRIPT = `(function(){
var ov=document.createElement('div');ov.setAttribute('data-preview-overlay','1');ov.style.cssText='position:absolute;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.08);border-radius:4px;z-index:2147483647;display:none';
document.body.appendChild(ov);var sel=null;var SM=document.body.hasAttribute('data-select-mode');
function rectOf(b){var els=b.style&&b.style.display==='contents'?Array.prototype.slice.call(b.children):[b];var l=1e9,t=1e9,r=-1,bt=-1;els.forEach(function(e){var x=e.getBoundingClientRect();if(!x.width&&!x.height)return;l=Math.min(l,x.left);t=Math.min(t,x.top);r=Math.max(r,x.right);bt=Math.max(bt,x.bottom);});return r<0?null:{left:l+window.scrollX,top:t+window.scrollY,width:r-l,height:bt-t};}
function box(b,strong){var x=rectOf(b);if(!x){ov.style.display='none';return;}ov.style.display='block';ov.style.left=x.left-4+'px';ov.style.top=x.top-4+'px';ov.style.width=x.width+8+'px';ov.style.height=x.height+8+'px';ov.style.background=strong?'rgba(37,99,235,.14)':'rgba(37,99,235,.08)';}
function height(){parent.postMessage({type:'preview-height',height:Math.max(document.documentElement.scrollHeight,document.body.scrollHeight)},'*');}
function report(b){parent.postMessage({type:'draft-block-click',id:b.getAttribute('data-block-id'),rect:rectOf(b)},'*');}
document.addEventListener('mouseover',function(e){if(SM)return;var b=e.target.closest&&e.target.closest('[data-block-id]');if(b)box(b,false);else if(sel)box(sel,true);else ov.style.display='none';});
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(SM){if(a)e.preventDefault();return;}var b=e.target.closest&&e.target.closest('[data-block-id]');if(a||b)e.preventDefault();if(!b){sel=null;ov.style.display='none';parent.postMessage({type:'draft-block-clear'},'*');return;}e.stopPropagation();sel=b;box(b,true);report(b);},true);
if(SM){document.addEventListener('mouseup',function(){setTimeout(function(){var s=window.getSelection();if(s&&s.rangeCount&&!s.isCollapsed){var rg=s.getRangeAt(0),sc=rg.startContainer,so=rg.startOffset,ec=rg.endContainer,eo=rg.endOffset;function wc(c){return !!c&&(c.toLowerCase()!==c.toUpperCase()||/[0-9]/.test(c));}if(sc.nodeType===3){while(so>0&&wc(sc.data.charAt(so-1)))so--;}if(ec.nodeType===3){while(eo<ec.data.length&&wc(ec.data.charAt(eo)))eo++;}try{rg.setStart(sc,so);rg.setEnd(ec,eo);s.removeAllRanges();s.addRange(rg);}catch(x){}}var t=s?String(s).replace(/\\s+/g,' ').trim():'';if(!t||t.length<2||!s.rangeCount)return;var r=s.getRangeAt(0).getBoundingClientRect();var n=s.anchorNode&&(s.anchorNode.nodeType===1?s.anchorNode:s.anchorNode.parentElement);var b=n&&n.closest&&n.closest('[data-block-id]');parent.postMessage({type:'draft-text-select',text:t.slice(0,300),blockId:b?b.getAttribute('data-block-id'):null,rect:{left:r.left+window.scrollX,top:r.top+window.scrollY,width:r.width,height:r.height}},'*');},0);});document.addEventListener('mousedown',function(){parent.postMessage({type:'draft-text-clear'},'*');});}
window.addEventListener('message',function(e){var d=e.data;if(d&&d.type==='clear-text'){var gs=window.getSelection();if(gs)gs.removeAllRanges();}if(d&&d.type==='select-block'){var b=document.querySelector('[data-block-id="'+String(d.id).replace(/"/g,'')+'"]');if(b){sel=b;box(b,true);report(b);}}if(d&&d.type==='clear-block'){sel=null;ov.style.display='none';}});
window.addEventListener('load',function(){height();setTimeout(height,700);setTimeout(height,2000);});window.addEventListener('resize',height);
if(window.ResizeObserver){new ResizeObserver(height).observe(document.body);}
})();`;


/** The reference article's own subtitle and cover image sit above the body: they are NOT the draft's. The subtitle becomes the draft's description, the cover the draft's own
 * image (or nothing when the draft has none), so a preview never shows another post's picture or lead-in as if it were this one's. */
export function personalizeHero($, content, shell) {
  const h1 = $('h1').first()[0];
  const hole = $('#__draft_body__')[0];
  if (!h1 || !hole) return;
  const all = $('*').toArray();
  const from = all.indexOf(h1); const to = all.indexOf(hole);
  if (from < 0 || to <= from) return;
  const between = all.slice(from + 1, to);
  const ledeEl = between.find((el) => el.name === 'p' && $(el).text().trim().length > 20);
  const text = content?.metaDescription || content?.quickAnswer || '';
  if (ledeEl) { if (text) $(ledeEl).text(text); else $(ledeEl).remove(); }
  // The reference article's own title also appears elsewhere (the breadcrumb, the page header): put the draft's title there too.
  const refTitle = String(shell?.refTitle || '').trim().toLowerCase();
  if (refTitle && content?.title) {
    $('*').contents().each((_, node) => { if (node.type === 'text' && String(node.data || '').trim().toLowerCase() === refTitle) node.data = content.title; });
  }
  // A cover drawn as a box with an inline SVG or a background (SuperRank's `.post__cover`) rather than an image tag: the box is the draft's cover (or hidden when it has none).
  const coverBox = between.find((el) => /(^|[\s_-])(cover|featured-image|hero-image|post-image|article-image)(\s|$|_|-)/i.test(String(el.attribs?.class || '')));
  if (coverBox) {
    const coverUrl = content?.featuredImage?.url;
    if (!coverUrl) { $(coverBox).attr('style', 'display:none'); return; }
    let absCover = coverUrl; try { absCover = new URL(coverUrl, shell?.referenceUrl || undefined).href; } catch { /* keep as given */ }
    $(coverBox).empty().append(`<img src="${absCover.replace(/"/g, '&quot;')}" alt="${String(content.featuredImage.alt || '').replace(/"/g, '&quot;')}" style="width:100%;height:auto;display:block">`);
    return;
  }
  const img = between.find((el) => el.name === 'img');
  if (!img) return;
  const $img = $(img);
  const url = content?.featuredImage?.url;
  const picture = $img.closest('picture');
  picture.find('source').remove();
  if (!url) { ($img.parent().is('picture') ? picture : $img).attr('style', 'display:none'); return; }
  let abs = url; try { abs = new URL(url, shell?.referenceUrl || undefined).href; } catch { /* keep as given */ }
  $img.attr('src', abs).removeAttr('srcset').removeAttr('sizes').removeAttr('loading');
  if (content.featuredImage.alt) $img.attr('alt', content.featuredImage.alt);
}


const partLabel = (tag, text) => {
  const t = text.length > 56 ? `${text.slice(0, 55)}…` : text;
  if (/^h[1-6]$/.test(tag)) return t;
  if (tag === 'p') return `Paragraph: ${t}`;
  if (tag === 'ul' || tag === 'ol') return `List: ${t}`;
  if (tag === 'table') return 'Table';
  if (tag === 'blockquote') return `Quote: ${t}`;
  return t;
};

/** A blog / landing / translation OPTION (an idea, before any draft exists): its sample body in the site's real page, the same captured page a draft uses. Every top-level part carries an id,
 * so a person can click a part and say what to change; `parts` lists them for the dashboard. */
export function buildOptionDocument({ bodyHtml, title }, shell) {
  const $ = cheerio.load(shell.shellHtml);
  if ($('#__draft_body__').length === 0) return { ok: false, reason: 'no-body-region-on-reference', error: 'The captured page has no place for the body.' };
  $('link[rel~="stylesheet"]').removeAttr('crossorigin').removeAttr('integrity');
  personalizeHero($, { title }, shell);
  const $b = cheerio.load(`<div id="__r__">${bodyHtml}</div>`, null, false);
  const parts = [];
  $b('#__r__').children().each((_, el) => {
    const text = $b(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const id = `part:${parts.length}`;
    $b(el).attr('data-block-id', id).attr('data-block-kind', 'part');
    parts.push({ id, label: partLabel(el.name, text), text: text.slice(0, 300) });
  });
  $('#__draft_body__').replaceWith(applySiteClasses($b('#__r__').html(), shell));
  if (title) { $('h1').first().text(title); $('title').first().text(title); }
  $('body').attr('data-select-mode', '1').append(`<script>${PREVIEW_SCRIPT}</script>`);
  return { ok: true, html: $.html(), parts };
}

/** The full page to put in an iframe: the site's real article page with the draft's body (and title) in place. */
export function buildPreviewDocument(content, shell) {
  const $ = cheerio.load(shell.shellHtml);
  const title = content?.title || '';
  if ($('#__draft_body__').length === 0) return { ok: false, reason: 'no-body-region-on-reference', error: 'The captured article has no place for the draft body.' };
  // A stylesheet marked `crossorigin` (or with an integrity hash) is refused when the page is shown inside the dashboard's frame, and the whole page then draws unstyled.
  $('link[rel~="stylesheet"]').removeAttr('crossorigin').removeAttr('integrity');
  personalizeHero($, content, shell);
  $('#__draft_body__').replaceWith(renderBodyHtml(content, shell));
  if (title) { $('h1').first().text(title); $('title').first().text(title); }
  $('body').attr('data-select-mode', '1').append(`<script>${PREVIEW_SCRIPT}</script>`);
  return { ok: true, html: $.html() };
}

// ---- Editing one block -----------------------------------------------------------------------------------------------------------------------------------------
/** The block with this id in the content, or null. */
export function readBlock(content, id) { return blocksOf(content).find((b) => b.id === id) || null; }

const clean = (v) => String(v ?? '').trim();
const MAX_BLOCK_CHARS = 12000; // the same cap edit-content has for one field
// A value a person types must be the plain text it claims to be: a number, an object or an array would otherwise be saved as "[object Object]".
const text = (v, what) => {
  if (typeof v !== 'string') throw badEdit(`${what} must be text.`);
  if (v.length > MAX_BLOCK_CHARS) throw badEdit(`${what} is too long (${v.length.toLocaleString()} characters; the limit is ${MAX_BLOCK_CHARS.toLocaleString()}).`);
  return v;
};

/** The content with this block's value replaced. `value` is a string for the short answer, { heading, body } for a section, { question, answer } for a FAQ item. */
export function writeBlock(content, id, value) {
  const next = JSON.parse(JSON.stringify(content || {}));
  if (id === 'quick') { text(value, 'The short answer'); if (!clean(value)) throw badEdit('The short answer cannot be empty.'); next.quickAnswer = clean(value); return next; }
  const section = /^s:(\d+)$/.exec(id);
  if (section) {
    const i = Number(section[1]);
    if (!next.sections?.[i]) throw badEdit('That section no longer exists.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw badEdit('A section must be a heading and some text.');
    if (value.heading != null) text(value.heading, 'The heading'); text(value.body, 'The section text');
    if (!clean(value?.body)) throw badEdit('A section needs some text.');
    next.sections[i] = { ...next.sections[i], heading: clean(value.heading) || next.sections[i].heading, body: clean(value.body) };
    return next;
  }
  const faq = /^faq:(\d+)$/.exec(id);
  if (faq) {
    const i = Number(faq[1]);
    if (!next.faqItems?.[i]) throw badEdit('That question no longer exists.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw badEdit('A FAQ item must be a question and an answer.');
    text(value.question, 'The question'); text(value.answer, 'The answer');
    if (!clean(value?.question) || !clean(value?.answer)) throw badEdit('A FAQ item needs both a question and an answer.');
    next.faqItems[i] = { ...next.faqItems[i], question: clean(value.question), answer: clean(value.answer) };
    return next;
  }
  throw badEdit('That part of the post cannot be edited here.');
}
const badEdit = (message) => Object.assign(new Error(message), { status: 400 });

const SHAPES = { quick: '{"text": "the new short answer"}', section: '{"heading": "the section heading", "body": "the section text in markdown"}', faq: '{"question": "the question", "answer": "the answer"}' };

import { findSelected, replaceSelected, rewriteSelectedWords } from './selected-words.js';

/** The Claude worker rewrites ONE block as the person asked. Returns the new value for writeBlock. `callJson(system, user, opts)` is injected (callLLMForJson in production). */
export async function rewriteBlock({ block, instruction, topic = '', selected = '', callJson }) {
  // The person selected exact words: rewrite only those and put them back in the same place. Anything that cannot be found exactly once falls through to the whole-part rewrite below.
  const picked = String(selected || '').replace(/\s+/g, ' ').trim();
  if (picked) {
    const slots = block.kind === 'quick' ? [[null, block.value]] : block.kind === 'section' ? [['body', block.value.body], ['heading', block.value.heading]] : [['answer', block.value.answer], ['question', block.value.question]];
    const slot = slots.find(([, text]) => findSelected(text, picked));
    if (slot) {
      const words = await rewriteSelectedWords({ selected: picked, around: slot[1], instruction, topic, callJson });
      const next = replaceSelected(slot[1], picked, words);
      if (next != null) return slot[0] === null ? next : { ...block.value, [slot[0]]: next };
    }
  }
  const current = block.kind === 'quick' ? { text: block.value } : block.value;
  const system = 'You edit ONE part of a blog post for a company website, exactly as the editor asks. Change only what the instruction asks for and keep everything else as it is. ' +
    'Never add a statistic, number, date, name or claim that is not already in the text or in the instruction; never add a link. Keep the same language, tone and markdown style. ' +
    `Respond with ONLY a JSON object of this shape: ${SHAPES[block.kind]}`;
  const user = `Post topic: ${topic}\nPart being edited: ${block.label}\n\nCurrent text (JSON):\n${JSON.stringify(current)}\n\n${selected ? `\n\nThe editor selected these exact words in this part: "${selected}". Change ONLY those words as asked and keep every other word of this part exactly as it is.` : ''}\n\nWhat the editor wants changed:\n${instruction}`;
  const out = await callJson(system, user, { maxTokens: block.kind === 'section' ? 1500 : 600 });
  if (block.kind === 'quick') { if (!clean(out?.text)) throw badEdit('The rewrite came back empty.'); return clean(out.text); }
  if (block.kind === 'section') { if (!clean(out?.body)) throw badEdit('The rewrite came back empty.'); return { heading: clean(out.heading) || block.value.heading, body: clean(out.body) }; }
  if (!clean(out?.question) || !clean(out?.answer)) throw badEdit('The rewrite came back without a question and an answer.');
  return { question: clean(out.question), answer: clean(out.answer) };
}
