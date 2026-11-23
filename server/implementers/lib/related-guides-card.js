import * as cheerio from 'cheerio';

// RELATED GUIDES AS CARDS, in each site's OWN design.
//
// 1. extractRelatedGuidesCard(html): finds the site's existing "related guides / related articles / keep reading / more from" block on one of its live
//    pages and turns its first card into a template with {{URL}} {{TITLE}} {{DESCRIPTION}} {{IMAGE}} placeholders, plus the surrounding section with a
//    {{CARDS}} placeholder. The classes, structure and spacing are the site's own, copied, never invented.
// 2. renderRelatedGuides(template, items): fills that template with real data (escaped). A missing image or description drops that part of the card
//    rather than leaving an empty hole.
// 3. tokenRelatedGuides(items, tokens): ONLY for a site that has no card anywhere. Built from the site's captured colours with inline styles, and returned
//    with needsReview: true so a person approves it once before it can ship.

const KEY = /(related\s+(guides|articles|posts|reading)|more\s+(from|articles|guides)|read\s+next|keep\s+reading|you\s+may\s+also|further\s+reading)/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = ($el) => $el.text().replace(/\s+/g, ' ').trim();

function cardsIn($, $root) {
  // The container whose direct children are 2+ repeated cards (a link, article or list item that holds an image and/or a heading).
  let best = null;
  $root.find('*').each((_, el) => {
    const kids = $(el).children().toArray().filter((k) => /^(a|article|li|div)$/i.test(k.tagName));
    const cards = kids.filter((k) => $(k).find('h2,h3,h4,h5,h6').length >= 1 && $(k).find('h2,h3,h4,h5,h6').length <= 2 || $(k).is('a') && $(k).find('h2,h3,h4,h5,h6,p').length);
    if (cards.length >= 2 && cards.length === kids.length && (!best || cards.length > best.cards.length)) best = { el, cards };
  });
  return best;
}

export function extractRelatedGuidesCard(html) {
  if (!html || typeof html !== 'string') return { ok: false, reason: 'no-html' };
  const $ = cheerio.load(html, { xml: false });
  $('script,style,svg,noscript').remove();
  // Headings in the page's chrome (footer link columns, navigation, header) are not related-guides blocks.
  let failure = null;
  const headings = $('h2,h3,h4').toArray().filter((h) => KEY.test(text($(h))) && !$(h).closest('footer,nav,header,[role="contentinfo"],[role="navigation"]').length);
  for (const h of headings) {
    // The block is the nearest ancestor that holds the heading AND the cards.
    let block = $(h).parent();
    for (let i = 0; i < 5 && block.length; i++) {
      const found = cardsIn($, block);
      if (found && block.find(found.el).length) {
        // Cards in one grid often include a larger "feature" variant first: template the most common look, not the odd one out.
        const sig = (el) => ($(el).attr('class') || '').replace(/\s+/g, ' ').trim() + '|' + ($(el).find('[class]').first().attr('class') || '');
        const tally = new Map(); for (const c of found.cards) tally.set(sig(c), (tally.get(sig(c)) || 0) + 1);
        const commonSig = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const first = $([...found.cards].reverse().find((c) => sig(c) === commonSig));
        const link = first.is('a') ? first : first.find('a').first();
        if (!link.length || !link.attr('href')) continue;
        const card = $.html(first);
        const c = cheerio.load(card, { xml: false }, false); const root = c.root().children().first();
        // Make a template: strip data and tracking attributes, then replace the variable parts.
        root.find('*').addBack().each((_, el) => { for (const a of Object.keys(el.attribs || {})) if (/^(data-|srcset$|sizes$|loading$|decoding$|fetchpriority$|style$)/i.test(a) && a !== 'style') delete el.attribs[a]; });
        // EVERY link in the card goes to the same article (a title link and a "Read more" link both do), so none may keep a real address.
        (root.is('a') ? root : root.find('a')).add(root.is('a') ? root : []).each((_, el) => { if (el.attribs?.href !== undefined) el.attribs.href = '{{URL}}'; });
        root.find('a').each((_, el) => { if (el.attribs?.href !== undefined) el.attribs.href = '{{URL}}'; });
        const img = root.find('img').first(); if (img.length) { img.attr('src', '{{IMAGE}}'); img.attr('alt', '{{TITLE}}'); }
        const title = root.find('h2,h3,h4,h5,h6').first(); if (title.length) { const tl = title.find('a').first(); (tl.length ? tl : title).text('{{TITLE}}'); } // keep a title that is itself a link
        const para = root.find('p').filter((_, p) => !/pill|tag|badge|category/i.test(c(p).attr('class') || '')).first();
        if (para.length) para.text('{{DESCRIPTION}}');
        root.find('[class*="tag"],[class*="pill"],[class*="badge"],[class*="category"],[class*="date"],[class*="meta"],[class*="author"],time').remove(); // per-article labels are not reusable
        root.find('*').each((_, el) => { const kids = c(el).children().toArray(); if (kids.length && kids.every((k) => k.tagName === 'span' && !c(k).children().length && c(k).text().trim().length <= 32) && !c(el).is('a') && c(el).text().trim().length <= 120 && !/\{\{/.test(c(el).html())) c(el).remove(); });
        const DATEISH = /^(\d{1,2}\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2},?\s+)?\d{4}$|^\d+\s*(min|minute)s?\s*(read)?$/i;
        root.find('span,small,p,div').each((_, el) => { const t = c(el).children().length ? '' : c(el).text().trim(); if (t && DATEISH.test(t)) c(el).remove(); });
        const cardTemplate = c.html(root);
        const hasText = /\{\{TITLE\}\}/.test(cardTemplate); if (!hasText) continue;
        // A card with its own illustrated cover, several headings or a lot of leftover text cannot be turned into a reusable template honestly.
        const leftover = c('*').toArray().flatMap((el) => (el.children || []).filter((n) => n.type === 'text').map((n) => n.data.replace(/\{\{[A-Z]+\}\}/g, '').trim())).filter(Boolean);
        if (cardTemplate.length > 2400 || root.find('h2,h3,h4,h5,h6').length > 1 || leftover.length > 2) { failure = { ok: false, reason: 'card-too-complex', heading: text($(h)), why: { length: cardTemplate.length, headings: root.find('h2,h3,h4,h5,h6').length, leftover: leftover.slice(0, 4) } }; continue; }
        // The wrapper: the whole block with the real cards replaced by one {{CARDS}} placeholder.
        const holder = $(found.el); holder.html('{{CARDS}}');
        const sectionEl = block.is('section,aside') ? block : block.closest('section,aside').length ? block.closest('section,aside') : block;
        const section = $.html(sectionEl).replace(/\s+/g, ' ').trim();
        const heading = text($(h));
        return { ok: true, heading, card: cardTemplate.replace(/\s+/g, ' ').trim(), section: section.replace(/>\s*\{\{CARDS\}\}\s*</, '>{{CARDS}}<'), cardCount: found.cards.length, hasImage: /\{\{IMAGE\}\}/.test(cardTemplate), hasDescription: /\{\{DESCRIPTION\}\}/.test(cardTemplate) };
      }
      block = block.parent();
    }
  }
  return failure || { ok: false, reason: 'no-card-block' };
}

export function renderRelatedGuides(template, items) {
  if (!template?.card || !template?.section) return { ok: false, reason: 'no-template' };
  const list = (items || []).filter((i) => i && i.url && i.title);
  if (!list.length) return { ok: false, reason: 'no-items' };
  const cards = list.map((i) => {
    let html = template.card.replaceAll('{{URL}}', esc(i.url)).replaceAll('{{TITLE}}', esc(i.title));
    html = i.description ? html.replaceAll('{{DESCRIPTION}}', esc(i.description)) : dropElementWith(html, '{{DESCRIPTION}}');
    html = i.image ? html.replaceAll('{{IMAGE}}', esc(i.image)) : dropElementWith(html, '{{IMAGE}}');
    return html;
  }).join('\n');
  return { ok: true, html: template.section.replace('{{CARDS}}', cards) };
}

// A card with no image or description loses just that element (and an emptied wrapper around an image), never leaves a placeholder behind.
function dropElementWith(html, token) {
  const c = cheerio.load(html, { xml: false }, false);
  c('*').filter((_, el) => (el.children || []).some((n) => n.type === 'text' && n.data.includes(token)) || Object.values(el.attribs || {}).some((v) => v.includes(token))).each((_, el) => {
    const $el = c(el); const parent = $el.parent();
    $el.remove();
    if (parent.length && !parent.children().length && !parent.text().trim() && parent[0].tagName !== undefined && parent.parent().length) parent.remove();
  });
  return c.html();
}

/** Only for a site with no card of its own. Colours come from its captured design profile; nothing here is another client's CSS. */
export function tokenRelatedGuides(items, tokens = {}) {
  const list = (items || []).filter((i) => i && i.url && i.title);
  if (!list.length) return { ok: false, reason: 'no-items' };
  const t = { text: tokens.text || 'inherit', muted: tokens.muted || 'inherit', border: tokens.border || 'rgba(0,0,0,.12)', surface: tokens.surface || 'transparent', radius: tokens.radius || '12px' };
  const cards = list.map((i) => `<a href="${esc(i.url)}" style="display:flex;flex-direction:column;gap:8px;padding:20px;border:1px solid ${esc(t.border)};border-radius:${esc(t.radius)};background:${esc(t.surface)};color:${esc(t.text)};text-decoration:none">`
    + (i.image ? `<img src="${esc(i.image)}" alt="${esc(i.title)}" style="width:100%;height:auto;border-radius:${esc(t.radius)}">` : '')
    + `<strong style="font-size:1.05em;line-height:1.3">${esc(i.title)}</strong>`
    + (i.description ? `<span style="color:${esc(t.muted)};font-size:.95em;line-height:1.5">${esc(i.description)}</span>` : '') + '</a>').join('');
  return { ok: true, needsReview: true, html: `<section aria-label="Related guides"><h2>Related guides</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px">${cards}</div></section>` };
}
