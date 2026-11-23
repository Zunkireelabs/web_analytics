// NEW BLOG POSTS FOR A "CONVERTED" STATIC SITE (real case: MOBILISE, Eleventy).
//
// On such a site there is no generic blog template. Every page carries its own front matter (layout, permalink, headInclude, documentStart, bodyAttributes,
// headBodyGap, documentEnd, componentBase), its body is written out in full (nav include, main.blog-page > article.blog-article, footer include), and every
// page has its OWN head file under _includes/heads/ holding its canonical, Open Graph, Twitter and article schema. A page written the usual way
// (layout line plus markdown) has none of that and fails the build or comes out unstyled.
//
// So a new post is made by COPYING one real sibling post of the site (the "reference") and changing only what belongs to the new article: its title, summary,
// date, image, address, text, and the head file that goes with it. The site's own classes and structure are reused, never invented. Everything is pure
// string work; the caller reads the reference files and writes the results.
//
// Safety: the builder refuses (and the draft is blocked, nothing is written) when the reference does not have the shape it relies on, and when any
// distinctive text of the REFERENCE article is still present in what it produced.

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const jsonStr = (s) => JSON.stringify(String(s));
const regexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function fmValue(fm, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(fm);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

/** Replaces one `"key": "value"` in the front matter, leaving everything else on that line (a trailing marker comment) as it was. */
export function setFmValue(fm, key, value) {
  const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
  if (!re.test(fm)) return null;
  return fm.replace(re, (_m, pre) => `${pre}${jsonStr(value)}`);
}

/** The offset just after the `</div>` that closes the div opened at `openIdx`, or -1. */
export function balancedDivEnd(text, openIdx) {
  const re = /<div\b[^>]*>|<\/div>/gi; re.lastIndex = openIdx; let depth = 0; let m;
  while ((m = re.exec(text))) { depth += m[0][1] === '/' ? -1 : 1; if (depth === 0) return m.index + m[0].length; }
  return -1;
}

export function formatDate(iso, like) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDate(); const month = MONTHS[d.getUTCMonth()]; const year = d.getUTCFullYear();
  if (/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(like || '')) return `${day} ${month} ${year}`;           // 22 August 2026
  if (/^[A-Za-z]+\s+0\d,\s*\d{4}$/.test(like || '')) return `${month} ${String(day).padStart(2, '0')}, ${year}`; // March 06, 2025
  return `${month} ${day}, ${year}`;                                                                    // May 22, 2024
}

/** Paragraphs and simple "- " lists from plain draft text, escaped. */
export function renderParagraphs(text) {
  const blocks = String(text || '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b) => {
    const lines = b.split('\n').map((l) => l.trim());
    if (lines.every((l) => /^[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${esc(l.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    return `<p>${esc(lines.join(' '))}</p>`;
  }).join('\n                ');
}

function absoluteImage(url, origin) {
  if (!url) return null;
  try { return new URL(url, origin).href; } catch { return null; }
}
/** The path a page at componentBase depth uses for an image: "/images/x.jpg" -> "../../images/x.jpg"; an absolute URL stays absolute. */
function relativeImage(url, componentBase) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return url.startsWith('/') ? `${componentBase || ''}${url.slice(1)}` : url;
}

const fail = (reason, error) => ({ ok: false, reason, error });

/**
 * Builds the new page and its head file from a reference post and its head file.
 * `reference`: { page, head }  `post`: { slug, title, summary, metaDescription, publishedAt, image: {url, alt}, sections: [{heading, body}], category }
 * `origin`: "https://mobilise.agency"   `today`: ISO date for modified time
 */
export function buildConvertedBlogPage({ reference, post, origin, today = new Date().toISOString().slice(0, 10) }) {
  const m = FRONT.exec(reference?.page || '');
  if (!m) return fail('reference-shape', 'The reference post has no front matter block.');
  const fm = m[1]; const bodyText = reference.page.slice(m[0].length);
  const need = ['layout', 'permalink', 'headInclude', 'title', 'description', 'componentBase', 'documentStart'];
  const missing = need.filter((k) => fmValue(fm, k) == null);
  if (missing.length) return fail('reference-shape', `The reference post's front matter lacks: ${missing.join(', ')}.`);
  const refPermalink = fmValue(fm, 'permalink'); const refHeadInclude = fmValue(fm, 'headInclude');
  const refSlug = (/\/blog\/([^/]+)\/index\.html$/.exec(refPermalink) || [])[1];
  if (!refSlug) return fail('reference-shape', 'The reference post\'s permalink is not /blog/<slug>/index.html.');
  const componentBase = fmValue(fm, 'componentBase');
  const refTitleFull = fmValue(fm, 'title'); const suffix = (/(\s\|\s[^|]+)$/.exec(refTitleFull) || [])[1] || '';
  const refDescription = fmValue(fm, 'description');
  if (!reference.head || !reference.head.includes(`blog/${refSlug}/`)) return fail('reference-shape', 'The reference post\'s head file does not describe the reference post.');

  const url = `${origin}/blog/${post.slug}/`;
  const title = suffix && !post.title.includes(suffix.replace(/^\s\|\s/, '')) ? `${post.title}${suffix}` : post.title;

  // ---- front matter
  let nf = fm;
  for (const [k, v] of [['permalink', `/blog/${post.slug}/index.html`], ['headInclude', refHeadInclude.replace(refSlug, post.slug)], ['title', title], ['description', post.metaDescription]]) {
    nf = setFmValue(nf, k, v); if (nf == null) return fail('reference-shape', `Could not set "${k}" in the front matter.`);
  }
  if (nf.includes(refSlug)) return fail('leftover', 'The reference\'s address was still in the new front matter.');

  // ---- body
  let body = bodyText;
  const h1 = /(<header class="blog-header">[\s\S]*?<h1>)([\s\S]*?)(<\/h1>)/.exec(body);
  if (!h1) return fail('reference-shape', 'The reference post has no <header class="blog-header"> with an <h1>.');
  const refH1 = h1[2].replace(/<[^>]+>/g, '').trim();
  body = body.replace(h1[0], `${h1[1]}${esc(post.title)}${h1[3]}`);
  const lead = /(<\/h1>\s*<p>)([\s\S]*?)(<\/p>)/.exec(body);
  if (!lead) return fail('reference-shape', 'The reference post\'s header has no lead paragraph after the <h1>.');
  const refLead = lead[2].replace(/<[^>]+>/g, '').trim();
  body = body.replace(lead[0], `${lead[1]}${esc(post.summary || post.metaDescription)}${lead[3]}`);
  const time = /<time datetime="([^"]*)">([^<]*)<\/time>/.exec(body);
  const refDateText = time ? time[2] : null;
  const published = post.publishedAt || today;
  if (time) body = body.replace(time[0], `<time datetime="${esc(String(published).slice(0, 10))}">${esc(formatDate(published, time[2]) || time[2])}</time>`);

  const refImg = /<img class="blog-image"[^>]*>/.exec(body); let refImageName = null;
  if (refImg) {
    refImageName = (/src="([^"]*)"/.exec(refImg[0]) || [])[1]?.split('/').pop() || null;
    const imgSrc = relativeImage(post.image?.url, componentBase);
    body = imgSrc
      ? body.replace(refImg[0], refImg[0].replace(/src="[^"]*"/, `src="${esc(imgSrc)}"`).replace(/alt="[^"]*"/, `alt="${esc(post.image?.alt || post.title)}"`).replace(/\s+width="[^"]*"/, '').replace(/\s+height="[^"]*"/, ''))
      : body.replace(refImg[0], '');
  }

  const open = body.search(/<div class="blog-content">/);
  if (open === -1) return fail('reference-shape', 'The reference post has no <div class="blog-content">.');
  const close = balancedDivEnd(body, open);
  if (close === -1) return fail('reference-shape', 'The reference post\'s blog-content div is not closed.');
  const sections = (post.sections || []).filter((s) => s?.heading);
  if (!sections.length) return fail('no-content', 'The draft has no sections to write.');
  const inner = sections.map((s) => `<h2>${esc(s.heading)}</h2>\n                ${renderParagraphs(s.body)}`).join('\n                ');
  body = `${body.slice(0, open)}<div class="blog-content">\n                ${inner}\n            </div>${body.slice(close)}`;

  // ---- head file
  let head = reference.head;
  const refUrl = `${origin}/blog/${refSlug}/`;
  // Everything the reference's head file says that is about the reference ARTICLE (its titles, descriptions, headline, and the breadcrumb entry that names it).
  const refAbout = new Set();
  for (const re of [/<meta\s+(?:property|name)="(?:og|twitter):(?:title|description)"\s+content="([^"]*)"/g, /"(?:headline|description|alternativeHeadline)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    new RegExp(`"name"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*,\\s*"item"\\s*:\\s*"${regexEscape(refUrl)}"`, 'g')]) {
    for (const m of reference.head.matchAll(re)) if (m[1] && m[1].trim().length >= 10) refAbout.add(m[1].trim());
  }
  head = head.split(refUrl).join(url);
  // The breadcrumb entry for this page names THIS page.
  head = head.replace(new RegExp(`("name"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"(\\s*,\\s*"item"\\s*:\\s*"${regexEscape(url)}")`, 'g'), (_m, a, b) => `${a}${jsonStr(post.title)}${b}`);
  const newImageAbs = absoluteImage(post.image?.url, origin);
  const swapMeta = (h, attr, name, value) => h.replace(new RegExp(`(<meta\\s+${attr}="${regexEscape(name)}"\\s+content=")[^"]*(")`, 'g'), (_m, a, b) => `${a}${esc(value)}${b}`);
  head = swapMeta(head, 'property', 'og:title', post.title); head = swapMeta(head, 'name', 'twitter:title', post.title);
  head = swapMeta(head, 'property', 'og:description', post.metaDescription); head = swapMeta(head, 'name', 'twitter:description', post.metaDescription);
  if (newImageAbs) {
    head = swapMeta(head, 'property', 'og:image', newImageAbs); head = swapMeta(head, 'name', 'twitter:image', newImageAbs);
    head = swapMeta(head, 'property', 'og:image:alt', post.image?.alt || post.title);
  }
  head = swapMeta(head, 'property', 'article:published_time', String(published).slice(0, 10)); head = swapMeta(head, 'property', 'article:modified_time', today);
  if (post.category) head = swapMeta(head, 'property', 'article:section', post.category);
  head = head.replace(/("headline"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (_m, a) => `${a}${jsonStr(post.title)}`)
    .replace(/("description"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (_m, a) => `${a}${jsonStr(post.metaDescription)}`)
    .replace(/("datePublished"\s*:\s*)"[^"]*"/g, (_m, a) => `${a}"${String(published).slice(0, 10)}"`)
    .replace(/("dateModified"\s*:\s*)"[^"]*"/g, (_m, a) => `${a}"${today}"`);
  if (newImageAbs) head = head.replace(/("image"\s*:\s*)"[^"]*"/g, (_m, a) => `${a}${jsonStr(newImageAbs)}`);
  else {
    // No picture for the new post: its social tags and schema must say nothing about an image, never keep the reference article's.
    head = head.replace(/^[ \t]*<meta\s+(?:property="og:image(?::alt)?"|name="twitter:image")[^>]*>\r?\n?/gm, '')
      .replace(/,\s*"image"\s*:\s*"[^"]*"/g, '').replace(/"image"\s*:\s*"[^"]*"\s*,\s*/g, '');
  }

  // ---- nothing of the reference article may be left in what we made
  const distinctive = [refSlug, refH1, refLead, refDescription, refImageName, ...refAbout].filter((t) => t && t.length >= 6);
  const produced = `${nf}\n${body.slice(0, open)}${body.slice(open, open + 40)}${inner}\n${head}`;
  const leftovers = distinctive.filter((t) => produced.includes(t));
  if (leftovers.length) return fail('leftover', `Text of the reference post is still present in the new page: ${leftovers.map((t) => `"${t.slice(0, 40)}"`).join(', ')}.`);

  return { ok: true, page: `---\n${nf}\n---\n${body}`, head, refSlug, refDateText, headIncludePath: fmValue(nf, 'headInclude') };
}

/**
 * Adds the new post's card to a listing page (MOBILISE's /blog/all): the first existing `.blog-card` is copied and its address, image, date, title and
 * summary replaced, then it is inserted before that card. Returns { ok, content } or { ok:false, reason } (the caller then ships without it and says so).
 */
export function addListingCard(listing, { post, componentBase, relativeHref, image, today }) {
  const cardRe = /<a\s+href="[^"]*"\s+class="blog-card"[^>]*>[\s\S]*?<\/a>/;
  const m = cardRe.exec(listing || '');
  if (!m) return { ok: false, reason: 'no-card-found' };
  const card = m[0]; const refHref = (/href="([^"]*)"/.exec(card) || [])[1];
  const refDate = (/<span class="blog-date">([^<]*)<\/span>/.exec(card) || [])[1];
  const dateText = formatDate(post.publishedAt || today, refDate);
  let next = card.replace(/href="[^"]*"/, `href="${esc(relativeHref)}"`);
  const img = /<img\b[^>]*>/.exec(next);
  if (img) next = image ? next.replace(img[0], img[0].replace(/src="[^"]*"/, `src="${esc(image.src)}"`).replace(/alt="[^"]*"/, `alt="${esc(image.alt || post.title)}"`)) : next.replace(img[0], '');
  next = next.replace(/(<span class="blog-date">)[^<]*(<\/span>)/, `$1${esc(dateText || '')}$2`)
    .replace(/(<h2>)[\s\S]*?(<\/h2>)/, `$1${esc(post.title)}$2`)
    .replace(/(<\/h2>\s*<p>)[\s\S]*?(<\/p>)/, `$1${esc(post.summary || post.metaDescription)}$2`);
  if (card.includes(refHref) && refHref && next.includes(refHref)) return { ok: false, reason: 'leftover' };
  const at = m.index; const indent = (/([ \t]*)$/.exec(listing.slice(0, at)) || [, ''])[1];
  return { ok: true, content: `${listing.slice(0, at)}${next}\n${indent}${listing.slice(at)}` };
}
