import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designKitFor, renderOption, previewsFor, getSiteStylesheets, stylesheetsPending, renderDraft, draftPreviewFor } from './content-preview.js';
import { CONTENT_OPTIONS } from './content-options.js';

const site = {
  name: 'Acme', website_domain: 'acme-preview-test.example', brand_color: '#0d1282',
  url_file_map: { siteRoot: { designProfile: { color: { border: 'border-gray-200', surface: 'bg-gray-50' }, pages: [{ sections: [{ textHierarchy: [
    { tag: 'h1', role: 'heading', style: { fontSize: '60px', fontFamily: '"DM Sans", sans-serif', fontWeight: '400', color: 'rgb(17, 24, 39)', lineHeight: '60px' } },
    { tag: 'p', role: 'body', style: { fontSize: '20px', color: 'rgb(75, 85, 99)' } }] }] }] } } },
};
const noNet = async () => { throw new Error('offline'); };

test('the kit uses the site\'s real recorded type and its own brand colour', () => {
  const k = designKitFor(site);
  assert.match(k.h1, /font-size:60px/);
  assert.match(k.h1, /DM Sans/);
  assert.equal(k.brand, '#0d1282');
  assert.equal(k.border, '#e5e7eb');
});

test('every option of every kind draws, and no two options of a kind are the same picture', async () => {
  const out = await previewsFor(site, CONTENT_OPTIONS, { fetchImpl: noNet });
  for (const [g, def] of Object.entries(CONTENT_OPTIONS)) {
    const htmls = def.options.map((o) => out[g][o.key]);
    assert.ok(htmls.every(Boolean), `${g} has a picture per option`);
    assert.equal(new Set(htmls).size, htmls.length);
  }
});

test('an unreachable site still gets pictures (no stylesheet, no error); site text is escaped', async () => {
  assert.deepEqual((await getSiteStylesheets(site, noNet)).hrefs, []);
  const html = renderOption('landing-page', 'A', designKitFor(site), '<img src=x onerror=1>');
  assert.ok(!html.includes('<img src=x'));
});

const kit = () => designKitFor(site);
test('a blog draft is drawn with its own title, sections and questions, in the site\'s look', () => {
  const html = renderDraft({ action_type: 'blog-outline', content: { title: 'How salons cut no-shows', metaDescription: 'Reminders and deposits.', sections: [{ heading: 'Send reminders', body: 'Text 24 hours before.' }], suggestedFaqTopics: ['Do reminders work?'] } }, kit());
  assert.match(html, /How salons cut no-shows/);
  assert.match(html, /Send reminders/);
  assert.match(html, /Do reminders work\?/);
  assert.match(html, /font-size:60px/); // the site's own h1 style
});
test('a landing page draft shows its headline, button and section cards', () => {
  const html = renderDraft({ action_type: 'landing-page', content: { headline: 'Never lose a walk-in', subheadline: 'A live queue.', cta: 'Start free', sections: [{ heading: 'Live queue', body: 'See who is next.' }, { heading: 'Alerts', body: 'Text clients.' }, { heading: 'QR', body: 'Join from a phone.' }] } }, kit());
  assert.match(html, /Never lose a walk-in/);
  assert.match(html, /Start free/);
  assert.match(html, /pv-3/);
});
test('a translation draft shows the translated title and paragraphs', () => {
  const html = renderDraft({ action_type: 'translation', content: { translatedTitle: 'सैलुन सफ्टवेयर', translatedContent: 'पहिलो।\n\nदोस्रो।' } }, kit());
  assert.match(html, /सैलुन सफ्टवेयर/);
  assert.equal((html.match(/<p /g) || []).length, 2);
});
test('a meta title is drawn as the Google result it becomes', () => {
  const html = renderDraft({ action_type: 'meta-title', input: { page: '/blog/x/' }, content: { titles: ['Salon Software: Booking and Payments'], metaDescription: 'Run bookings in one place.' } }, kit());
  assert.match(html, /Salon Software: Booking and Payments/);
  assert.match(html, /\/blog\/x\//);
  assert.equal(renderDraft({ action_type: 'meta-title', content: { titles: [] } }, kit()), null);
});
test('a kind that is not a page of copy has no page preview', () => {
  assert.equal(renderDraft({ action_type: 'schema', content: { jsonLd: {} } }, kit()), null);
  assert.equal(renderDraft({ action_type: 'blog-outline', content: {} }, kit()), null);
});
test('draft words are escaped, and an unreachable site still gets a document', async () => {
  const doc = await draftPreviewFor(site, { action_type: 'blog-outline', content: { title: '<script>alert(1)</script>', sections: [] } }, { fetchImpl: noNet });
  assert.doesNotMatch(doc, /<script>alert/);
  assert.match(doc, /&lt;script&gt;/);
});

test('wait:false never holds the caller on a cold site: no stylesheets this time, the fetch still runs, and the next ask has them', async () => {
  const cold = { ...site, website_domain: 'cold-fonts-test.example' };
  let release; const gate = new Promise((r) => { release = r; });
  const slow = async () => { await gate; return { ok: true, text: async () => '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans">' }; };
  const t0 = Date.now();
  const first = await getSiteStylesheets(cold, slow, { wait: false });
  assert.deepEqual(first.hrefs, []);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(stylesheetsPending(cold), true);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stylesheetsPending(cold), false);
  assert.equal((await getSiteStylesheets(cold, noNet, { wait: false })).hrefs.length, 1);
});

test('the same site and design return the stored pictures; a different set of kinds is built separately', async () => {
  const a = await previewsFor(site, CONTENT_OPTIONS, { fetchImpl: noNet });
  const b = await previewsFor(site, CONTENT_OPTIONS, { fetchImpl: noNet });
  assert.equal(a, b);
  const only = await previewsFor(site, { 'landing-page': CONTENT_OPTIONS['landing-page'] }, { fetchImpl: noNet });
  assert.deepEqual(Object.keys(only), ['landing-page']);
  assert.notEqual(only, a);
});
