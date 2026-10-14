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
let enqueueCalls;
let enqueueError;
let queueCreated;
let recordedOutcomes;
let classification;
let classifyError;
let classifyCalls;

const realRead = await import(resolve('../../store/read.js'));
mock.module(resolve('../../store/read.js'), {
  namedExports: { ...realRead, getSiteById: async () => site },
});

// Deliberately NOT filtering by evidence count here — the real
// findPortableRepairs only applies its own trivial >=1-distinct-site floor
// (see agent-memory.js's default), never a generator's real evidence tier.
// The real gate is interceptWithLearnedRepairs' own post-compatibility
// check, which these tests exercise directly against `portable`'s
// `provenSiteCount` fixtures.
mock.module(resolve('../../agent-memory.js'), {
  // `.filter(Boolean)` rather than a bare `portable` so the "lookup failure"
  // test below (portable = null) still exercises a real thrown rejection
  // from this boundary, matching what a real DB error looks like to the
  // caller.
  namedExports: {
    findPortableRepairs: async () => portable.filter(Boolean),
    recordFixOutcome: async (args) => { recordedOutcomes.push(args); return 1; },
  },
});

// The classifier module owns its own fail-open behavior (tested directly in
// page-content-classifier.test.js) — mocked here at the module boundary so
// these tests exercise how interceptWithLearnedRepairs USES the result
// (match / mismatch / null / thrown), not the classifier's own internals.
mock.module(resolve('./page-content-classifier.js'), {
  namedExports: {
    getOrClassifyPageContentType: async (siteId, pageUrl) => {
      classifyCalls.push([siteId, pageUrl]);
      if (classifyError) throw classifyError;
      return classification;
    },
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

// alt-text is an exact-match-or-refuse generator (1 distinct site required).
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

// Fakes store/shipping-queue.js's enqueue() — interceptWithLearnedRepairs no
// longer ships directly (that would open its own production PR, exactly the
// bypass this whole feature was fixed to close), it only records the intent.
const enqueue = async (...args) => {
  enqueueCalls.push(args);
  if (enqueueError) throw enqueueError;
  return { row: { id: 1, ...args[1] }, created: queueCreated };
};

beforeEach(() => {
  site = { ...ELEVENTY_SITE };
  enqueueCalls = [];
  enqueueError = null;
  queueCreated = true;
  recordedOutcomes = [];
  classifyCalls = [];
  classifyError = null;
  // Default: the target page classifies the same as the memory was proven
  // on ('product') — the content-context layer's "match" case, so every
  // pre-existing test below (written before this layer existed) keeps
  // passing without having to know about classification at all.
  classification = { contentType: 'product', confidence: 0.95 };
  portable = [{
    id: 42,
    generatorId: 'alt-text',
    siteFingerprint: ['render:eleventy', 'target-ext:.njk', 'md:false', 'page-adapter:none', 'content-type:product'],
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
    assert.equal(await interceptWithLearnedRepairs(7, input, { enqueue }), input);
    assert.equal(enqueueCalls.length, 0);
  });

  test('learned_repair on but auto_remediation off -> refuses', async () => {
    // Two separate consents; acting on only one would be acting without the
    // client having agreed to unattended changes at all.
    site = { ...ELEVENTY_SITE, auto_remediation_enabled: false };
    const input = grounded();
    assert.equal(await interceptWithLearnedRepairs(7, input, { enqueue }), input);
  });

  test('auto_remediation on but learned_repair off -> refuses', async () => {
    site = { ...ELEVENTY_SITE, learned_repair_enabled: false };
    const input = grounded();
    assert.equal(await interceptWithLearnedRepairs(7, input, { enqueue }), input);
  });
});

describe('interceptWithLearnedRepairs — the happy path', () => {
  test('repairs the item, removes it from items, and binds the memory it used', async () => {
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 0, 'a repaired item must never become an Action Center row');
    assert.equal(enqueueCalls.length, 1);
    const [, opts] = enqueueCalls[0];
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
    const out = await interceptWithLearnedRepairs(7, input, { enqueue });
    assert.equal(out.detectedKeys, input.detectedKeys);
  });

  test('leaves unrepaired items in place alongside a repaired one', async () => {
    const other = { ...ALT_TEXT_ITEM, id: 'other', generatorId: 'landing-page' };
    const out = await interceptWithLearnedRepairs(7, grounded([ALT_TEXT_ITEM, other]), { enqueue });
    assert.deepEqual(out.items.map((i) => i.id), ['other']);
  });
});

describe('interceptWithLearnedRepairs — refusals all fall through to the Action Center', () => {
  test('an ineligible generator is never touched', async () => {
    const item = { ...ALT_TEXT_ITEM, generatorId: 'landing-page' };
    const out = await interceptWithLearnedRepairs(7, grounded([item]), { enqueue });
    assert.equal(out.items.length, 1);
    assert.equal(enqueueCalls.length, 0);
  });

  test('no portable evidence -> untouched', async () => {
    portable = [];
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 1);
    assert.equal(enqueueCalls.length, 0);
  });

  test('evidence from too few distinct sites -> untouched', async () => {
    portable[0].provenSiteCount = 0; // alt-text needs 1
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 1);
    assert.equal(enqueueCalls.length, 0);
  });

  test('TECHNICAL mismatch -> untouched even though the signature matched', async () => {
    portable[0].siteFingerprint = ['render:nextjs', 'target-ext:.tsx', 'content-type:product'];
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 1);
    assert.equal(enqueueCalls.length, 0);
  });

  test('a site with no renderCapabilities -> untouched (required token absent)', async () => {
    site = { ...ELEVENTY_SITE, url_file_map: { pages: {} } };
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 1);
    assert.equal(enqueueCalls.length, 0);
  });

  test('a lookup failure -> untouched, not a thrown job', async () => {
    const { interceptWithLearnedRepairs: fresh } = await import('./learned-repair.js');
    portable = null; // makes the mocked findPortableRepairs throw
    const out = await fresh(7, grounded(), { enqueue });
    assert.equal(out.items.length, 1);
  });
});

describe('interceptWithLearnedRepairs — CONTENT-CONTEXT layer', () => {
  test('content-context match -> reuses, exactly like the pre-existing happy path', async () => {
    // classification defaults to 'product', same as portable[0]'s memory —
    // this is the default beforeEach state, asserted explicitly here so the
    // match case has its own named test rather than being implicit.
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 0);
    assert.equal(enqueueCalls.length, 1);
  });

  test('content-context mismatch (wrong page type) -> refuses even though technical/structural both match', async () => {
    classification = { contentType: 'blog', confidence: 0.95 }; // memory was proven on a 'product' page
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 1, 'must fall through to the Action Center, not reuse a repair proven on a different kind of page');
    assert.equal(enqueueCalls.length, 0);
  });

  test('missing/uncertain content-context (classifier returns null) -> refuses, never assumed compatible', async () => {
    classification = null; // e.g. below MIN_CONFIDENCE, or genuinely unclassifiable
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 1);
    assert.equal(enqueueCalls.length, 0);
  });

  test('LLM/classifier failure -> fails open to the Action Center, never throws or crashes the run', async () => {
    classifyError = new Error('classifier upstream 500');
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 1);
    assert.equal(enqueueCalls.length, 0);
  });

  test('only classifies pages that already have a real evidence-backed candidate — never spent on a page with none', async () => {
    portable = [];
    await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(classifyCalls.length, 0, 'classification is the expensive step and must not run before findPortableRepairs has a real candidate');
  });
});

// requiredEvidenceFor('faq') is 4 (LLM-prose tier) — used below specifically
// because it needs a real per-candidate threshold higher than the trivial
// >=1-distinct-site floor findPortableRepairs itself applies, so these tests
// can prove the EVIDENCE gate runs as this module's own, separate, later
// step — not folded into (or substitutable for) the compatibility gate.
const FAQ_ITEM = {
  id: 'content:faq-missing:https://client.example/a',
  generatorId: 'faq',
  source: 'opportunity',
  tag: 'Add FAQ section',
  params: { page: 'https://client.example/a' },
};
const FAQ_COMPATIBLE_FP = ['render:eleventy', 'target-ext:.njk', 'page-adapter:none', 'content-type:product'];
const FAQ_INCOMPATIBLE_FP = ['render:nextjs', 'target-ext:.tsx', 'page-adapter:none', 'content-type:product'];

describe('interceptWithLearnedRepairs — decision-chain ordering (technical/structural/content-context, THEN evidence)', () => {
  test('evidence count alone can never authorize reuse: an incompatible candidate with abundant evidence is refused', async () => {
    portable = [{
      id: 1, generatorId: 'faq', siteFingerprint: FAQ_INCOMPATIBLE_FP,
      repairRecipe: { kind: 'generator-chain', generatorId: 'faq', version: 1 },
      confidence: 0.95, provenSiteCount: 100, // evidence far above the required 4
    }];
    const out = await interceptWithLearnedRepairs(7, grounded([FAQ_ITEM]), { enqueue });
    assert.equal(out.items.length, 1, 'a technical mismatch must refuse no matter how much reuse evidence backs it');
    assert.equal(enqueueCalls.length, 0);
  });

  test('a compatible-but-under-evidenced candidate is skipped in favor of a later, sufficiently-proven compatible one — never picked purely by rank/confidence', async () => {
    portable = [
      // Ranked first by confidence, and would win on evidence alone, but is
      // technically incompatible — must never be chosen.
      {
        id: 1, generatorId: 'faq', siteFingerprint: FAQ_INCOMPATIBLE_FP,
        repairRecipe: { kind: 'generator-chain', generatorId: 'faq', version: 1 },
        confidence: 0.95, provenSiteCount: 100,
      },
      // Ranked second, lower confidence, but compatible and exactly at the
      // required evidence bar (4) — this is the one that must be used.
      {
        id: 2, generatorId: 'faq', siteFingerprint: FAQ_COMPATIBLE_FP,
        repairRecipe: { kind: 'generator-chain', generatorId: 'faq', version: 1 },
        confidence: 0.5, provenSiteCount: 4,
      },
    ];
    const out = await interceptWithLearnedRepairs(7, grounded([FAQ_ITEM]), { enqueue });
    assert.equal(out.items.length, 0);
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0][1].memoryRefId, 2, 'the compatible, sufficiently-proven candidate must win, not the higher-ranked incompatible one');
  });

  test('EVIDENCE gate applies even to a technically/structurally/content-context compatible candidate, independent of findPortableRepairs\' own floor', async () => {
    portable = [{
      id: 3, generatorId: 'faq', siteFingerprint: FAQ_COMPATIBLE_FP,
      repairRecipe: { kind: 'generator-chain', generatorId: 'faq', version: 1 },
      confidence: 0.9, provenSiteCount: 2, // compatible, but faq requires 4 distinct sites
    }];
    const out = await interceptWithLearnedRepairs(7, grounded([FAQ_ITEM]), { enqueue });
    assert.equal(out.items.length, 1, 'compatibility alone is not enough either — the generator-specific evidence bar still applies');
    assert.equal(enqueueCalls.length, 0);
  });

  test('a compatible candidate that clears its generator-specific evidence bar is reused', async () => {
    portable = [{
      id: 4, generatorId: 'faq', siteFingerprint: FAQ_COMPATIBLE_FP,
      repairRecipe: { kind: 'generator-chain', generatorId: 'faq', version: 1 },
      confidence: 0.9, provenSiteCount: 4,
    }];
    const out = await interceptWithLearnedRepairs(7, grounded([FAQ_ITEM]), { enqueue });
    assert.equal(out.items.length, 0);
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0][1].memoryRefId, 4);
  });
});

// Recording a FAILED reuse (recordFixOutcome outcome:'failure') used to
// happen right here, at intercept time, because that used to be the moment a
// real ship attempt happened. It no longer is: interceptWithLearnedRepairs
// now only enqueues an intent (a DB insert, which basically cannot fail in a
// way that says anything about the borrowed repair's portability), so that
// bookkeeping moved to auto-remediation.js's queue-draining step — the point
// a real generate/approve/push attempt (and therefore a real success/failure
// verdict about the repair) now actually happens. See
// auto-remediation-learned-repair-drain.test.js for that half of the
// contract.
describe('interceptWithLearnedRepairs — enqueue failure', () => {
  test('an enqueue failure (e.g. a DB error) leaves the item for the Action Center, and throws nothing out of the run', async () => {
    enqueueError = new Error('connection reset');
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });

    assert.equal(out.items.length, 1, 'a queueing failure must still reach the Action Center');
    assert.equal(recordedOutcomes.length, 0, 'no ship attempt happened, so nothing about the memory\'s portability can be concluded here');
  });

  test('a repair already queued by an earlier pass (created:false) still counts as handled', async () => {
    queueCreated = false;
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(out.items.length, 0, 'already-queued work must not also flow to the ordinary Action Center path');
  });
});

describe('interceptWithLearnedRepairs — dry run', () => {
  test('matches but never ships, and never removes the item', async () => {
    process.env.LEARNED_REPAIR_DRY_RUN = '1';
    const out = await interceptWithLearnedRepairs(7, grounded(), { enqueue });
    assert.equal(enqueueCalls.length, 0);
    assert.equal(out.items.length, 1, 'nothing was actually fixed, so nothing may be filtered out');
  });
});
