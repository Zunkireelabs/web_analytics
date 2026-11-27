import { buildConvertedBlogPage, addListingCard, fmValue } from './converted-blog-page.js';

// Turns an approved blog-outline draft into the files for a "converted" static site (see converted-blog-page.js): the page, its own head file and, when the
// site names a listing page, the new post's card on it. Configured per site as newContentTargets["blog-outline"]:
//   { mode: "clone-sibling", dir: "src/blog", filename: "index.njk", extension: ".njk", urlPattern: "/blog/{slug}/",
//     referencePage: "src/blog/<an existing post>/index.njk", headDir: "src/_includes", listingPage: "src/blog/all/index.njk" }
// Reads the reference (and listing) from the site's base branch through the injected `readFile(site, path, ref)`. Never writes; returns the files.

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const blocked = (reason, error) => ({ ok: false, reason, error });

export function originFor(site) {
  const d = String(site?.website_domain || '').trim(); if (!d) return null;
  return (/^https?:\/\//i.test(d) ? d : `https://${d}`).replace(/\/+$/, '');
}


const escFaq = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FAQ_MARKERS = /(<!--\s*SEOAI:FAQ:START\s*-->)\s*(<!--\s*SEOAI:FAQ:END\s*-->)/;
/** Puts the post's FAQ into the empty FAQ markers the site's posts carry, in the site's own FAQ design. Never adds a FAQ in a design the site does not have. */
export function fillFaqMarkers(page, items, template) {
  if (!items?.length || !template?.wrapper || !template?.row || !FAQ_MARKERS.test(page)) return { page, filled: false };
  const rows = items.map((i) => template.row.replace('{{QUESTION}}', () => escFaq(i.question)).replace('{{ANSWER}}', () => escFaq(i.answer))).join('');
  const block = template.wrapper.replace('{{ROWS}}', () => rows);
  return { page: page.replace(FAQ_MARKERS, (_m, start, end) => `${start}${block}${end}`), filled: true };
}

export async function resolveConvertedBlogPost(site, content, cfg, { filePath, readFile, ref = 'main', learnFaq = null, today = new Date().toISOString().slice(0, 10) }) {
  const origin = originFor(site);
  if (!origin) return blocked('no-file-mapping', 'This site has no website domain recorded, so the new post\'s address cannot be written.');
  if (!cfg.referencePage) return blocked('no-file-mapping', 'newContentTargets["blog-outline"].referencePage is not set: name an existing post whose structure the new one should copy.');
  const slug = filePath.split('/').slice(-2)[0];
  if (await readFile(site, filePath, ref)) return blocked('slug-conflict', `"${slug}" already exists in this site (${filePath}); refusing to overwrite it.`);

  const refFile = await readFile(site, cfg.referencePage, ref);
  if (!refFile) return blocked('no-file-mapping', `The reference post ${cfg.referencePage} was not found on "${ref}".`);
  const fm = FRONT.exec(refFile.content)?.[1] || '';
  const headInclude = fmValue(fm, 'headInclude');
  if (!headInclude) return blocked('no-file-mapping', `The reference post ${cfg.referencePage} has no headInclude, so its head file cannot be found.`);
  const headDir = (cfg.headDir || 'src/_includes').replace(/\/+$/, '');
  const refHeadPath = `${headDir}/${headInclude}`;
  const refHead = await readFile(site, refHeadPath, ref);
  if (!refHead) return blocked('no-file-mapping', `The reference post's head file ${refHeadPath} was not found on "${ref}".`);

  const title = content.title || content.topic;
  const post = {
    slug, title, summary: content.quickAnswer || content.metaDescription, metaDescription: content.metaDescription || content.quickAnswer || title,
    publishedAt: content.publishedAt || today, category: content.category || null,
    image: content.featuredImage?.url ? { url: content.featuredImage.url, alt: content.featuredImage.alt || title } : null,
    sections: Array.isArray(content.sections) ? content.sections : [],
  };
  const built = buildConvertedBlogPage({ reference: { page: refFile.content, head: refHead.content }, post, origin, today });
  if (!built.ok) return blocked(built.reason === 'no-content' ? 'draft-not-ready' : 'invalid-edit', `New post not written: ${built.error}`);

  const newHeadPath = `${headDir}/${built.headIncludePath}`;
  const extraFiles = [{ path: newHeadPath, content: built.head }];
  const notes = [];
  // The post's FAQ, in the site's own FAQ design (read from the site's other pages in its repo), into the empty FAQ markers its posts carry.
  let page = built.page;
  const faqItems = (content.faqItems || []).filter((x) => x?.question && x?.answer);
  if (faqItems.length) {
    // Inside an async function so a throw from the injected learner, or from the import, is caught here too: a FAQ design that cannot be learned leaves the FAQ out, it never fails the whole post.
    const template = await (async () => (learnFaq ? learnFaq() : (await import('../../generators/lib/site-faq-learn.js')).learnRepoFaqTemplate(site, { getFileContent: readFile, ref, blogDir: cfg.dir, withSection: true })))().catch(() => null);
    const filled = fillFaqMarkers(page, faqItems, template);
    page = filled.page;
    if (!filled.filled) notes.push(template ? 'The FAQ was not added: the reference post has no FAQ placeholder to put it in.' : 'The FAQ was not added: no FAQ design was found on the site\'s other pages, and one is never added in a design the site does not have.');
  }
  if (cfg.listingPage) {
    const listing = await readFile(site, cfg.listingPage, ref);
    if (!listing) notes.push(`The listing page ${cfg.listingPage} was not found, so the new post is not listed there.`);
    else {
      const lfm = FRONT.exec(listing.content)?.[1] || '';
      const base = fmValue(lfm, 'componentBase') || '../../';
      const imageSrc = post.image ? (/^https?:\/\//i.test(post.image.url) ? post.image.url : `${base}${post.image.url.replace(/^\//, '')}`) : null;
      const card = addListingCard(listing.content, { post: { ...post, summary: post.summary }, componentBase: base, relativeHref: `../${slug}/`, image: imageSrc ? { src: imageSrc, alt: post.image.alt } : null, today });
      if (card.ok) extraFiles.push({ path: cfg.listingPage, content: card.content });
      else notes.push(`The new post was not added to ${cfg.listingPage} (${card.reason}); add its card by hand.`);
    }
  }
  return { ok: true, filePath, body: page, contentFormat: 'html-page', extraFiles, ...(notes.length ? { notes } : {}) };
}
