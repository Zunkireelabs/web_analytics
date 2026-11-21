// End-to-end evidence that the repair mechanism works on DIFFERENT client designs
// and on BOTH rendering paths. Nothing here is faked except the model: the real
// gates render real pages in a real browser, the real diagnosis reads the real
// DOM and CSS, and the real loop routes the result. The "generator" is a stub that
// behaves like a model told exactly what is wrong.
//
//   new-page path     checkNewPageRender  (what direct-answer, landing-page,
//                     blog-outline, translation, policy pages go through)
//   existing-page     checkResponsivePreview (what faq, qa-content, expand-content,
//                     refresh-content, blog-image... splice into a live page)
//
// Skipped, not failed, when no browser can launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../../design-agent/live-analysis/capture.js';
import { checkNewPageRender } from './newpage-render-gate.js';
import { checkResponsivePreview } from './responsive-preview-gate.js';
import { investigateAndRepairDesign, OWNER } from './design-repair.js';

const SENTENCE = 'A representative paragraph of body copy that is long enough to wrap across several lines in the column. ';
const P = (n = 2) => `<p>${SENTENCE.repeat(n)}</p>`;
const dataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
async function hasBrowser() { try { const b = await launchBrowser(); await b.close(); return true; } catch { return false; } }

// Three client sites built three different ways. The same repair logic must be
// right on all of them, and never borrow one site's design for another.
const SITES = {
  'client A — wrapper-scoped typography': `<!doctype html><style>
    body{font:16px/1.4 sans-serif;margin:0}.wrap{max-width:720px;margin:0 auto}
    .wrap .body p{font-size:20px;line-height:1.6;margin:0 0 26px}.wrap .body h2{font-size:42px;margin:48px 0 18px}
  </style><body><main><article class="wrap"><header><h1>T</h1>${P(1)}</header><div class="body"><h2>E</h2>${P()}${P()}${P()}<h2>F</h2>${P()}${P()}</div></article></main></body>`,
  'client B — typography plugin class': `<!doctype html><style>
    body{font:16px/1.4 sans-serif;margin:0}.prose{max-width:660px;margin:0 auto;font-size:18px;line-height:1.7}
    .prose p{margin:0 0 22px}.prose h2{font-size:34px;margin:40px 0 16px}
  </style><body><main><div class="prose"><h2>E</h2>${P()}${P()}${P()}<h2>F</h2>${P()}${P()}</div></main></body>`,
  'client C — classes on every element': `<!doctype html><style>
    body{font:16px/1.4 sans-serif;margin:0}.col{max-width:680px;margin:0 auto}
    .t-body{font-size:19px;line-height:1.7;margin:0 0 22px}.t-h2{font-size:34px;margin:36px 0 14px}
  </style><body><main><div class="col"><h2 class="t-h2">E</h2><p class="t-body">${SENTENCE.repeat(2)}</p><p class="t-body">${SENTENCE.repeat(2)}</p><p class="t-body">${SENTENCE.repeat(2)}</p><h2 class="t-h2">F</h2><p class="t-body">${SENTENCE.repeat(2)}</p></div></main></body>`,
};

const CLEAN_BODY = `<h2>A section</h2>${P()}${P()}<h2>Another</h2>${P()}${P()}`;
const HAZARD_BODY = `<h2 style="font-size:72px">A section</h2>${P()}${P()}<h2>Another</h2>${P()}${P()}`;

// A model that was told what is wrong and fixes exactly that.
const obedientGenerator = (calls) => async (correction) => {
  calls.push(correction);
  return /inline/i.test(correction) ? CLEAN_BODY : null;
};

const newPageCheck = (siteHtml) => async (content) => {
  const r = await checkNewPageRender({ referenceUrl: dataUrl(siteHtml), newPageHtml: content });
  return r.ok && !r.broken ? { ok: true } : { ok: false, reason: 'render-deviation', deviations: r.deviations || [], referenceUrl: dataUrl(siteHtml), draftHtml: content };
};

// ---- new-page path, every client design ------------------------------------

// Sites A and B style bare elements under a wrapper, so a plain body is a legitimate pass there.
for (const [name, html] of Object.entries(SITES).filter(([n]) => !n.startsWith('client C'))) {
  test(`new page — ${name}: a correct body passes untouched (no false failure, no needless rewrite)`, async (t) => {
    if (!(await hasBrowser())) return t.skip('no browser available');
    const gen = [];
    const out = await investigateAndRepairDesign({
      content: CLEAN_BODY, check: newPageCheck(html), draftHtmlOf: (c) => c, regenerate: obedientGenerator(gen),
    });
    assert.equal(out.status, 'passed', JSON.stringify(out.result.deviations));
    assert.equal(gen.length, 0);
  });

  test(`new page — ${name}: a draft with inline sizing is diagnosed as the generator's, repaired, re-rendered and passes`, async (t) => {
    if (!(await hasBrowser())) return t.skip('no browser available');
    const gen = [];
    const out = await investigateAndRepairDesign({
      content: HAZARD_BODY, check: newPageCheck(html), draftHtmlOf: (c) => c, producedBy: 'generator', regenerate: obedientGenerator(gen),
    });
    assert.equal(out.status, 'passed-after-repair', JSON.stringify(out.attempts));
    assert.equal(out.ok, true);
    assert.equal(out.content, CLEAN_BODY);
    assert.equal(out.attempts[0].owner, OWNER.GENERATOR);
    assert.match(gen[0], /heading-scale|inline/i, 'the generator is told what was measured and why');
  });
}

test('new page — client C: markup that lost the site\'s classes goes to the SHARED RENDERER, is never "fixed" by rewriting, and never ships', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const gen = []; const handoffs = [];
  const out = await investigateAndRepairDesign({
    content: CLEAN_BODY, check: newPageCheck(SITES['client C — classes on every element']), draftHtmlOf: (c) => c, producedBy: 'renderer',
    regenerate: obedientGenerator(gen),
    handoff: { sharedCode: async (d) => { handoffs.push(d.owner); return { requested: true, detail: 'opened' }; } },
  });
  assert.equal(out.status, 'deferred');
  assert.equal(out.ok, false);
  assert.equal(out.pendingReason, 'shared-code-repair-pending');
  assert.equal(gen.length, 0);
  assert.deepEqual(handoffs, [OWNER.SHARED_RENDERER]);
  assert.ok(out.diagnosis.evidence.some((e) => /t-body/.test(e)), 'the evidence names the lost classes');
});

test('the three clients never share a design: each is judged against its OWN page', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  // The same body is a pass on A and B and a renderer problem on C — proof the reference is per client.
  const status = {};
  for (const [name, html] of Object.entries(SITES)) {
    status[name[7]] = (await investigateAndRepairDesign({
      content: CLEAN_BODY, check: newPageCheck(html), draftHtmlOf: (c) => c, regenerate: async () => null, handoff: { sharedCode: async () => ({ requested: true, detail: 'x' }) },
    })).status;
  }
  assert.equal(status.A, 'passed');
  assert.equal(status.B, 'passed');
  assert.equal(status.C, 'deferred');
});

test('an unrepairable draft stops at the budget with the diagnosis and is NEVER reported as passing', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  let regens = 0;
  const out = await investigateAndRepairDesign({
    content: HAZARD_BODY, check: newPageCheck(SITES['client A — wrapper-scoped typography']), draftHtmlOf: (c) => c, producedBy: 'generator',
    regenerate: async () => { regens++; return HAZARD_BODY; }, // a model that cannot fix it
  });
  assert.equal(out.status, 'exhausted');
  assert.equal(out.ok, false);
  assert.equal(out.result.ok, false);
  assert.equal(regens, 2);
  assert.equal(out.attempts.length, 3);
  assert.ok(out.diagnosis.evidence.length > 0);
});

// ---- existing-page path (marker splice), different content blocks ----------

const PAGE_WITH_MARKER = (blockCss = '') => `<!doctype html><style>
  body{font:16px/1.4 sans-serif;margin:0}.c{max-width:700px;margin:0 auto;padding:0 16px}${blockCss}
</style><body><main class="c"><h1>Page</h1>${P()}<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->${P()}</main></body>`;

const WIDE_TABLE_BLOCK = `<section><h2>FAQ</h2><table style="width:1200px"><tr><td>Plan</td><td>${'x'.repeat(40)}</td></tr></table></section>`;
const SAFE_BLOCK = `<section><h2>FAQ</h2><p>${SENTENCE}</p></section>`;

const markerCheck = (pageHtml) => async (content) => {
  const r = await checkResponsivePreview({ pageUrl: dataUrl(pageHtml), marker: 'FAQ', newContentHtml: content });
  if (r.skip) return { ok: false, reason: 'no-insertion-marker' };
  return r.ok && !r.broken ? { ok: true } : { ok: false, reason: 'responsive-regression', regressions: r.regressions || [], draftHtml: content };
};

test('existing page — a block that overflows on mobile is diagnosed from its own markup, repaired, re-rendered and passes', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const calls = [];
  const out = await investigateAndRepairDesign({
    content: WIDE_TABLE_BLOCK, check: markerCheck(PAGE_WITH_MARKER()), draftHtmlOf: (c) => c, producedBy: 'generator',
    regenerate: async (correction) => { calls.push(correction); return /table|inline|overflow/i.test(correction) ? SAFE_BLOCK : null; },
  });
  assert.equal(out.status, 'passed-after-repair', JSON.stringify({ a: out.attempts, r: out.result }));
  assert.equal(out.content, SAFE_BLOCK);
  assert.equal(out.attempts[0].owner, OWNER.GENERATOR);
  assert.match(calls[0], /overflow|table|clipped|inline/i);
});

test('existing page — a safe block passes first time on a different client page too', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  for (const css of ['', '.c{max-width:540px}', 'p{font-size:18px}']) {
    const out = await investigateAndRepairDesign({ content: SAFE_BLOCK, check: markerCheck(PAGE_WITH_MARKER(css)), draftHtmlOf: (c) => c, regenerate: async () => null });
    assert.equal(out.status, 'passed', css);
  }
});

test('a failure that is not a design verdict (no marker on the page) is passed back, not "repaired"', async (t) => {
  if (!(await hasBrowser())) return t.skip('no browser available');
  const out = await investigateAndRepairDesign({
    content: SAFE_BLOCK, check: markerCheck('<!doctype html><body><p>no marker here</p></body>'), draftHtmlOf: (c) => c, regenerate: async () => 'x',
  });
  assert.equal(out.status, 'not-repairable');
  assert.equal(out.ok, false);
});
