import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHex, hexFromAccent, accentOf, contrast, onColor, textSafe, resolveBrand, brandPayload, websiteOf, FALLBACK } from './brand.js';

const withAccent = (accent) => ({ name: 'A', url_file_map: { siteRoot: { designProfile: { color: { accent } } } } });

test('normalizeHex accepts #rrggbb or rrggbb and rejects everything else', () => {
  assert.equal(normalizeHex('#6F9B34'), '#6f9b34');
  assert.equal(normalizeHex('0d1282'), '#0d1282');
  assert.equal(normalizeHex('#FFF'), '#ffffff');
  for (const bad of ['red', '', null, undefined, '#12345g', 'javascript:1']) assert.equal(normalizeHex(bad), null);
});

test('the colour comes from the design profile accent; classes without a colour give null, not a guess', () => {
  assert.equal(hexFromAccent('bg-[#0D1282]'), '#0d1282');
  assert.equal(hexFromAccent('#c8a96e'), '#c8a96e');
  assert.equal(hexFromAccent('text-zunkiree-600'), null);
  assert.equal(accentOf(withAccent('#c8a96e')), '#c8a96e');
  assert.equal(accentOf({ name: 'A' }), null);
});

test('no usable colour gets the Zunkiree green, never another client\'s colour; grey and near-white are skipped', () => {
  for (const site of [{ name: 'A' }, withAccent(null), withAccent('text-zunkiree-600'), withAccent('#9ca3af'), withAccent('#fafafa')]) {
    assert.equal(resolveBrand(site).color, FALLBACK);
    assert.equal(resolveBrand(site).custom, false);
  }
  assert.equal(resolveBrand(withAccent('#c8a96e')).color, '#c8a96e');
});

test('the three real client colours get readable band text', () => {
  assert.equal(onColor('#6f9b34'), '#ffffff'); // sage keeps white text, as in the approved mockup
  assert.equal(onColor('#0d1282'), '#ffffff');
  assert.equal(onColor('#c8a96e'), '#171717'); // light gold gets dark text instead of unreadable white
  assert.equal(onColor('#fdf000'), '#171717');
});

test('textSafe darkens a light colour until it reads on white, and leaves a dark one alone', () => {
  for (const c of ['#c8a96e', '#6f9b34', '#fdf000']) assert.ok(contrast(textSafe(c), '#ffffff') >= 4.5, c);
  assert.equal(textSafe('#0d1282'), '#0d1282');
});

test('tint is pale and the soft bar sits between the colour and white', () => {
  const b = resolveBrand(withAccent('#0d1282'));
  assert.ok(contrast(b.tint, '#ffffff') < 1.35, 'tint stays pale');
  assert.ok(contrast(b.tint, '#ffffff') > 1.0);
  assert.notEqual(b.barSoft, b.color);
  assert.equal(b.custom, true);
});

test('an explicit project colour wins over the design profile', () => {
  const site = { name: 'C', brand_color: '#c8a96e', url_file_map: { siteRoot: { designProfile: { color: { accent: '#0d1282' } } } } };
  assert.equal(accentOf(site), '#c8a96e');
});

test('a colour class name is skipped and the primary button colour is used (the real Admizz profile shape)', () => {
  const admizz = { name: 'Admizz Education', url_file_map: { siteRoot: { designProfile: {
    color: { text: 'text-slate', muted: 'text-white/70', accent: 'text-blue-dark', border: 'border-[#eef1f6]', surface: 'bg-white' },
    components: { button: { primary: 'inline-flex items-center gap-2 bg-[#0D1282] text-white font-semibold rounded-full hover:bg-[#1a237e]' } } } } } };
  assert.equal(accentOf(admizz), '#0d1282', 'the near-white border colour is skipped, the button navy is used');
  assert.equal(resolveBrand(admizz).color, '#0d1282');
});

test('a profile with only class names falls back to the Zunkiree green', () => {
  const zunkiree = { name: 'Zunkiree Labs', url_file_map: { siteRoot: { designProfile: { color: { accent: 'text-zunkiree-600' }, components: { button: { primary: 'bg-zunkiree-600 text-white' } } } } } };
  assert.equal(accentOf(zunkiree), null);
  assert.equal(resolveBrand(zunkiree).color, '#76b900');
});

test('brandPayload carries what the dashboard paints with, and the logo', () => {
  const p = brandPayload({ name: 'Chayce', brand_color: '#c8a96e', logo_data_url: 'data:image/png;base64,AAAA' });
  assert.equal(p.color, '#c8a96e');
  assert.equal(p.onColor, '#171717', 'light gold gets dark text on its band');
  assert.equal(p.logoDataUrl, 'data:image/png;base64,AAAA');
  assert.equal(brandPayload({ name: 'X' }).logoDataUrl, null);
});

test('the website is shown as people say it: no protocol, www or path', () => {
  assert.equal(websiteOf({ website_domain: 'https://admizzeducation.com/' }), 'admizzeducation.com');
  assert.equal(websiteOf({ website_domain: 'zunkireelabs.com' }), 'zunkireelabs.com');
  assert.equal(websiteOf({ website_domain: 'https://www.example.com/path?x=1' }), 'example.com');
  assert.equal(websiteOf({ website_domain: '' }), null);
  assert.equal(websiteOf({}), null);
  assert.equal(resolveBrand({ name: 'A', website_domain: 'https://a.example/' }).website, 'a.example');
});
