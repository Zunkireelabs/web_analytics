import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let calls; let responses;

// callLLMForJson stand-in: records the prompt and applies the caller's own
// `validate` to each queued response, as the real one does when retrying.
mock.module(resolve('../../llm.js'), {
  namedExports: {
    callLLMForJson: async (system, user, opts) => {
      calls.push({ system, user, opts });
      const r = responses.shift();
      if (opts.validate && !opts.validate(r)) throw new Error('invalid after retry');
      return r;
    },
  },
});

const { composeGeneratedExpandLayout } = await import('./compose-expand-layout.js');
const { expandStructurePrior, SPEC_VERSION } = await import('../lib/expand-structure-spec.js');
const { DESIGN_PROFILE_VERSION } = await import('../lib/design-profile.js');

const PROFILE = {
  version: DESIGN_PROFILE_VERSION, styling: 'tailwind', pages: [],
  typography: { heading: { section: 'text-2xl font-semibold', item: 'text-lg' }, body: 'text-gray-600' },
  color: { text: 'text-gray-900' }, spacing: { section: 'py-12', itemGap: 'py-5' }, layout: { container: 'max-w-3xl mx-auto' },
  components: { card: { wrapper: 'rounded-lg border p-6' } },
};
const spec = { version: SPEC_VERSION, sectionCount: { min: 2, max: 3 }, sectionOrder: ['content', 'cta'], shapes: { content: 'card' }, headingLevels: { content: 'section' }, tableUsage: { allowed: false }, placement: { anchor: 'after-last-content-section', before: ['cta'] } };
const prior = () => expandStructurePrior(spec, PROFILE);

const cardH2 = { wrapper: '<div class="max-w-3xl">\n{{ROWS}}\n</div>', row: '<section class="rounded-lg border p-6"><h2 class="text-2xl font-semibold">{{HEADING}}</h2><div class="text-gray-600">{{BODY}}</div></section>' };
const plainH3 = { wrapper: '<div class="max-w-3xl">\n{{ROWS}}\n</div>', row: '<section class="py-5"><h3 class="text-lg">{{HEADING}}</h3><div class="text-gray-600">{{BODY}}</div></section>' };

beforeEach(() => { calls = []; responses = []; });

describe('composeGeneratedExpandLayout — structure prior', () => {
  test('without a prior the prompt is exactly what it was, and no structure text appears', async () => {
    responses.push(cardH2);
    await composeGeneratedExpandLayout(PROFILE, { siteId: 1 });
    assert.doesNotMatch(calls[0].user, /Structure to follow/);
  });

  test('with a prior the plan is added to the prompt, in plain words', async () => {
    responses.push(cardH2);
    await composeGeneratedExpandLayout(PROFILE, { siteId: 1, structurePrior: prior() });
    assert.match(calls[0].user, /Structure to follow/);
    assert.match(calls[0].user, /Write 2 to 3 section/);
  });

  test('a layout that matches the structure AND uses only the tenant\'s own classes is accepted', async () => {
    responses.push(cardH2);
    assert.deepEqual(await composeGeneratedExpandLayout(PROFILE, { siteId: 1, structurePrior: prior() }), cardH2);
  });

  test('a layout that breaks the prior (wrong heading level, no card) is rejected, not shipped', async () => {
    responses.push(plainH3);
    assert.equal(await composeGeneratedExpandLayout(PROFILE, { siteId: 1, structurePrior: prior() }), null);
  });

  test('the SAME layout is fine without a prior — the prior only adds structure checks', async () => {
    responses.push(plainH3);
    assert.deepEqual(await composeGeneratedExpandLayout(PROFILE, { siteId: 1 }), plainH3);
  });

  test('the class allowlist is untouched: an invented class still fails even when the structure matches', async () => {
    responses.push({ ...cardH2, row: cardH2.row.replace('rounded-lg', 'bg-indigo-900') });
    assert.equal(await composeGeneratedExpandLayout(PROFILE, { siteId: 1, structurePrior: prior() }), null);
  });
});
