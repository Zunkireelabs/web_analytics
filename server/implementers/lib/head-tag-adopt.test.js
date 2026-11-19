import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptHeadTags, sameLinesIgnoringOrder, sameTagsIgnoringOrder } from './head-tag-adopt.js';

// REAL FILE: mobilise-website-11ty src/_includes/heads/services-index.njk (staging, 2026-11-19), first 28 lines, verbatim. The og:/twitter: tags the
// generators write are interleaved with og:type, og:locale, og:site_name, og:url, og:image(+size, alt) and twitter:image that they never write.
const HEAD = `
    
    <script defer src="../analytics.js"></script>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ title | escape }}</title>
    <meta name="description"
        content="{{ description | escape }}">
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
    <meta name="theme-color" content="#0A919B">
    <link rel="canonical" href="https://mobilise.agency/services/">
    <meta property="og:type" content="website">
    <meta property="og:locale" content="en_GB">
    <meta property="og:site_name" content="MOBILISE Agency">
    <meta property="og:title" content="B2B Marketing Services &amp; Creative Production | MOBILISE">
    <meta property="og:description" content="B2B strategy, creative production, design and development, sales enablement, and full-service campaign execution for global brands.">
    <meta property="og:url" content="https://mobilise.agency/services/">
    <meta property="og:image" content="https://mobilise.agency/images/Thumbnail.jpg">
    <meta property="og:image:width" content="2350">
    <meta property="og:image:height" content="588">
    <meta property="og:image:alt" content="MOBILISE B2B marketing services">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="B2B Marketing Services | MOBILISE">
    <meta name="twitter:description" content="Strategy, creative production, sales enablement and campaign execution for global B2B brands.">
    <meta name="twitter:image" content="https://mobilise.agency/images/Thumbnail.jpg">
    <link rel="icon" type="image/png" href="../images/favicon.png">
    <link
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;700;800&amp;family=Manrope:wght@400;700;800&amp;display=swap"
`;

test('canonical: the one existing tag is wrapped in place; nothing else changes', () => {
  const r = adoptHeadTags(HEAD, 'canonical', 'CANONICAL', 'src/_includes/heads/services-index.njk');
  assert.equal(r.ok, true);
  assert.match(r.content, /<!-- SEOAI:CANONICAL:START --><link rel="canonical" href="https:\/\/mobilise\.agency\/services\/"><!-- SEOAI:CANONICAL:END -->/);
  assert.equal(r.content.replace(/<!-- SEOAI:CANONICAL:(START|END) -->/g, ''), HEAD);         // removing the two comments gives the file back exactly
  assert.equal(sameLinesIgnoringOrder(HEAD, r.content), true);
});

test('openGraph: the five generator-owned tags move into ONE region, in their original order, and every other tag stays where it was', () => {
  const r = adoptHeadTags(HEAD, 'openGraph', 'OPENGRAPH', 'x.njk');
  assert.equal(r.ok, true);
  assert.equal(r.adopted, 5);
  const region = /<!-- SEOAI:OPENGRAPH:START -->\n([\s\S]*?)\n\s*<!-- SEOAI:OPENGRAPH:END -->/.exec(r.content)[1].split('\n').map((l) => l.trim());
  assert.deepEqual(region.map((l) => /(?:property|name)="([^"]+)"/.exec(l)[1]), ['og:title', 'og:description', 'twitter:card', 'twitter:title', 'twitter:description']);
  // tags the generators do NOT write are still outside the region, exactly once, untouched
  for (const keep of ['og:type', 'og:locale', 'og:site_name', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt', 'twitter:image']) {
    assert.equal(r.content.split('\n').filter((l) => l.includes(`"${keep}"`)).length, 1, keep);
    assert.ok(!region.some((l) => l.includes(`"${keep}"`)), `${keep} must not be inside the region`);
  }
  assert.equal(sameLinesIgnoringOrder(HEAD, r.content), true);                              // same lines, nothing lost, nothing duplicated
});

test('openGraph: values are byte-for-byte the original; the title tag, meta description and the rest of the head are not touched', () => {
  const r = adoptHeadTags(HEAD, 'openGraph', 'OPENGRAPH', 'x.njk');
  assert.match(r.content, /<meta property="og:title" content="B2B Marketing Services &amp; Creative Production \| MOBILISE">/);
  assert.match(r.content, /<title>\{\{ title \| escape \}\}<\/title>/);
  assert.match(r.content, /<link rel="icon" type="image\/png" href="\.\.\/images\/favicon\.png">/);
});

test('running it a second time refuses: the tags are inside a marker now, so nothing is moved twice', () => {
  const once = adoptHeadTags(HEAD, 'openGraph', 'OPENGRAPH', 'x.njk').content;
  assert.deepEqual(adoptHeadTags(once, 'openGraph', 'OPENGRAPH', 'x.njk'), { ok: false, reason: 'already-in-a-marker' });
  const c = adoptHeadTags(HEAD, 'canonical', 'CANONICAL', 'x.njk').content;
  assert.deepEqual(adoptHeadTags(c, 'canonical', 'CANONICAL', 'x.njk'), { ok: false, reason: 'already-in-a-marker' });
});

test('refuses instead of guessing: a tag twice, nothing to adopt, a JSX file, an unknown field', () => {
  assert.equal(adoptHeadTags(HEAD + '<link rel="canonical" href="https://x.com/">', 'canonical', 'C', 'x.njk').reason, 'canonical-more-than-once');
  assert.equal(adoptHeadTags(HEAD + '<meta property="og:title" content="again">', 'openGraph', 'O', 'x.njk').reason, 'tag-more-than-once');
  assert.equal(adoptHeadTags('<title>x</title>', 'openGraph', 'O', 'x.njk').reason, 'nothing-to-adopt');
  assert.equal(adoptHeadTags('<title>x</title>', 'canonical', 'C', 'x.njk').reason, 'nothing-to-adopt');
  assert.equal(adoptHeadTags(HEAD, 'canonical', 'C', 'src/app/layout.tsx').reason, 'jsx-not-supported');
  assert.equal(adoptHeadTags(HEAD, 'schema', 'S', 'x.njk').reason, 'not-adoptable');
});

test('a partial set is adopted as it is (a missing tag is added by the first fix), and a multi-line tag moves whole', () => {
  const some = '<head>\n    <meta property="og:title" content="T">\n    <meta name="twitter:description"\n        content="D">\n    <meta property="og:image" content="I">\n</head>\n';
  const r = adoptHeadTags(some, 'openGraph', 'OPENGRAPH', 'x.njk');
  assert.equal(r.ok, true);
  assert.equal(r.adopted, 2);
  assert.match(r.content, /<meta name="twitter:description"\n {8}content="D">/);            // the tag's own line break is kept
  assert.equal(r.content.split('\n').filter((l) => l.includes('og:image')).length, 1);
  assert.equal(sameLinesIgnoringOrder(some, r.content), true);
});

test('sameLinesIgnoringOrder: a lost, duplicated or edited line fails; markers and order do not matter', () => {
  const a = '<a>\n<b>\n<c>\n';
  assert.equal(sameLinesIgnoringOrder(a, '<c>\n<!-- SEOAI:X:START -->\n<a>\n<b>\n<!-- SEOAI:X:END -->\n'), true);
  assert.equal(sameLinesIgnoringOrder(a, '<a>\n<b>\n'), false);
  assert.equal(sameLinesIgnoringOrder(a, '<a>\n<b>\n<c>\n<c>\n'), false);
  assert.equal(sameLinesIgnoringOrder(a, '<a>\n<b>\n<d>\n'), false);
});

// ---- the whole point: after adoption, the daily run's own fix writes INTO the region, replacing the old tags, with no duplicates ----
import { spliceMarkers, buildMergeValues } from './marker-merge.js';

test('end to end: an Open Graph fix applied over the adopted region leaves exactly one of each tag, and every other tag is untouched', () => {
  const adopted = adoptHeadTags(HEAD, 'openGraph', 'OPENGRAPH', 'x.njk').content;
  const built = buildMergeValues('open-graph', { ogTitle: 'New title | MOBILISE', ogDescription: 'New description.' });
  assert.equal(built.ok, true);
  const out = spliceMarkers(adopted, { openGraph: 'OPENGRAPH' }, built.values);
  assert.equal(out.ok, true);
  const lines = out.newContent.split('\n');
  const count = (needle) => lines.filter((l) => l.includes(needle)).length;
  for (const once of ['property="og:title"', 'property="og:description"', 'name="twitter:card"', 'name="twitter:title"', 'name="twitter:description"']) assert.equal(count(once), 1, once);
  assert.match(out.newContent, /<meta property="og:title" content="New title \| MOBILISE">/);
  for (const kept of ['og:type', 'og:locale', 'og:site_name', 'og:url', 'og:image"', 'og:image:width', 'og:image:height', 'og:image:alt', 'twitter:image']) assert.equal(count(`"${kept.replace('"', '')}"`), 1, kept);
  assert.match(out.newContent, /<title>\{\{ title \| escape \}\}<\/title>/);
});

test('end to end: a canonical fix applied over the wrapped tag replaces it, once', () => {
  const wrapped = adoptHeadTags(HEAD, 'canonical', 'CANONICAL', 'x.njk').content;
  const built = buildMergeValues('canonical', { canonicalUrl: 'https://mobilise.agency/services/' });
  assert.equal(built.ok, true, JSON.stringify(built));
  const out = spliceMarkers(wrapped, { canonical: 'CANONICAL' }, built.values);
  assert.equal(out.ok, true);
  assert.equal(out.newContent.split('\n').filter((l) => /rel="canonical"/.test(l)).length, 1);
});


// ---- a minified head: several tags on ONE line (REAL: mobilise-website-11ty src/_includes/heads/about-us-index.njk, lines 10-11) ----
const MINIFIED = `<title>{{ title | escape }}</title>
    <link rel="canonical" href="https://mobilise.agency/about-us/">
    <meta property="og:type" content="website"><meta property="og:locale" content="en_GB"><meta property="og:site_name" content="MOBILISE Agency"><meta property="og:title" content="About MOBILISE | Global B2B Marketing Agency"><meta property="og:description" content="MOBILISE is a global B2B marketing agency.">
    <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="About MOBILISE"><meta name="twitter:description" content="A global B2B agency."><meta name="twitter:image" content="https://mobilise.agency/images/Thumbnail.jpg">
`;

test('a minified head: the five tags are moved out of shared lines into one region, and the tags that stay are untouched', () => {
  const r = adoptHeadTags(MINIFIED, 'openGraph', 'OPENGRAPH', 'x.njk');
  assert.equal(r.ok, true);
  assert.equal(r.adopted, 5);
  assert.equal(sameTagsIgnoringOrder(MINIFIED, r.content), true);
  assert.equal(sameLinesIgnoringOrder(MINIFIED, r.content), false);          // the line-based check would have refused it: that is why the finer one exists
  const region = /<!-- SEOAI:OPENGRAPH:START -->\n([\s\S]*?)\n\s*<!-- SEOAI:OPENGRAPH:END -->/.exec(r.content)[1];
  for (const tag of ['og:title', 'og:description', 'twitter:card', 'twitter:title', 'twitter:description']) assert.equal((region.match(new RegExp(`"${tag}"`, 'g')) || []).length, 1, tag);
  for (const keep of ['og:type', 'og:locale', 'og:site_name', 'twitter:image']) {
    assert.equal((r.content.match(new RegExp(`"${keep}"`, 'g')) || []).length, 1, keep);
    assert.ok(!region.includes(`"${keep}"`), `${keep} must stay outside the region`);
  }
});

test('sameTagsIgnoringOrder: a lost, duplicated or edited tag fails; reordering and line breaks do not', () => {
  const a = '<meta a="1"><meta b="2">\n<link c="3">';
  assert.equal(sameTagsIgnoringOrder(a, '<link c="3">\n<!-- SEOAI:X:START -->\n<meta b="2">\n<meta a="1">\n<!-- SEOAI:X:END -->'), true);
  assert.equal(sameTagsIgnoringOrder(a, '<meta a="1"><meta b="2">'), false);
  assert.equal(sameTagsIgnoringOrder(a, a + '<meta b="2">'), false);
  assert.equal(sameTagsIgnoringOrder(a, '<meta a="1"><meta b="9">\n<link c="3">'), false);
});
