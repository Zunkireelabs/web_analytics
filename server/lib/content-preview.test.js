import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designKitFor, renderOption, previewsFor, getSiteStylesheets } from './content-preview.js';
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
