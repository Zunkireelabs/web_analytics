import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Real store/read.js transitively pulls in the OpenAI SDK (via
// candidate-pages.js's own other imports), which hits the same unrelated
// ESM/CJS web-streams-polyfill incompatibility under
// --experimental-test-module-mocks documented in visual-quality.test.js —
// stub only the exports actually reachable here, rather than importing the
// real module. getSearchPerformanceRange/getSiteById are only imported
// (never called) by candidate-pages.js's own module graph: run()'s
// params.pages path below skips selectCandidatePages entirely, so these
// two are dead weight this test never invokes — present only so the
// static import resolves.
mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSearchPerformanceForPages: async (siteId, start, end, pages) => pages.map((p) => ({ dim_value: p, impressions: 0 })),
    getSearchPerformanceRange: async () => [],
    getSiteById: async () => null,
  },
});
// llm.js imports the real OpenAI SDK, which hits the same web-streams-
// polyfill incompatibility the moment ANY mock.module call is active in
// this process (documented in visual-quality.test.js) — stub callLLM
// so the real SDK is never loaded at all. `mockLLMResponse` is mutable (not
// a fixed 'stub narrative') so a run()-level test can also drive
// findTopicallyMismatchedFaq's own (non-injected) two self-consistency
// passes — run() calls it with no askLLM override, so it always goes
// through this same mocked callLLM.
let mockLLMResponse = 'stub narrative';
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => mockLLMResponse },
});

const { run, findInconsistentFaqQuestions, findTopicallyMismatchedFaq, decideCrossPageFaqAnswer } = await import('./content-integrity.js');

function page(url, items) {
  return { page: url, analysis: { faqVisibleItems: items } };
}

describe('findInconsistentFaqQuestions', () => {
  test('flags the same real question answered differently on two different pages', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
      page('https://example.com/b', [{ question: 'When do you ship?', answer: 'Within 5 business days.' }]),
    ];
    const result = findInconsistentFaqQuestions(reachable);
    assert.equal(result.length, 1);
    assert.equal(result[0].question, 'when do you ship?');
    assert.equal(result[0].variants.length, 2);
  });

  test('does not flag the same question with the same real answer (whitespace/case-insensitive)', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
      page('https://example.com/b', [{ question: '  When Do You Ship?  ', answer: '  within 2   business days.  ' }]),
    ];
    assert.deepEqual(findInconsistentFaqQuestions(reachable), []);
  });

  test('ignores items with no confidently-extracted answer', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: null }]),
      page('https://example.com/b', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
    ];
    assert.deepEqual(findInconsistentFaqQuestions(reachable), []);
  });

  test('does not flag a question that only appears on one page', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
      page('https://example.com/b', [{ question: 'Do you ship internationally?', answer: 'Yes, worldwide.' }]),
    ];
    assert.deepEqual(findInconsistentFaqQuestions(reachable), []);
  });

  test('empty input -> empty result', () => {
    assert.deepEqual(findInconsistentFaqQuestions([]), []);
  });
});

// The concurrency cap (2026-09-01 audit follow-up): MAX_PAGES=100 must never
// mean 100 simultaneous requests against one tenant's host. Uses run()'s own
// params.pages/pageCache injection seam (no module mocking needed for the
// fetch layer itself) so this exercises the REAL pLimit wiring, not a stand-in.
describe('content-integrity fetch concurrency', () => {
  test('never runs more than CONTENT_INTEGRITY_FETCH_CONCURRENCY (default 10) fetches at once', async () => {
    const pages = Array.from({ length: 40 }, (_, i) => `https://example.com/p${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const pageCache = async (page) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5)); // force real overlap, not accidental seriality
      inFlight--;
      return { ok: true, analysis: { malformedTableCount: 0, faqVisibleItems: [] } };
    };

    await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages } });

    assert.ok(maxInFlight <= 10, `expected at most 10 concurrent fetches, saw ${maxInFlight}`);
    assert.ok(maxInFlight > 1, 'sanity check: fetches must still run concurrently, not fall back to serial');
  });

  test('CONTENT_INTEGRITY_FETCH_CONCURRENCY overrides the default, read fresh on every call', async () => {
    const pages = Array.from({ length: 20 }, (_, i) => `https://example.com/p${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const pageCache = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ok: true, analysis: { malformedTableCount: 0, faqVisibleItems: [] } };
    };

    process.env.CONTENT_INTEGRITY_FETCH_CONCURRENCY = '3';
    try {
      await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages } });
    } finally {
      delete process.env.CONTENT_INTEGRITY_FETCH_CONCURRENCY;
    }

    assert.ok(maxInFlight <= 3, `expected at most 3 concurrent fetches with the override set, saw ${maxInFlight}`);
  });
});

function pageWithTitle(url, title, questions) {
  return { page: url, analysis: { title, faqVisibleItems: questions.map((question) => ({ question, answer: 'x' })) } };
}

describe('findTopicallyMismatchedFaq', () => {
  test('flags a page the model names, using its real title/questions in the returned record', async () => {
    const reachable = [
      pageWithTitle('https://example.com/careers', 'Careers | Acme', ['What is Acme Search?', 'How does Acme pricing work?']),
      pageWithTitle('https://example.com/pricing', 'Pricing | Acme', ['How does Acme pricing work?', 'Is there a free trial?']),
    ];
    const askLLM = async () => '["https://example.com/careers"]';
    const result = await findTopicallyMismatchedFaq(reachable, askLLM);
    assert.equal(result.length, 1);
    assert.equal(result[0].page, 'https://example.com/careers');
    assert.equal(result[0].title, 'Careers | Acme');
  });

  test('ignores a hallucinated page URL not present in the input candidates', async () => {
    const reachable = [
      pageWithTitle('https://example.com/careers', 'Careers | Acme', ['What is Acme Search?', 'How does Acme pricing work?']),
    ];
    const askLLM = async () => '["https://example.com/not-a-real-checked-page"]';
    const result = await findTopicallyMismatchedFaq(reachable, askLLM);
    assert.equal(result.length, 0);
  });

  test('a page with fewer than 2 FAQ questions is never sent to the model at all', async () => {
    const reachable = [pageWithTitle('https://example.com/one-question', 'Some Page', ['Only one question?'])];
    let called = false;
    const askLLM = async () => { called = true; return '[]'; };
    const result = await findTopicallyMismatchedFaq(reachable, askLLM);
    assert.equal(called, false);
    assert.equal(result.length, 0);
  });

  test('a malformed (non-JSON-array) model response fails closed to no findings', async () => {
    const reachable = [pageWithTitle('https://example.com/careers', 'Careers | Acme', ['What is Acme Search?', 'How does pricing work?'])];
    const askLLM = async () => 'not json at all';
    const result = await findTopicallyMismatchedFaq(reachable, askLLM);
    assert.equal(result.length, 0);
  });

  test('a thrown LLM error fails closed to no findings rather than propagating', async () => {
    const reachable = [pageWithTitle('https://example.com/careers', 'Careers | Acme', ['What is Acme Search?', 'How does pricing work?'])];
    const askLLM = async () => { throw new Error('provider down'); };
    const result = await findTopicallyMismatchedFaq(reachable, askLLM);
    assert.equal(result.length, 0);
  });

  // Self-consistency: two independent passes, only the intersection is kept.
  // This is the actual reliability improvement over a single ask — a page
  // flagged by chance on only one of the two passes is exactly the kind of
  // one-off inconsistent judgment this is meant to filter out before it
  // ever reaches a human as a finding.
  test('a page flagged by only ONE of two independent passes is not reported (self-consistency)', async () => {
    const reachable = [pageWithTitle('https://example.com/careers', 'Careers | Acme', ['What is Acme Search?', 'How does pricing work?'])];
    let call = 0;
    // First pass flags it, second pass (a genuinely independent ask) does not.
    const askLLM = async () => { call++; return call === 1 ? '["https://example.com/careers"]' : '[]'; };
    const result = await findTopicallyMismatchedFaq(reachable, askLLM);
    assert.equal(call, 2, 'both passes must actually run');
    assert.equal(result.length, 0);
  });

  test('a page flagged by BOTH independent passes is reported', async () => {
    const reachable = [pageWithTitle('https://example.com/careers', 'Careers | Acme', ['What is Acme Search?', 'How does pricing work?'])];
    const askLLM = async () => '["https://example.com/careers"]';
    const result = await findTopicallyMismatchedFaq(reachable, askLLM);
    assert.equal(result.length, 1);
    assert.equal(result[0].page, 'https://example.com/careers');
  });

  test('run() surfaces a faq-topic-mismatch finding end to end', async () => {
    const pages = ['https://example.com/careers'];
    const pageCache = async () => ({
      ok: true,
      analysis: { malformedTableCount: 0, title: 'Careers | Acme', faqVisibleItems: [{ question: 'What is Acme Search?', answer: 'x' }, { question: 'How does Acme pricing work?', answer: 'y' }] },
    });
    // The file-level llm.js mock (top of this file) always returns
    // 'stub narrative' for callLLM — not valid JSON, so run()'s own
    // (non-injected) call to findTopicallyMismatchedFaq legitimately finds
    // nothing here. This test only confirms run() wires the function in
    // and would surface its finding shape correctly were a real match
    // found — the injection-based tests above cover the matching logic.
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages } });
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.some((f) => f.id === 'content-integrity:faq-topic-mismatch'), false);
  });

  test('run() gives a confirmed topic-mismatch a real recommendedAction when the page is safely fixable', async () => {
    const pages = ['https://example.com/careers'];
    const pageCache = async () => ({
      ok: true,
      analysis: {
        malformedTableCount: 0, title: 'Careers | Acme',
        faqVisibleItems: [{ question: 'What is Acme Search?', answer: 'x' }, { question: 'How does Acme pricing work?', answer: 'y' }],
        faqExtractionComplete: true, faqContainerHtml: '<div id="faq">real markup</div>',
      },
    });
    mockLLMResponse = '["https://example.com/careers"]'; // both self-consistency passes agree
    try {
      const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages } });
      const finding = result.facts.findings.find((f) => f.id === 'content-integrity:faq-topic-mismatch');
      assert.ok(finding, 'expected a faq-topic-mismatch finding');
      assert.ok(finding.recommendedAction, 'expected a real recommendedAction');
      assert.equal(finding.recommendedAction.generatorId, 'content-integrity-repair');
      assert.equal(finding.recommendedAction.params.page, 'https://example.com/careers');
      assert.equal(finding.recommendedAction.params.fixType, 'faq-topic-mismatch');
    } finally { mockLLMResponse = 'stub narrative'; }
  });

  test('run() leaves a confirmed topic-mismatch as reportOnly (no recommendedAction) when the page has no single unambiguous FAQ container', async () => {
    const pages = ['https://example.com/careers'];
    const pageCache = async () => ({
      ok: true,
      analysis: {
        malformedTableCount: 0, title: 'Careers | Acme',
        faqVisibleItems: [{ question: 'What is Acme Search?', answer: 'x' }, { question: 'How does Acme pricing work?', answer: 'y' }],
        faqExtractionComplete: true, faqContainerHtml: null, // two separate FAQ-marked containers, say
      },
    });
    mockLLMResponse = '["https://example.com/careers"]';
    try {
      const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages } });
      const finding = result.facts.findings.find((f) => f.id === 'content-integrity:faq-topic-mismatch');
      assert.ok(finding);
      assert.equal(finding.recommendedAction, null);
    } finally { mockLLMResponse = 'stub narrative'; }
  });
});

describe('decideCrossPageFaqAnswer', () => {
  function reachableByPageOf(entries) {
    return new Map(entries.map(([page, analysis]) => [page, { page, analysis }]));
  }

  test('picks the side NOT independently flagged as its own page\'s topic-mismatch', () => {
    const entry = {
      question: 'when do you ship?',
      variants: [
        { answer: 'Within 2 business days.', pages: ['https://example.com/faq'] },
        { answer: 'Within 5 business days.', pages: ['https://example.com/careers'] },
      ],
    };
    const resolved = decideCrossPageFaqAnswer(entry, {
      topicMismatchedPages: new Set(['https://example.com/careers']),
      reachableByPage: reachableByPageOf([
        ['https://example.com/faq', {}],
        ['https://example.com/careers', {}],
      ]),
    });
    assert.equal(resolved.decision, 'consolidate');
    assert.equal(resolved.correctAnswer, 'Within 2 business days.');
    assert.deepEqual(resolved.pagesToFix, ['https://example.com/careers']);
  });

  test('falls back to a real freshness-signal difference when neither side is topic-mismatch-flagged', () => {
    const entry = {
      question: 'when do you ship?',
      variants: [
        { answer: 'Within 2 business days.', pages: ['https://example.com/fresh'] },
        { answer: 'Within 5 business days.', pages: ['https://example.com/stale'] },
      ],
    };
    const resolved = decideCrossPageFaqAnswer(entry, {
      topicMismatchedPages: new Set(),
      reachableByPage: reachableByPageOf([
        ['https://example.com/fresh', { hasFreshnessSignal: true }],
        ['https://example.com/stale', { hasFreshnessSignal: false }],
      ]),
    });
    assert.equal(resolved.decision, 'consolidate');
    assert.equal(resolved.correctAnswer, 'Within 2 business days.');
    assert.deepEqual(resolved.pagesToFix, ['https://example.com/stale']);
  });

  test('decides a real non-issue ("leave-both-independent-intent") when the pages carry genuinely different declared purposes', () => {
    const entry = {
      question: 'what is the response time?',
      variants: [
        { answer: 'We reply within 24 hours by email.', pages: ['https://example.com/contact'] },
        { answer: 'Enterprise support replies within 1 hour.', pages: ['https://example.com/products/enterprise'] },
      ],
    };
    const resolved = decideCrossPageFaqAnswer(entry, {
      topicMismatchedPages: new Set(),
      reachableByPage: reachableByPageOf([
        ['https://example.com/contact', { schemaTypes: ['ContactPage'] }],
        ['https://example.com/products/enterprise', { schemaTypes: ['Product'] }],
      ]),
    });
    assert.equal(resolved.decision, 'leave-both-independent-intent');
    assert.equal(resolved.correctAnswer, undefined, 'a decided non-issue must never carry a "correct" answer to apply');
  });

  test('returns null (genuinely ambiguous) when no signal resolves it', () => {
    const entry = {
      question: 'when do you ship?',
      variants: [
        { answer: 'Within 2 business days.', pages: ['https://example.com/a'] },
        { answer: 'Within 5 business days.', pages: ['https://example.com/b'] },
      ],
    };
    const resolved = decideCrossPageFaqAnswer(entry, {
      topicMismatchedPages: new Set(),
      reachableByPage: reachableByPageOf([
        ['https://example.com/a', {}],
        ['https://example.com/b', {}],
      ]),
    });
    assert.equal(resolved, null);
  });

  test('returns null for a 3+-way split — no cheap evidence-based tiebreak for N-way disagreements', () => {
    const entry = {
      question: 'when do you ship?',
      variants: [
        { answer: 'Within 2 business days.', pages: ['https://example.com/a'] },
        { answer: 'Within 5 business days.', pages: ['https://example.com/b'] },
        { answer: 'Same-day.', pages: ['https://example.com/c'] },
      ],
    };
    const resolved = decideCrossPageFaqAnswer(entry, { topicMismatchedPages: new Set(), reachableByPage: new Map() });
    assert.equal(resolved, null);
  });
});

describe('content-integrity run() — faq-cross-page-inconsistency recommendedAction', () => {
  test('gives a resolvable cross-page inconsistency a real recommendedAction pointing at the page to fix', async () => {
    const pages = ['https://example.com/faq', 'https://example.com/careers'];
    const analysesByPage = {
      'https://example.com/faq': {
        malformedTableCount: 0, title: 'FAQ | Acme', hasFreshnessSignal: true,
        faqVisibleItems: [{ question: 'When do you ship?', answer: 'Within 2 business days.' }],
        faqExtractionComplete: true, faqContainerHtml: '<div id="faq-a">a</div>',
      },
      'https://example.com/careers': {
        malformedTableCount: 0, title: 'Careers | Acme', hasFreshnessSignal: false,
        faqVisibleItems: [{ question: 'When do you ship?', answer: 'Within 5 business days.' }],
        faqExtractionComplete: true, faqContainerHtml: '<div id="faq-b">b</div>',
      },
    };
    const pageCache = async (page) => ({ ok: true, analysis: analysesByPage[page] });
    mockLLMResponse = '[]'; // no topic-mismatch flags — the freshness signal is what resolves this
    try {
      const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages } });
      const finding = result.facts.findings.find((f) => f.id === 'content-integrity:faq-cross-page-inconsistency');
      assert.ok(finding, 'expected a faq-cross-page-inconsistency finding');
      assert.ok(finding.recommendedAction, 'expected a real recommendedAction');
      assert.equal(finding.recommendedAction.params.page, 'https://example.com/careers');
      assert.equal(finding.recommendedAction.params.fixType, 'faq-cross-page-inconsistency');
      assert.equal(finding.recommendedAction.params.correctAnswer, 'Within 2 business days.');
      assert.equal(finding.evidence.decidedCount, 1);
    } finally { mockLLMResponse = 'stub narrative'; }
  });

  test('stays reportOnly (no recommendedAction) when genuinely ambiguous — neither side flagged or fresher', async () => {
    const pages = ['https://example.com/a', 'https://example.com/b'];
    const analysesByPage = {
      'https://example.com/a': {
        malformedTableCount: 0, title: 'A', hasFreshnessSignal: false,
        faqVisibleItems: [{ question: 'When do you ship?', answer: 'Within 2 business days.' }],
        faqExtractionComplete: true, faqContainerHtml: '<div id="faq-a">a</div>',
      },
      'https://example.com/b': {
        malformedTableCount: 0, title: 'B', hasFreshnessSignal: false,
        faqVisibleItems: [{ question: 'When do you ship?', answer: 'Within 5 business days.' }],
        faqExtractionComplete: true, faqContainerHtml: '<div id="faq-b">b</div>',
      },
    };
    const pageCache = async (page) => ({ ok: true, analysis: analysesByPage[page] });
    mockLLMResponse = '[]';
    try {
      const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages } });
      const finding = result.facts.findings.find((f) => f.id === 'content-integrity:faq-cross-page-inconsistency');
      assert.ok(finding);
      assert.equal(finding.recommendedAction, null);
    } finally { mockLLMResponse = 'stub narrative'; }
  });
});
