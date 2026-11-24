import { measureBodyInPage, compareBodyMeasures, MEASURE_VIEWPORTS } from '../../design-agent/live-analysis/body-measure.js';
import { launchBrowser } from '../../design-agent/live-analysis/capture.js';

// A REAL rendered preview of a blog article: the draft's actual title, hero image and body shown inside the site's own article template.
//
// The Draft Preview panel only ever showed fields and text, and the render gate (newpage-render-gate.js) only MEASURES a draft's body
// against a real article of the same role. Neither lets a person see what the post will look like. This loads a real existing article
// of the same site (the "reference page", picked from the design profile by pickReferencePage), puts the draft's own content where the
// reference's content is, and takes full-page screenshots at desktop and mobile width. Everything else on the page (header, footer,
// related articles, fonts, spacing) is the site's, untouched, so what you see is the template doing its real work on the real article.
//
// What is replaced, and nothing else: the article body region (found by the same detector the render gate uses), the first <h1>, the
// document title, and the hero image when a cover is given and the template has one. A site whose templates cannot be rendered outside
// its own build (template syntax, JSX) is reported as not previewable, never faked.

// Runs in the page. Returns what it actually replaced, so the caller can say plainly what the preview shows.
/* eslint-disable no-undef */
export function injectArticleInPage({ html, title, cover }) {
  const out = { body: false, title: false, hero: false };
  const region = document.querySelector('[data-gate-region]');
  if (!region) return out;
  // A site's article renderer often puts its utility classes on every element (`h2.mt-8 mb-3.5 pb-2.5 border-b-2`) (and often an inline `style`) rather than scoping CSS to a wrapper, so bare
  // tags in a draft would render as plain text. Read the class and style each element kind carries in the reference article, before it is replaced, and put the same
  // class and style on the draft's own elements of that kind (never overriding a class the draft already has).
  const classFor = {};
  for (const tag of ['h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'blockquote', 'a', 'strong', 'table', 'img']) {
    const pool = [...region.querySelectorAll(tag)].filter((el) => (String(el.className || '').trim() || el.getAttribute('style')) && (tag !== 'p' || (el.textContent || '').trim().length > 40));
    if (pool.length) classFor[tag] = { cls: String(pool[0].className || '').trim(), style: pool[0].getAttribute('style') || '' };
  }
  region.innerHTML = html;
  for (const [tag, { cls, style }] of Object.entries(classFor)) {
    for (const el of region.querySelectorAll(tag)) {
      if (cls && !String(el.className || '').trim()) el.className = cls;
      if (style && !el.getAttribute('style')) el.setAttribute('style', style);
    }
  }
  out.body = true;
  out.classesCopied = Object.keys(classFor);
  if (title) {
    const h1 = document.querySelector('h1');
    if (h1) { h1.textContent = title; out.title = true; }
    document.title = title;
  }
  if (cover) {
    // The hero is the largest image that sits ABOVE the body region (the card thumbnails of related articles are below it).
    const imgs = [...document.querySelectorAll('img')].filter((img) => {
      if (region.contains(img)) return false;
      const r = img.getBoundingClientRect();
      const above = img.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING;
      return above && r.width >= 280 && r.height >= 120;
    });
    imgs.sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height));
    const hero = imgs[0];
    if (hero) {
      hero.removeAttribute('srcset'); hero.removeAttribute('sizes'); hero.removeAttribute('loading');
      hero.src = cover.url;
      if (cover.alt) hero.alt = cover.alt;
      out.hero = true;
    }
  }
  return out;
}
/* eslint-enable no-undef */

/**
 * @param {object} o
 * @param {string} o.referenceUrl  a real article of the same site and role
 * @param {string} o.bodyHtml      the draft body as HTML (see renderableBody in newpage-render-gate.js)
 * @param {string} [o.title]       the draft's title
 * @param {{url:string, alt?:string}} [o.cover]
 * @returns {Promise<{ok:true, shots:{viewport:string,width:number,height:number,png:Buffer}[], replaced:object, referenceUrl:string, deviations:object[], matchesSiteDesign:boolean} | {ok:true, skip:true, reason:string} | {ok:false, reason:string, error:string}>}
 */
export async function renderArticlePreview({
  referenceUrl, bodyHtml, title = null, cover = null, viewports = MEASURE_VIEWPORTS, launchBrowserFn = launchBrowser, navTimeoutMs = 25000, fullPage = true,
} = {}) {
  if (!referenceUrl || !bodyHtml) return { ok: false, reason: 'bad-input', error: 'referenceUrl and bodyHtml are required.' };
  let browser;
  try { browser = await launchBrowserFn(); } catch (err) { return { ok: false, reason: 'unreachable', error: err.message }; }
  try {
    const context = await browser.newContext({ viewport: { width: viewports[0].width, height: viewports[0].height } });
    const page = await context.newPage();
    try { await page.goto(referenceUrl, { waitUntil: 'networkidle', timeout: navTimeoutMs }); }
    catch { await page.goto(referenceUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }).catch((err) => { throw Object.assign(new Error(err.message), { unreachable: true }); }); }

    // What the site itself does with body text, per viewport, measured before anything is replaced.
    const ref = {};
    for (const vp of viewports) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // eslint-disable-next-line no-await-in-loop
      ref[vp.name] = await page.evaluate(measureBodyInPage, vp === viewports[0]);
    }
    if (!ref[viewports[0].name]?.found) return { ok: true, skip: true, reason: 'no-body-region-on-reference' };
    const replaced = await page.evaluate(injectArticleInPage, { html: bodyHtml, title, cover });
    if (!replaced?.body) return { ok: true, skip: true, reason: 'no-body-region-on-reference' };

    // What the draft does in the same region. A render whose headings, spacing or line length differ from the site's own is reported as
    // deviating: "flat" output (headings that look like body text) is exactly what this exists to catch, so it is never shown as a success.
    const deviations = [];
    for (const vp of viewports) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // eslint-disable-next-line no-await-in-loop
      const draft = await page.evaluate(measureBodyInPage, false);
      deviations.push(...compareBodyMeasures(ref[vp.name], draft, vp));
    }

    const shots = [];
    for (const vp of viewports) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // Let lazy images and fonts settle at this width before the picture is taken.
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(600);
      // eslint-disable-next-line no-await-in-loop
      const png = await page.screenshot({ fullPage, type: 'png' });
      // eslint-disable-next-line no-await-in-loop
      const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
      shots.push({ viewport: vp.name, width: vp.width, height: size.h, pageWidth: size.w, png });
    }
    return { ok: true, shots, replaced, referenceUrl, deviations, matchesSiteDesign: deviations.length === 0 };
  } catch (err) {
    return { ok: false, reason: err?.unreachable ? 'unreachable' : 'render-failed', error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}
