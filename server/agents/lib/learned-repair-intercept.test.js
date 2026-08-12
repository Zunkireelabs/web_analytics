import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// interceptWithLearnedRepairs is the only thing in this feature that can act
// on a real customer repository, and it acts on evidence borrowed from a
// DIFFERENT customer. Its contract is therefore mostly about what it must
// NOT do: every refusal path has to leave the item flowing to the Action
// Center exactly as it does today.

let site;
let portable;
let shipCalls;
let shipError;
let recordedOutcomes;

mock.module(resolve('../../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});

mock.module(resolve('../../agent-memory.js'), {
  namedExports: {
    findPortableRepairs: async ({ minDistinctSites }) =>
      portable.filter((p) => p.provenSiteCount >= minDistinctSites),
    recordFixOutcome: async (args) => { recordedOutcomes.push(args); return 1; },
  },
});

const { interceptWithLearnedRepairs } = await import('./learned-repair.js');

const ELEVENTY_SITE = {
  id: 7,
  learned_repair_enabled: true,
  auto_remediation_enabled: true,
  url_file_map: {
    renderCapabilities: { generator: 'eleventy', extensions: { '.njk': { markdown: false } } },
    // url-file-map.js keys `pages` by PATHNAME, not by full URL (getPageEntry
    // normalizes through new URL(...).pathname) — a full-URL key here would
    // silently resolve to null and make every repair look like a fingerprint
    // refusal.
    pages: { '/a': { file: 'src/a.njk' } },
  },
};

// alt-text is a tier-2 generator (2 distinct sites required).
const ALT_TEXT_ITEM = {
  id: 'accessibility:missing-alt:https://client.example/a',
  generatorId: 'alt-text',
  source: 'opportunity',
  tag: 'Add image alt text',
  params: { page: 'https://client.example/a' },
};

function grounded(items = [ALT_TEXT_ITEM]) {
  return { items, detectedKeys: new Set(['alt-text::https://client.example/a']), lastAnalyzedAt: null };
}

const ship = async (...args) => {
  shipCalls.push(args);
  if (shipError) throw shipError;
  return { branch_name: 'action-center/alt-text-1' };
};

beforeEach(() => {
  site = { ...ELEVENTY_SITE };
  shipCalls = [];
  shipError = null;
  recordedOutcomes = [];
  portable = [{
    id: 42,
    generatorId: 'alt-text',
    siteFingerprint: ['render:eleventy', 'target-ext:.njk', 'md:false'],
    repairRecipe: { kind: 'generator-chain', generatorId: 'alt-text', version: 1 },
    confidence: 0.9,
    provenSiteCount: 2,
  }];
  delete process.env.LEARNED_REPAIR_DRY_RUN;
});

describe('interceptWithLearnedRepairs — consent gates', () => {
  test('both site flags off -> returns the input by identity, nothing runs', async () => {
    site = { ...ELEVENTY_SITE, learned_repair_enabled: false, auto_remediation_enabled: false };
    const input = grounded();
    assert.equal(await interceptWithLearnedRepairs(7, input, { ship }), input);
    assert.equal(shipCalls.length, 0);
  });

  test('learned_repair on but auto_remediation off -> refuses', async () => {
    // Two separate consents; acting on only one would be acting without the
    // client having agreed to unattended changes at all.
    site = { ...ELEVENTY_SITE, auto_remediation_enabled: false };
    const input = grounded();
    assert.equal(await interceptWithLearnedRepairs(7, input, { ship }), input);
  });

  test('auto_remediation on but learned_repair off -> refuses', async () => {
    site = { ...ELEVENTY_SITE, learned_repair_enabled: false };
    const input = grounded();
    assert.equal(await interceptWithLearnedRepairs(7, input, { ship }), input);
  });
});

describe('interceptWithLearnedRepairs — the happy path', () => {
  test('repairs the item, removes it from items, and binds the memory it used', async () => {
    const out = await interceptWithLearnedRepairs(7, grounded(), { ship });
    assert.equal(out.items.length, 0, 'a repaired item must never become an Action Center row');
    assert.equal(shipCalls.length, 1);
    const [, opts] = shipCalls[0];
    assert.equal(opts.memoryRefId, 42, 'the outcome must be credited to the memory that was actually reused');
    assert.equal(opts.generatorId, 'alt-text');
    assert.equal(opts.source, 'learned-repair');
    assert.equal(opts.findingId, ALT_TEXT_ITEM.id);
  });

  test('detectedKeys passes through untouched', async () => {
    // The issue is still genuinely live until a human merges the PR, so the
    // key must stay detected or closeStaleRecommendations would treat the
    // problem as resolved before anything shipped.
    const input = grounded();
    const out = await interceptWithLearnedRepairs(7, input, { ship });
    assert.equal(out.detectedKeys, input.detectedKeys);
  });

  test('leaves unrepaired items in place alongside a repaired one', async () => {
    const other = { ...ALT_TEXT_ITEM, id: 'other', generatorId: 'landing-page' };
    const out = await interceptWithLearnedRepairs(7, grounded([ALT_TEXT_ITEM, other]), { ship });
    assert.deepEqual(out.items.map((i) => i.id), ['other']);
  });
});

describe('interceptWithLearnedRepairs — refusals all fall through to the Action Center', () => {
  test('an ineligible generator is never touched', async () => {
    const item = { ...ALT_TEXT_ITEM, generatorId: 'landing-page' };
    const out = await interceptWithLearnedRepairs(7, grounded([item]), { ship });
    assert.equal(out.items.length, 1);
    assert.equal(shipCalls.length, 0);
  });

  test('no portable evidence -> untouched', async () => {
    portable = [];
    const out = await interceptWithLearnedRepairs(7, grounded(), { ship });
    assert.equal(out.items.length, 1);
    assert.equal(shipCalls.length, 0);
  });

  test('evidence from too few distinct sites -> untouched', async () => {
    portable[0].provenSiteCount = 1; // alt-text needs 2
    const out = await interceptWithLearnedRepairs(7, grounded(), { ship });
    assert.equal(out.items.length, 1);
    assert.equal(shipCalls.length, 0);
  });

  test('a fingerprint mismatch -> untouched even though the signature matched', async () => {
    portable[0].siteFingerprint = ['render:nextjs', 'target-ext:.tsx'];
    const out = await interceptWithLearnedRepairs(7, grounded(), { ship });
    assert.equal(out.items.length, 1);
    assert.equal(shipCalls.length, 0);
  });

  test('a site with no renderCapabilities -> untouched (required token absent)', async () => {
    site = { ...ELEVENTY_SITE, url_file_map: { pages: {} } };
    const out = await interceptWithLearnedRepairs(7, grounded(), { ship });
    assert.equal(out.items.length, 1);
    assert.equal(shipCalls.length, 0);
  });

  test('a lookup failure -> untouched, not a thrown job', async () => {
    const { interceptWithLearnedRepairs: fresh } = await import('./learned-repair.js');
    portable = null; // makes the mocked findPortableRepairs throw
    const out = await fresh(7, grounded(), { ship });
    assert.equal(out.items.length, 1);
  });
});

describe('interceptWithLearnedRepairs — execution failure', () => {
  test('a failed repair keeps the item AND records a failed reuse immediately', async () => {
    shipError = new Error('anchor no longer matches');
    const out = await interceptWithLearnedRepairs(7, grounded(), { ship });

    assert.equal(out.items.length, 1, 'a failed repair must still reach the Action Center');
    assert.equal(recordedOutcomes.length, 1);
    assert.equal(recordedOutcomes[0].memoryRefId, 42);
    assert.equal(recordedOutcomes[0].outcome, 'failure');
    assert.equal(recordedOutcomes[0].agentId, 'learned-repair');
    // Recorded now rather than waiting for the 48h live re-check, which will
    // never run: no draft reached 'implemented', so nothing would have
    // scheduled one.
  });
});

describe('interceptWithLearnedRepairs — dry run', () => {
  test('matches but never ships, and never removes the item', async () => {
    process.env.LEARNED_REPAIR_DRY_RUN = '1';
    const out = await interceptWithLearnedRepairs(7, grounded(), { ship });
    assert.equal(shipCalls.length, 0);
    assert.equal(out.items.length, 1, 'nothing was actually fixed, so nothing may be filtered out');
  });
});
