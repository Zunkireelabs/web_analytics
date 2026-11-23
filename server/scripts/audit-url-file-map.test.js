import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { __testables } from './audit-url-file-map.js';

const { describeNginxMarker, partitionPreDraftBlocked, targetRendersCode, classifyNginxMarker, summarizeExistingTracking, fileForAction, looksLikeOgPlaceholder, verifyLiveOpenGraph, verifyLiveCanonical, extractMetaContent } = __testables;

describe('extractMetaContent', () => {
  test('reads a real og:title content value', () => {
    const html = '<meta property="og:title" content="Study in Australia - Admizz Education">';
    assert.equal(extractMetaContent(html, 'og:title'), 'Study in Australia - Admizz Education');
  });

  test('returns null when the tag is absent', () => {
    assert.equal(extractMetaContent('<html></html>', 'og:title'), null);
  });

  test('returns null for an empty content attribute, not an empty string that looks truthy', () => {
    assert.equal(extractMetaContent('<meta property="og:title" content="">', 'og:title'), null);
  });

  test('keeps an apostrophe inside a double-quoted value (MOBILISE /contact/ regression: "Let\'s…" was cut to "Let")', () => {
    const html = '<meta property="og:description" content="Let\'s talk about your next campaign.">';
    assert.equal(extractMetaContent(html, 'og:description'), "Let's talk about your next campaign.");
  });

  test('keeps a double quote inside a single-quoted value', () => {
    assert.equal(extractMetaContent(`<meta property='og:title' content='The "best" agency'>`, 'og:title'), 'The "best" agency');
  });

  test('is attribute-order independent and decodes entities', () => {
    assert.equal(extractMetaContent('<meta content="Tom &amp; Jerry&#39;s" property="og:title">', 'og:title'), "Tom & Jerry's");
  });

  test('a > inside a value does not end the tag early', () => {
    assert.equal(extractMetaContent('<meta property="og:title" content="A > B comparison">', 'og:title'), 'A > B comparison');
  });

  test('does not match a different property that merely shares a prefix', () => {
    assert.equal(extractMetaContent('<meta property="og:title:extra" content="x">', 'og:title'), null);
  });
});

describe('looksLikeOgPlaceholder', () => {
  test('flags common scaffolding text', () => {
    for (const v of ['TODO', 'tbd', 'Lorem ipsum', 'Placeholder', 'Untitled', 'Coming Soon', 'test', 'xxx']) {
      assert.equal(looksLikeOgPlaceholder(v), true, `expected "${v}" to be flagged`);
    }
  });

  test('flags a suspiciously short fragment', () => {
    assert.equal(looksLikeOgPlaceholder('Hi'), true);
  });

  test('does not flag a real, short-but-legitimate title', () => {
    assert.equal(looksLikeOgPlaceholder('About Us | Admizz Education'), false);
    assert.equal(looksLikeOgPlaceholder('Home'), false, 'a real, common page title — "Home" is not on the denylist, only exact scaffolding phrases are');
  });

  test('does not flag a real description sentence', () => {
    assert.equal(looksLikeOgPlaceholder('Dreaming of studying abroad? We help you explore top destinations.'), false);
  });
});

describe('verifyLiveOpenGraph', () => {
  test('ok:true when both tags are present and look real', async () => {
    const html = '<meta property="og:title" content="Study in Australia - Admizz Education">'
      + '<meta property="og:description" content="Top universities, visa support, and scholarships.">';
    const result = await verifyLiveOpenGraph('https://example.com/', async () => ({ ok: true, html }));
    assert.equal(result.ok, true);
    assert.equal(result.title, 'Study in Australia - Admizz Education');
  });

  test('ok:false when og:title looks like placeholder text, even though it is present and non-empty', async () => {
    const html = '<meta property="og:title" content="TODO">'
      + '<meta property="og:description" content="Top universities, visa support, and scholarships.">';
    const result = await verifyLiveOpenGraph('https://example.com/', async () => ({ ok: true, html }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /placeholder/);
  });

  test('ok:false when the fetch itself fails — never guessed clean on missing evidence', async () => {
    const result = await verifyLiveOpenGraph('https://example.com/', async () => ({ ok: false, error: 'HTTP 404' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HTTP 404');
  });
});

describe('verifyLiveCanonical', () => {
  const page = 'https://example.com/glossary/x/';
  const run = (html) => verifyLiveCanonical(page, async () => ({ ok: true, html }));

  test('passes a self-referencing canonical (trailing slash differences ignored)', async () => {
    const r = await run('<link rel="canonical" href="https://example.com/glossary/x">');
    assert.equal(r.ok, true);
  });
  test('fails when no canonical is rendered', async () => {
    assert.equal((await run('<head></head>')).ok, false);
  });
  test('fails when the canonical points at a different page', async () => {
    const r = await run('<link rel="canonical" href="https://example.com/other/">');
    assert.equal(r.ok, false);
    assert.match(r.reason, /points elsewhere/);
  });
  test('fails closed on fetch error', async () => {
    const r = await verifyLiveCanonical(page, async () => ({ ok: false, error: 'HTTP 500' }));
    assert.deepEqual(r, { ok: false, reason: 'HTTP 500' });
  });
});

describe('fileForAction (MOBILISE /contact/ regression: head markers live in a partial, not the page file)', () => {
  const site = { url_file_map: { pages: { '/contact': {
    file: 'src/contact/index.njk',
    placements: {
      canonical: { file: 'src/_includes/heads/contact-index.njk' },
      'open-graph': { file: 'src/_includes/heads/contact-index.njk' },
    },
  } } } };

  test('routes open-graph and canonical to the head partial the implementer really writes', () => {
    assert.equal(fileForAction(site, '/contact/', 'open-graph', 'src/contact/index.njk'), 'src/_includes/heads/contact-index.njk');
    assert.equal(fileForAction(site, '/contact/', 'canonical', 'src/contact/index.njk'), 'src/_includes/heads/contact-index.njk');
  });

  test('keeps the page file for action types with no per-action file', () => {
    assert.equal(fileForAction(site, '/contact/', 'meta-title', 'src/contact/index.njk'), 'src/contact/index.njk');
  });

  test('does not leak one client\'s placement onto another site or page', () => {
    const other = { url_file_map: { pages: { '/contact': { file: 'src/contact.njk' } } } };
    assert.equal(fileForAction(other, '/contact/', 'open-graph', 'src/contact.njk'), 'src/contact.njk');
    assert.equal(fileForAction(site, '/about/', 'open-graph', 'src/about.njk'), 'src/about.njk');
  });
});

describe('summarizeExistingTracking (analytics already in the repo: SuperRank consent loader, MOBILISE analytics.js, Chayce inline GA4, Admizz GTM)', () => {
  const scan = (hits) => ({ ok: true, refs: [{ ref: 'main', hits }] });

  test('reports files and IDs when the repo already loads GA4', () => {
    const r = summarizeExistingTracking(scan([{ path: 'src/scripts/cookie-consent.js', ga4: ['G-7V8PXXZF3G'], gtm: [], gtag: true }]));
    assert.deepEqual(r.files, ['main:src/scripts/cookie-consent.js']);
    assert.deepEqual(r.ga4, ['G-7V8PXXZF3G']);
  });

  test('reports a GTM container', () => {
    const r = summarizeExistingTracking(scan([{ path: 'src/app/layout.tsx', ga4: [], gtm: ['GTM-ABCD123'], gtag: false }]));
    assert.deepEqual(r.gtm, ['GTM-ABCD123']);
  });

  test('a repo with no tracking is not "already installed"', () => {
    assert.equal(summarizeExistingTracking(scan([])), null);
  });

  test('an unreadable repo says nothing — never treated as already installed', () => {
    assert.equal(summarizeExistingTracking({ ok: false, error: 'the repository could not be read at main' }), null);
    assert.equal(summarizeExistingTracking(null), null);
  });
});

describe('classifyNginxMarker (the marker is auto-inserted; only specific cases are real blockers)', () => {
  const simple = 'server {\n    listen 80;\n    root /usr/share/nginx/html;\n    location / { try_files $uri /index.html; }\n}\n';
  const ownHeaders = 'server {\n    listen 80;\n    root /usr/share/nginx/html;\n    add_header Referrer-Policy "strict-origin";\n    location ~* \\.html$ {\n        add_header Cache-Control "no-cache";\n    }\n}\n';

  test('a present marker is present', () => {
    assert.equal(classifyNginxMarker(simple.replace('listen 80;', 'listen 80;\n    # SEOAI:SECURITY-HEADERS:START\n    # SEOAI:SECURITY-HEADERS:END')).status, 'present');
  });

  test('a missing marker in a plain serving block self-heals — NOT "must be hand-placed"', () => {
    assert.equal(classifyNginxMarker(simple).status, 'self-heals');
  });

  test('a location with its own add_header is a genuine refusal (headers-not-inherited), reported as blocked with the locations', () => {
    const r = classifyNginxMarker(ownHeaders);
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'headers-not-inherited');
    assert.ok(r.locations.some((l) => l.includes('html')));
  });

  test('no serving server block is fatal', () => {
    assert.equal(classifyNginxMarker('upstream a { server 127.0.0.1:1; }\n').status, 'fatal');
  });
});

describe('targetRendersCode (Admizz .tsx render-capability false positives)', () => {
  const tsx = { dir: 'src/app', filename: 'page.tsx', extension: '.tsx' };

  test('blog-outline / direct-answer / translation with a filename render a component, not Markdown', () => {
    for (const t of ['blog-outline', 'direct-answer', 'translation']) assert.equal(targetRendersCode(t, tsx), true, t);
  });

  test('landing-page and compliance pages always render Markdown + front matter, so their .tsx gap is REAL and stays', () => {
    for (const t of ['landing-page', 'cookie-policy', 'terms-of-service', 'privacy-policy']) assert.equal(targetRendersCode(t, tsx), false, t);
  });

  test('without a filename (flat Markdown file mode) the Markdown gate still applies', () => {
    assert.equal(targetRendersCode('blog-outline', { dir: 'src/blog', extension: '.tsx' }), false);
  });

  test('a Markdown/Nunjucks extension is never treated as code', () => {
    assert.equal(targetRendersCode('blog-outline', { dir: 'src/blog', filename: 'index.md', extension: '.md' }), false);
  });
});

describe('partitionPreDraftBlocked (Admizz: wrapper pages whose body actions are already refused before any draft)', () => {
  const wrapper = "export default function Page() {\n  return <CountryPageTemplate data={d} />;\n}\n";
  const realPage = "export default function Page() {\n  return <section><h1>Hi</h1><p>Body text here</p></section>;\n}\n";
  const rows = (filePath, actionType) => ({ page: '/p', actionType, filePath, markerField: 'x', markerName: 'X', gap: 'fatal-no-safe-anchor' });
  const content = (m) => (p) => m[p] ?? null;

  test('a body action on a data-to-component wrapper is "already blocked", not fatal', () => {
    const r = partitionPreDraftBlocked([rows('a/page.tsx', 'internal-links')], content({ 'a/page.tsx': wrapper }));
    assert.equal(r.blocked.length, 1);
    assert.equal(r.stillFatal.length, 0);
    assert.match(r.blocked[0].blockedReason, /hands a data object to a shared component/);
  });

  test('the {...post} spread form is recognised too', () => {
    const r = partitionPreDraftBlocked([rows('b/page.tsx', 'qa-content')], content({ 'b/page.tsx': 'return <GeneratedBlogPost {...post} />;' }));
    assert.equal(r.blocked.length, 1);
  });

  test('a page with its own markup stays fatal — the gate would not block it', () => {
    const r = partitionPreDraftBlocked([rows('c/page.tsx', 'expand-content')], content({ 'c/page.tsx': realPage }));
    assert.equal(r.blocked.length, 0);
    assert.equal(r.stillFatal.length, 1);
  });

  test('non-body action types (schema, faq, canonical) are NOT swept in — the gate only covers body markup', () => {
    for (const t of ['schema', 'faq', 'canonical', 'meta-title', 'open-graph']) {
      const r = partitionPreDraftBlocked([rows('a/page.tsx', t)], content({ 'a/page.tsx': wrapper }));
      assert.equal(r.stillFatal.length, 1, t);
    }
  });

  test('an unreadable file stays fatal rather than being waved through', () => {
    const r = partitionPreDraftBlocked([rows('missing.tsx', 'internal-links')], content({}));
    assert.equal(r.stillFatal.length, 1);
  });
});

describe('describeNginxMarker (the audit crashed with "Cannot read properties of undefined (reading \'slice\')" on every status except blocked)', () => {
  test('present and self-heals do not need a locations list, and must not throw', () => {
    assert.equal(describeNginxMarker(classifyNginxMarker('server {\n    root /x;\n    # SEOAI:SECURITY-HEADERS:START\n    # SEOAI:SECURITY-HEADERS:END\n}\n')), 'present');
    assert.match(describeNginxMarker({ status: 'self-heals' }), /self-healing/);
  });
  test('blocked names the offending locations and the refusal reason', () => {
    const out = describeNginxMarker({ status: 'blocked', reason: 'headers-not-inherited', locations: ['~* \\.html$', '/api'] });
    assert.match(out, /REFUSED \(headers-not-inherited\)/);
    assert.match(out, /\.html\$, \/api set their own add_header/);
  });
  test('blocked without a locations array still does not throw', () => {
    assert.doesNotThrow(() => describeNginxMarker({ status: 'blocked', reason: 'headers-not-inherited' }));
  });
  test('fatal states the reason', () => {
    assert.match(describeNginxMarker({ status: 'fatal', reason: 'no-insertion-marker' }), /MISSING \(fatal: no-insertion-marker/);
  });
  test('every status the classifier can return has a description (no silent default)', () => {
    for (const status of ['present', 'self-heals', 'blocked', 'fatal']) assert.doesNotMatch(describeNginxMarker({ status, reason: 'r', locations: [] }), /unknown status/);
  });
});
