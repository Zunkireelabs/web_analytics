import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../../design-agent/live-analysis/capture.js';
import {
  OWNER, MAX_REPAIR_ATTEMPTS, MAX_DEFERRALS, REPAIRABLE_REASONS, PENDING_REASON,
  scanDraftHazards, decideOwner, buildCorrection, summarizeDiagnosis,
  diagnoseDesignFailure, investigateAndRepairDesign,
} from './design-repair.js';

// ---- pure: hazards ---------------------------------------------------------

test('scanDraftHazards: clean prose has none', () => {
  assert.deepEqual(scanDraftHazards('<h2>Heading</h2><p>Plain paragraph of text.</p>'), []);
});

test('scanDraftHazards: names each layout hazard the draft itself carries', () => {
  const kinds = (h) => scanDraftHazards(h).map((x) => x.kind);
  assert.ok(kinds('<p style="font-size:40px">x</p>').includes('inline-sizing'));
  assert.ok(kinds('<h1>Title</h1>').includes('stray-h1'));
  assert.ok(kinds(`<p>${'a'.repeat(80)}</p>`).includes('unbreakable-token'));
  assert.ok(kinds('<table><tr><td>x</td></tr></table>').includes('bare-table'));
  assert.ok(kinds('<iframe src="x"></iframe>').includes('iframe'));
});

test('scanDraftHazards: a long URL is not an unbreakable-token hazard, a wrapped table is not a bare table', () => {
  assert.deepEqual(scanDraftHazards(`<p>${'https://example.com/' + 'a'.repeat(80)}</p>`), []);
  assert.deepEqual(scanDraftHazards('<div style="overflow-x:auto"><table></table></div>').map((h) => h.kind).filter((k) => k === 'bare-table'), []);
});

// ---- pure: ownership -------------------------------------------------------

test('decideOwner: a gate that cannot reproduce the site\'s own page owns the failure, whatever else is true', () => {
  const r = decideOwner({ reason: 'render-deviation', gateControl: { reproduced: false }, hazards: [{ kind: 'inline-sizing' }], missingClasses: ['x'] });
  assert.equal(r.owner, OWNER.VALIDATION_GATE);
});

test('decideOwner: an incomplete captured design belongs to the Design Agent', () => {
  assert.equal(decideOwner({ reason: 'design-incomplete' }).owner, OWNER.DESIGN_CAPTURE);
  assert.equal(decideOwner({ reason: 'group-sample-unreachable' }).owner, OWNER.DESIGN_CAPTURE);
});

test('decideOwner: content hazards belong to the generator even when classes are also missing', () => {
  const r = decideOwner({ reason: 'render-deviation', hazards: [{ kind: 'stray-h1' }], missingClasses: ['post-text'] });
  assert.equal(r.owner, OWNER.GENERATOR);
});

test('decideOwner: classes the site\'s body carries and the rendered markup lost -> shared renderer', () => {
  assert.equal(decideOwner({ reason: 'render-deviation', missingClasses: ['post-text'], producedBy: 'renderer' }).owner, OWNER.SHARED_RENDERER);
});

test('decideOwner: the same missing classes are the generator\'s when the generator wrote the structure', () => {
  assert.equal(decideOwner({ reason: 'render-deviation', missingClasses: ['post-text'], producedBy: 'generator' }).owner, OWNER.GENERATOR);
});

test('decideOwner: with no outside explanation only the content is left to change', () => {
  assert.equal(decideOwner({ reason: 'responsive-regression' }).owner, OWNER.GENERATOR);
});

// ---- pure: the correction handed to a generator ----------------------------

test('buildCorrection: carries measured, element-level evidence — not a bare "something was off"', () => {
  const diagnosis = { cause: 'the draft\'s own content breaks layout: inline-sizing', hazards: [{ detail: '1 element(s) set their own size inline' }] };
  const text = buildCorrection({ diagnosis, failure: {
    deviations: [{ kind: 'heading-scale', expected: 52, actual: 40, viewport: 'desktop' }],
    regressions: [{ kind: 'clipped-content', width: 1440, viewport: 'desktop', elements: [{ tag: 'table', text: 'Plan' }] }],
  } });
  assert.match(text, /heading-scale: the site renders 52, the draft 40 \(desktop\)/);
  assert.match(text, /<table> "Plan"/);
  assert.match(text, /set their own size inline/);
  assert.match(text, /Root cause found/);
});

test('summarizeDiagnosis names the owner in plain words', () => {
  assert.match(summarizeDiagnosis({ owner: OWNER.SHARED_RENDERER, cause: 'x' }), /shared page renderer/);
  assert.equal(summarizeDiagnosis(null), '');
});

// ---- the loop --------------------------------------------------------------

const FAIL = { ok: false, reason: 'render-deviation', deviations: [{ kind: 'line-length', expected: 64, actual: 160, viewport: 'desktop' }], referenceUrl: 'https://site.test/p' };
const generatorDiagnosis = { owner: OWNER.GENERATOR, cause: 'content', evidence: ['e'], hazards: [], correction: 'FIX', summary: '' };
const ownerDiagnosis = (owner) => async () => ({ ...generatorDiagnosis, owner });

test('a draft that passes first time is returned untouched, with no diagnosis and no regeneration', async () => {
  let regenerated = 0;
  const r = await investigateAndRepairDesign({ content: 'v1', check: async () => ({ ok: true }), regenerate: async () => { regenerated++; return 'x'; } });
  assert.equal(r.status, 'passed');
  assert.equal(r.ok, true);
  assert.equal(r.content, 'v1');
  assert.equal(regenerated, 0);
  assert.equal(r.diagnosis, null);
});

test('a generator-owned failure is repaired, re-checked, and only then reported as passing', async () => {
  const seen = [];
  const r = await investigateAndRepairDesign({
    content: 'v1', producedBy: 'generator',
    check: async (c) => { seen.push(c); return c === 'v2' ? { ok: true } : FAIL; },
    regenerate: async (correction) => { assert.equal(correction, 'FIX'); return 'v2'; },
    diagnose: async () => generatorDiagnosis,
  });
  assert.deepEqual(seen, ['v1', 'v2']);
  assert.equal(r.status, 'passed-after-repair');
  assert.equal(r.ok, true);
  assert.equal(r.content, 'v2');
  assert.equal(r.attempts[0].outcome, 'passed the re-check');
});

test('the retry budget is exactly MAX_REPAIR_ATTEMPTS real checks, then it stops — and never reports success', async () => {
  let checks = 0; let regens = 0;
  const r = await investigateAndRepairDesign({
    content: 'v', check: async () => { checks++; return FAIL; }, regenerate: async () => { regens++; return `v${regens}`; },
    diagnose: async () => generatorDiagnosis,
  });
  assert.equal(MAX_REPAIR_ATTEMPTS, 3);
  assert.equal(checks, 3);
  assert.equal(regens, 2);
  assert.equal(r.status, 'exhausted');
  assert.equal(r.ok, false);
  assert.equal(r.result.ok, false);
  assert.equal(r.attempts.length, 3);
  assert.ok(r.diagnosis, 'a person gets the diagnosis, not just "failed"');
});

test('a generator that cannot produce a repair ends the loop honestly', async () => {
  const r = await investigateAndRepairDesign({ content: 'v', check: async () => FAIL, regenerate: async () => null, diagnose: async () => generatorDiagnosis });
  assert.equal(r.status, 'exhausted');
  assert.equal(r.ok, false);
  assert.match(r.attempts[0].outcome, /could not produce/);
});

for (const [owner, hook, pending] of [
  [OWNER.SHARED_RENDERER, 'sharedCode', 'shared-code-repair-pending'],
  [OWNER.VALIDATION_GATE, 'sharedCode', 'shared-code-repair-pending'],
  [OWNER.DESIGN_CAPTURE, 'designCapture', 'design-capture-refresh-pending'],
]) {
  test(`a ${owner}-owned failure is handed to its owner, never "fixed" by rewriting content`, async () => {
    let regens = 0; const called = [];
    const r = await investigateAndRepairDesign({
      content: 'v', check: async () => FAIL, regenerate: async () => { regens++; return 'x'; }, diagnose: ownerDiagnosis(owner),
      handoff: { [hook]: async (d) => { called.push(d.owner); return { requested: true, detail: 'queued' }; } },
    });
    assert.equal(regens, 0);
    assert.deepEqual(called, [owner]);
    assert.equal(r.status, 'deferred');
    assert.equal(r.ok, false);
    assert.equal(r.pendingReason, pending);
    assert.equal(PENDING_REASON[owner], pending);
  });
}

test('a hand-off nobody took (refused, failing, missing, or a bare string) is EXHAUSTED and goes to a person — never "deferred" forever', async () => {
  const refusals = [
    { sharedCode: async () => ({ requested: false, detail: 'shared code repair: disabled' }) },
    { sharedCode: async () => { throw new Error('boom'); } },
    { sharedCode: async () => 'opened' }, // an unstructured answer is not proof anyone took the work
    {},
  ];
  for (const handoff of refusals) {
    const r = await investigateAndRepairDesign({ content: 'v', check: async () => FAIL, regenerate: async () => 'x', diagnose: ownerDiagnosis(OWNER.SHARED_RENDERER), handoff });
    assert.equal(r.status, 'exhausted');
    assert.equal(r.handedToPerson, true);
    assert.equal(r.ok, false);
    assert.equal(r.pendingReason, undefined);
    assert.match(r.attempts[0].outcome, /nobody could take this on/);
  }
});

test('the refusal reason travels with the diagnosis so a person can see why nothing was automatic', async () => {
  const r = await investigateAndRepairDesign({
    content: 'v', check: async () => FAIL, regenerate: async () => 'x', diagnose: ownerDiagnosis(OWNER.VALIDATION_GATE),
    handoff: { sharedCode: async () => ({ requested: false, detail: 'shared code repair: disabled' }) },
  });
  assert.match(r.attempts[0].outcome, /disabled/);
  assert.equal(r.diagnosis.owner, OWNER.VALIDATION_GATE);
});

test('a failure that is not a design problem is passed straight back, untouched', async () => {
  let diagnosed = 0;
  const failure = { ok: false, reason: 'no-file-mapping' };
  const r = await investigateAndRepairDesign({ content: 'v', check: async () => failure, regenerate: async () => 'x', diagnose: async () => { diagnosed++; return generatorDiagnosis; } });
  assert.equal(r.status, 'not-repairable');
  assert.equal(r.result, failure);
  assert.equal(diagnosed, 0);
});

test('a lesson is recorded when a repair worked, and when it did not; a lesson failure never changes the result', async () => {
  const lessons = [];
  await investigateAndRepairDesign({
    content: 'v1', check: async (c) => (c === 'v2' ? { ok: true } : FAIL), regenerate: async () => 'v2', diagnose: async () => generatorDiagnosis,
    learn: async (l) => { lessons.push(l.outcome); },
  });
  await investigateAndRepairDesign({
    content: 'v', check: async () => FAIL, regenerate: async () => 'x', diagnose: async () => generatorDiagnosis,
    learn: async (l) => { lessons.push(l.outcome); },
  });
  assert.deepEqual(lessons, ['fixed', 'exhausted']);
  const r = await investigateAndRepairDesign({
    content: 'v', check: async () => FAIL, regenerate: async () => 'x', diagnose: async () => generatorDiagnosis,
    learn: async () => { throw new Error('store down'); },
  });
  assert.equal(r.status, 'exhausted');
});

test('REPAIRABLE_REASONS covers exactly the design verdicts', () => {
  assert.deepEqual([...REPAIRABLE_REASONS].sort(), ['design-incomplete', 'render-deviation', 'responsive-regression']);
});

// ---- diagnosis in a real browser, across differently built sites ----------

const SENTENCE = 'A representative paragraph of body copy long enough to wrap across several lines in the column. ';
const dataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
async function hasBrowser() { try { const b = await launchBrowser(); await b.close(); return true; } catch { return false; } }

// A site whose body elements carry the classes its CSS hangs on.
const CLASSED_SITE = `<!doctype html><style>
  body{font:16px/1.4 sans-serif;margin:0}.post{max-width:680px;margin:0 auto}
  .post .post-text{font-size:19px;line-height:1.7;margin:0 0 22px}.post .post-h2{font-size:34px;margin:36px 0 14px}
</style><body><main><div class="post"><h2 class="post-h2">Existing</h2>
  <p class="post-text">${SENTENCE.repeat(2)}</p><p class="post-text">${SENTENCE.repeat(2)}</p><p class="post-text">${SENTENCE.repeat(2)}</p></div></main></body>`;

// A site that styles bare elements under one wrapper (no classes on the body).
const BARE_SITE = `<!doctype html><style>
  body{font:16px/1.4 sans-serif;margin:0}article{max-width:700px;margin:0 auto}article p{font-size:18px;margin:0 0 20px}article h2{font-size:30px}
</style><body><article><h2>Existing</h2><p>${SENTENCE.repeat(2)}</p><p>${SENTENCE.repeat(2)}</p><p>${SENTENCE.repeat(2)}</p></article></body>`;

const failureFor = (html) => ({ reason: 'render-deviation', referenceUrl: dataUrl(html), deviations: [{ kind: 'body-size', expected: 19, actual: 16, viewport: 'desktop' }] });

test('browser: markup that lost the site\'s body classes is the SHARED RENDERER\'s problem, with the classes named', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: failureFor(CLASSED_SITE), draftHtml: '<h2>Heading</h2><p>Plain paragraph text.</p>', producedBy: 'renderer' });
  assert.equal(d.owner, OWNER.SHARED_RENDERER);
  assert.ok(d.evidence.some((e) => /post-text/.test(e)), JSON.stringify(d.evidence));
  assert.equal(d.inspected, true);
});

test('browser: markup that carries the site\'s classes is not blamed on the renderer', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const draft = '<h2 class="post-h2">Heading</h2><p class="post-text">Plain paragraph text.</p>';
  const d = await diagnoseDesignFailure({ failure: failureFor(CLASSED_SITE), draftHtml: draft, producedBy: 'renderer' });
  assert.notEqual(d.owner, OWNER.SHARED_RENDERER);
});

test('browser: a bare-element site has no classes to lose, so a plain draft is not a renderer problem', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: failureFor(BARE_SITE), draftHtml: '<h2>H</h2><p>Plain paragraph text.</p>', producedBy: 'renderer' });
  assert.notEqual(d.owner, OWNER.SHARED_RENDERER);
  assert.notEqual(d.owner, OWNER.VALIDATION_GATE);
});

test('browser: the control passes on real sites, so a gate fault is never assumed', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  for (const html of [CLASSED_SITE, BARE_SITE]) {
    const d = await diagnoseDesignFailure({ failure: failureFor(html), draftHtml: '<p>Plain.</p>' });
    assert.notEqual(d.owner, OWNER.VALIDATION_GATE);
  }
});

test('browser: inline sizing in the draft is the GENERATOR\'s, and the correction says exactly that', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: failureFor(BARE_SITE), draftHtml: '<h2 style="font-size:60px">H</h2><p>Text.</p>' });
  assert.equal(d.owner, OWNER.GENERATOR);
  assert.match(d.correction, /inline/i);
});

test('diagnosis degrades safely when the site cannot be inspected: it still names an owner and still never passes', async () => {
  const d = await diagnoseDesignFailure({
    failure: { reason: 'render-deviation', referenceUrl: 'https://x.invalid/', deviations: [] },
    draftHtml: '<p>x</p>', inspectFn: async () => ({ ok: false, reason: 'unreachable' }),
  });
  assert.equal(d.owner, OWNER.GENERATOR);
  assert.equal(d.inspected, false);
});

test('a gate whose control fails is reported as the validation gate\'s fault (injected inspection)', async () => {
  const d = await diagnoseDesignFailure({
    failure: { reason: 'render-deviation', referenceUrl: 'https://x.invalid/', deviations: [{ kind: 'line-length', expected: 72, actual: 160, viewport: 'desktop' }] },
    draftHtml: '<p>x</p>',
    inspectFn: async () => ({ ok: true, regionChain: ['main'], missingClasses: [], gateControl: { reproduced: false, deviations: [{ kind: 'line-length', expected: 72, actual: 160, viewport: 'desktop' }] } }),
  });
  assert.equal(d.owner, OWNER.VALIDATION_GATE);
  assert.ok(d.evidence.some((e) => /still reported/.test(e)));
});

// ---- existing-page path: the block is compared with the page's OWN elements ---

const MARKER_PAGE_CLASSED = `<!doctype html><style>
  body{font:16px/1.4 sans-serif;margin:0}.c{max-width:700px;margin:0 auto}.t-body{font-size:19px;line-height:1.7;margin:0 0 20px}.t-h2{font-size:30px}
</style><body><main class="c"><h2 class="t-h2">Page</h2>
  <p class="t-body">${SENTENCE}</p><p class="t-body">${SENTENCE}</p><p class="t-body">${SENTENCE}</p><p class="t-body">${SENTENCE}</p>
  <!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END --><p class="t-body">${SENTENCE}</p></main></body>`;
const MARKER_PAGE_BARE = `<!doctype html><style>
  body{font:16px/1.4 sans-serif;margin:0}.c{max-width:700px;margin:0 auto}
</style><body><main class="c"><h2>Page</h2><p>${SENTENCE}</p><p>${SENTENCE}</p><p>${SENTENCE}</p><p>${SENTENCE}</p>
  <!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END --><p>${SENTENCE}</p></main></body>`;
const markerFailure = (page) => ({
  reason: 'responsive-regression', pageUrl: dataUrl(page), marker: 'FAQ',
  regressions: [{ kind: 'undersized-tap-target', width: 390, viewport: 'mobile', elements: [{ tag: 'a', text: 'More' }] }],
});

test('browser, existing page: a block that lost the page\'s own element classes is the SHARED RENDERER\'s, with the classes named', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: markerFailure(MARKER_PAGE_CLASSED), draftHtml: '<section><h2>FAQ</h2><p>Plain answer text.</p></section>', producedBy: 'renderer' });
  assert.equal(d.owner, OWNER.SHARED_RENDERER);
  assert.ok(d.evidence.some((e) => /t-body/.test(e)), JSON.stringify(d.evidence));
  assert.equal(d.inspected, true);
});

test('browser, existing page: the typography mismatch is part of the evidence, in plain numbers', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: markerFailure(MARKER_PAGE_CLASSED), draftHtml: '<section><h2>FAQ</h2><p>Plain answer text.</p></section>' });
  assert.ok(d.evidence.some((e) => /19px.*16px/.test(e)), JSON.stringify(d.evidence));
});

test('browser, existing page: a block that carries the page\'s classes is not blamed on the renderer', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const draft = '<section><h2 class="t-h2">FAQ</h2><p class="t-body">Answer text.</p></section>';
  const d = await diagnoseDesignFailure({ failure: markerFailure(MARKER_PAGE_CLASSED), draftHtml: draft });
  assert.notEqual(d.owner, OWNER.SHARED_RENDERER);
});

test('browser, existing page: a page that styles bare elements has no classes to lose, so a bare block is not the renderer\'s', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: markerFailure(MARKER_PAGE_BARE), draftHtml: '<section><h2>FAQ</h2><p>Plain answer text.</p></section>' });
  assert.notEqual(d.owner, OWNER.SHARED_RENDERER);
});

test('browser, existing page: a block that styles its OWN question headings on purpose is not "lost classes"', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const draft = '<section><h3 class="faq-q">Question</h3><p class="t-body">Answer.</p></section>';
  const d = await diagnoseDesignFailure({ failure: markerFailure(MARKER_PAGE_CLASSED), draftHtml: draft });
  assert.notEqual(d.owner, OWNER.SHARED_RENDERER);
});

test('existing page: when the page cannot be re-rendered the diagnosis still names an owner and never passes', async () => {
  const d = await diagnoseDesignFailure({
    failure: markerFailure(MARKER_PAGE_BARE), draftHtml: '<p>x</p>', inspectMarkerFn: async () => ({ ok: false, reason: 'unreachable' }),
  });
  assert.equal(d.owner, OWNER.GENERATOR);
  assert.equal(d.inspected, false);
});

// ---- never "retry later" forever -------------------------------------------

test('an item already deferred MAX_DEFERRALS times goes to a person, WITHOUT asking the owner again', async () => {
  let asked = 0;
  const r = await investigateAndRepairDesign({
    content: 'v', check: async () => FAIL, regenerate: async () => 'x', diagnose: ownerDiagnosis(OWNER.SHARED_RENDERER),
    handoff: { sharedCode: async () => { asked++; return { requested: true, detail: 'started' }; } },
    priorDeferrals: MAX_DEFERRALS,
  });
  assert.equal(MAX_DEFERRALS, 3);
  assert.equal(asked, 0);
  assert.equal(r.status, 'exhausted');
  assert.equal(r.handedToPerson, true);
  assert.match(r.attempts[0].outcome, /waited 3 earlier run/);
});

test('below the cap the owner is still asked and the item is deferred as before', async () => {
  const r = await investigateAndRepairDesign({
    content: 'v', check: async () => FAIL, regenerate: async () => 'x', diagnose: ownerDiagnosis(OWNER.DESIGN_CAPTURE),
    handoff: { designCapture: async () => ({ requested: true, detail: 'queued' }) }, priorDeferrals: MAX_DEFERRALS - 1,
  });
  assert.equal(r.status, 'deferred');
});

test('the wait limit applies to every non-generator owner', async () => {
  for (const owner of [OWNER.SHARED_RENDERER, OWNER.VALIDATION_GATE, OWNER.DESIGN_CAPTURE]) {
    const r = await investigateAndRepairDesign({
      content: 'v', check: async () => FAIL, regenerate: async () => 'x', diagnose: ownerDiagnosis(owner),
      handoff: { sharedCode: async () => ({ requested: true }), designCapture: async () => ({ requested: true }) }, priorDeferrals: 5,
    });
    assert.equal(r.status, 'exhausted', owner);
  }
});

// ---- existing page, same depth as a new page: wrappers + computed styles, both viewports ----

const PROSE_PAGE = (markerInsideProse) => `<!doctype html><style>
  body{font:16px/1.4 sans-serif;margin:0;color:#111}
  .prose{max-width:600px;margin:0 auto;font:19px/1.7 Georgia,serif;color:rgb(10,20,30)}
  .prose p{margin:0 0 24px}.prose h2{font-size:32px;margin:30px 0 12px}
  @media(max-width:600px){.prose{font-size:22px}}
</style><body><main><article class="post"><div class="prose"><h2>Page</h2>
  <p>${SENTENCE}</p><p>${SENTENCE}</p><p>${SENTENCE}</p><p>${SENTENCE}</p>
  ${markerInsideProse ? '<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->' : ''}</div>
  ${markerInsideProse ? '' : '<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->'}</article></main></body>`;
const BARE_BLOCK = '<section><h2>Questions</h2><p>First answer with a reasonably long sentence so that it wraps in the column and measures.</p><p>Second answer, also long enough to wrap across a couple of lines in the column.</p><p>Third answer text.</p></section>';

test('browser, existing page: a block spliced OUTSIDE the wrapper the page\'s paragraphs sit in is the shared renderer\'s placement problem', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: markerFailure(PROSE_PAGE(false)), draftHtml: BARE_BLOCK, producedBy: 'renderer' });
  assert.equal(d.owner, OWNER.SHARED_RENDERER);
  assert.match(d.cause, /placed outside the wrapper/);
  assert.ok(d.evidence.some((e) => /sits outside div\.prose/.test(e)), JSON.stringify(d.evidence));
});

test('browser, existing page: the same block spliced INSIDE the wrapper inherits the site\'s typography — no deviation, no blame', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: markerFailure(PROSE_PAGE(true)), draftHtml: BARE_BLOCK, producedBy: 'renderer' });
  assert.notEqual(d.owner, OWNER.SHARED_RENDERER);
  assert.deepEqual(d.styleDeviations, []);
});

test('browser, existing page: computed styles are compared — size, line height, family and colour, each reported with the site\'s own value', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: markerFailure(PROSE_PAGE(false)), draftHtml: BARE_BLOCK });
  const props = new Set(d.styleDeviations.filter((x) => x.tag === 'p').map((x) => x.property));
  for (const p of ['font-size', 'line-height', 'font-family', 'colour']) assert.ok(props.has(p), `${p} missing from ${[...props]}`);
  const size = d.styleDeviations.find((x) => x.tag === 'p' && x.property === 'font-size' && x.viewport === 'desktop');
  assert.equal(size.page, 19);
  assert.equal(size.block, 16);
});

test('browser, existing page: line length is compared (the block fills a column the site holds to a narrower measure)', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: markerFailure(PROSE_PAGE(false)), draftHtml: BARE_BLOCK });
  assert.ok(d.styleDeviations.some((x) => x.tag === 'p' && x.property === 'line-length'), JSON.stringify(d.styleDeviations.map((x) => x.property)));
});

test('browser, existing page: BOTH viewports are inspected and each deviation says which', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: markerFailure(PROSE_PAGE(false)), draftHtml: BARE_BLOCK });
  const viewports = new Set(d.styleDeviations.map((x) => x.viewport));
  assert.ok(viewports.has('desktop') && viewports.has('mobile'), [...viewports].join());
  const mobileSize = d.styleDeviations.find((x) => x.property === 'font-size' && x.viewport === 'mobile');
  assert.equal(mobileSize.page, 22, 'the site\'s own mobile size is read from the live page, not assumed');
});

test('browser, existing page: what the generator is told includes the element-level style differences', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const d = await diagnoseDesignFailure({ failure: markerFailure(PROSE_PAGE(false)), draftHtml: BARE_BLOCK });
  assert.match(d.correction, /font-size: the page's own elements are 19px, the block's are 16px \(desktop\)/);
});

test('browser, existing page: a block whose elements carry the site\'s styling through its own classes is not flagged for typography it does not have wrong', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const page = `<!doctype html><style>body{font:16px/1.4 sans-serif;margin:0}.c{max-width:600px;margin:0 auto}.t{font-size:19px;line-height:1.7;margin:0 0 20px}</style>
    <body><main><div class="c"><p class="t">${SENTENCE}</p><p class="t">${SENTENCE}</p><p class="t">${SENTENCE}</p><p class="t">${SENTENCE}</p>
    <!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END --></div></main></body>`;
  const d = await diagnoseDesignFailure({ failure: markerFailure(page), draftHtml: '<section><p class="t">Answer one is long enough to wrap in the column for the measure.</p><p class="t">Answer two.</p><p class="t">Answer three.</p></section>' });
  assert.deepEqual(d.styleDeviations.filter((x) => x.tag === 'p' && x.property === 'font-size'), []);
});
