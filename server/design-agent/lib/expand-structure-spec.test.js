import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateExpandStructureSpec, deriveExpandStructureSpec, observeStructure, expandStructurePrior,
  structurePlanText, assertLayoutMatchesPrior, isExpandStructureRefEnabled, SPEC_VERSION,
} from './expand-structure-spec.js';

const sec = (role, components = [], tags = ['h2']) => ({ role, components: components.map((type) => ({ type })), textHierarchy: tags.map((tag) => ({ role: 'heading', tag })) });
const page = (url, pageType, sections) => ({ url, pageType, sections });

// A reference-shaped page: hero, three card sections, faq, cta.
const refPage = (n = 3) => page('https://ref.example/a', 'service', [
  sec('header'), sec('hero'), ...Array.from({ length: n }, () => sec('content', ['card'])), sec('faq', ['accordion']), sec('cta', ['button']), sec('footer'),
]);

const goodSpec = () => ({
  version: SPEC_VERSION, sectionCount: { min: 2, max: 4 }, sectionOrder: ['hero', 'content', 'faq', 'cta'],
  shapes: { content: 'card' }, headingLevels: { content: 'section' }, tableUsage: { allowed: false },
  placement: { anchor: 'after-last-content-section', before: ['faq', 'cta'] },
});

describe('validateExpandStructureSpec — the identity firewall', () => {
  test('a clean spec passes', () => assert.equal(validateExpandStructureSpec(goodSpec()).ok, true));

  test('rejects a Tailwind utility, a hex colour and a px value anywhere in it', () => {
    for (const [label, mutate] of [
      ['text-2xl', (s) => { s.sectionOrder = ['content', 'text-2xl']; }],
      ['#292461', (s) => { s.placement.before = ['#292461']; }],
      ['24px', (s) => { s.notes = '24px'; }],
    ]) {
      const s = goodSpec(); mutate(s);
      const v = validateExpandStructureSpec(s);
      assert.equal(v.ok, false, label);
    }
  });

  test('catches identity hidden in a free-text field even if the field were added later', () => {
    // The closed schema already rejects the unknown key; this proves the
    // SECOND layer would catch the value on its own.
    const s = goodSpec(); s.extra = 'bg-indigo-900 md:text-3xl';
    const v = validateExpandStructureSpec(s);
    assert.ok(v.errors.some((e) => /utility class/.test(e)));
    assert.ok(v.errors.some((e) => /unknown field/.test(e)));
  });

  test('rejects a class attribute, a url, an rgb() and an unknown role or shape', () => {
    for (const mutate of [
      (s) => { s.x = 'class="p-4"'; }, (s) => { s.x = 'https://site.example'; }, (s) => { s.x = 'rgb(1,2,3)'; },
      (s) => { s.sectionOrder = ['banner']; }, (s) => { s.shapes = { content: 'masonry' }; },
    ]) { const s = goodSpec(); mutate(s); assert.equal(validateExpandStructureSpec(s).ok, false); }
  });

  test('placement is an anchor RULE: a marker name or byte offset is refused', () => {
    const s = goodSpec(); s.placement.anchor = 'ZK-MARKER-12'; assert.equal(validateExpandStructureSpec(s).ok, false);
  });

  test('section count must be sane integers within bounds', () => {
    for (const sc of [{ min: 0, max: 3 }, { min: 3, max: 2 }, { min: 1, max: 9 }, { min: 1.5, max: 3 }]) {
      const s = goodSpec(); s.sectionCount = sc; assert.equal(validateExpandStructureSpec(s).ok, false);
    }
  });

  test('non-objects are refused', () => { for (const v of [null, [], 'x', 3]) assert.equal(validateExpandStructureSpec(v).ok, false); });
});

describe('observeStructure / deriveExpandStructureSpec', () => {
  test('reads section count, role order, shape, heading level and placement from pages', () => {
    const r = deriveExpandStructureSpec([refPage(3), refPage(3), refPage(4)]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.spec.sectionOrder, ['hero', 'content', 'faq', 'cta']);
    assert.equal(r.spec.shapes.content, 'card');
    assert.equal(r.spec.headingLevels.content, 'section');
    assert.deepEqual(r.spec.placement.before, ['faq', 'cta']);
    assert.equal(r.spec.tableUsage.allowed, false);
    assert.ok(r.spec.sectionCount.min >= 3 && r.spec.sectionCount.max <= 5);
  });

  test('header and footer chrome never count as sections', () => {
    assert.equal(observeStructure([refPage(2)]).sectionCount.max, 2);
  });

  test('a table anywhere makes tables allowed', () => {
    const p = page('u', 'service', [sec('content', ['table']), sec('content', [])]);
    assert.equal(deriveExpandStructureSpec([p]).spec.tableUsage.allowed, true);
  });

  test('a derived spec is always validated — and never contains a class from the source pages', () => {
    const p = page('u', 'service', [{ role: 'content', components: [{ type: 'card', classes: 'bg-indigo-900 rounded-xl' }], textHierarchy: [{ role: 'heading', tag: 'h2', classes: 'text-4xl text-[#292461]' }] }]);
    const r = deriveExpandStructureSpec([p]);
    assert.equal(r.ok, true);
    assert.equal(JSON.stringify(r.spec).includes('indigo'), false);
    assert.equal(JSON.stringify(r.spec).includes('text-4xl'), false);
  });

  test('no usable pages yields nulls from observe and safe defaults from derive', () => {
    assert.equal(observeStructure([]).sectionCount, null);
    assert.equal(deriveExpandStructureSpec([]).ok, true);
  });
});

describe('expandStructurePrior — the tenant wins per field', () => {
  test('a tenant with NO evidence gets the reference, and the sources say so', () => {
    const p = expandStructurePrior(goodSpec(), { pages: [] }, { pageType: 'service' });
    assert.deepEqual(p.sectionCount, { min: 2, max: 4 });
    assert.equal(p.sources.sectionCount, 'reference');
    assert.equal(p.tenantPagesObserved, 0);
  });

  test("a tenant whose service pages are two long prose sections is NOT given the reference's card grid", () => {
    // The objection worth hearing: borrowed structure must not override what
    // the tenant's own pages plainly do.
    const tenant = { pages: [page('t', 'service', [sec('hero'), sec('content', []), sec('content', [])])] };
    const p = expandStructurePrior(goodSpec(), tenant, { pageType: 'service' });
    assert.equal(p.shapes.content, 'prose');
    assert.equal(p.sources.shapes.content, 'tenant');
    assert.deepEqual(p.sectionCount, { min: 2, max: 2 });
    assert.equal(p.sources.sectionCount, 'tenant');
  });

  test('fields the tenant shows nothing about still fall back, per field not per spec', () => {
    const tenant = { pages: [page('t', 'service', [sec('content', ['list'])])] };
    const p = expandStructurePrior(goodSpec(), tenant, { pageType: 'service' });
    assert.equal(p.shapes.content, 'list');
    assert.equal(p.sources.shapes.content, 'tenant');
    assert.equal(p.sources.placement, 'tenant');
  });

  test('a table is allowed only when neither side forbids it: the tenant\'s own no-table evidence wins over a reference that uses them', () => {
    const spec = goodSpec(); spec.tableUsage.allowed = true;
    const tenant = { pages: [page('t', 'service', [sec('content', ['card'])])] };
    assert.equal(expandStructurePrior(spec, tenant, { pageType: 'service' }).tableUsage.allowed, false);
  });

  test('an invalid reference spec yields no prior at all, never a half-trusted one', () => {
    const bad = goodSpec(); bad.shapes = { content: 'text-2xl' };
    assert.equal(expandStructurePrior(bad, { pages: [] }), null);
    assert.equal(expandStructurePrior(null, {}), null);
  });

  test('only the requested page type is read as tenant evidence', () => {
    const tenant = { pages: [page('t', 'blog-article', [sec('content', ['list'])])] };
    assert.equal(expandStructurePrior(goodSpec(), tenant, { pageType: 'service' }).shapes.content, 'card');
  });
});

describe('structurePlanText', () => {
  test('states counts and role order in words, with no class anywhere', () => {
    const t = structurePlanText(expandStructurePrior(goodSpec(), { pages: [] }));
    assert.match(t, /Write 2 to 4 section\(s\)/);
    assert.match(t, /hero → faq → cta/);
    assert.match(t, /Do not use a table/);
    // The plan text is prompt material, so it must itself be free of identity.
    assert.equal(/#[0-9a-f]{3,8}\b|\b\d+px\b|class=/i.test(t), false);
  });
  test('no prior is no text', () => assert.equal(structurePlanText(null), ''));
});

describe('assertLayoutMatchesPrior', () => {
  const prior = expandStructurePrior(goodSpec(), { pages: [] });
  const profile = { components: { card: { wrapper: 'border rounded-xl p-6' } } };
  test('a heading of the wrong level is refused', () => {
    assert.equal(assertLayoutMatchesPrior({ wrapper: '<div>{{ROWS}}</div>', row: '<section><h3>{{HEADING}}</h3>{{BODY}}</section>' }, prior, profile).reason, 'prior-heading-level');
  });
  test('a card shape must reuse the tenant\'s OWN card vocabulary', () => {
    assert.equal(assertLayoutMatchesPrior({ wrapper: '<div>{{ROWS}}</div>', row: '<section class="flex"><h2>{{HEADING}}</h2>{{BODY}}</section>' }, prior, profile).detail, 'card');
    assert.equal(assertLayoutMatchesPrior({ wrapper: '<div>{{ROWS}}</div>', row: '<section class="p-6 border"><h2>{{HEADING}}</h2>{{BODY}}</section>' }, prior, profile).ok, true);
  });
  test('a card shape is not enforced when the tenant has no card vocabulary — never invented', () => {
    assert.equal(assertLayoutMatchesPrior({ wrapper: '<div>{{ROWS}}</div>', row: '<section><h2>{{HEADING}}</h2>{{BODY}}</section>' }, prior, {}).ok, true);
  });
  test('no prior asserts nothing', () => assert.equal(assertLayoutMatchesPrior({}, null, {}).ok, true));
});

test('opt-in is explicit and defaults off', () => {
  assert.equal(isExpandStructureRefEnabled({ url_file_map: { siteRoot: { expandStructureRef: true } } }), true);
  assert.equal(isExpandStructureRefEnabled({ url_file_map: { siteRoot: {} } }), false);
  assert.equal(isExpandStructureRefEnabled({ url_file_map: { siteRoot: { expandStructureRef: 'true' } } }), false);
  assert.equal(isExpandStructureRefEnabled(null), false);
});
