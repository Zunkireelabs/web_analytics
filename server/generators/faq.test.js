import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let dataSourceResult; // what findRealFaqDataSource should return for the next call
let siteForPage;

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => siteForPage },
});
mock.module(resolve('./lib/faq-data-source.js'), {
  namedExports: { findRealFaqDataSource: async () => dataSourceResult },
});
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => ({ ok: false, error: 'not used in these tests' }),
    hasSufficientGroundingContent: () => false,
  },
});
// Every test below either throws before reaching an LLM call, or supplies
// real backing data that lets faq.js draft verbatim with none — so this
// never needs to run for real. Mocked (not just left unmocked and unused)
// specifically to keep the real `openai` package (llm.js's import of it)
// out of this process: node:test's --experimental-test-module-mocks loader
// has a real bug where, once mock.module() has installed its hook, later
// loading `openai` (-> formdata-node -> web-streams-polyfill) breaks that
// package's conditional-exports resolution ("does not provide an export
// named 'ReadableStream'") — reproducible with no code from this repo
// involved at all. Mocking llm.js here means the real `openai` module is
// simply never imported in this test process, sidestepping the bug rather
// than working around it.
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async () => { throw new Error('callLLMForJson should not be called by these tests'); },
  },
});

const { generate, meta } = await import('./faq.js');

// Only exercises the input-validation path, which throws before ever
// calling the LLM — no real network/API key needed, same convention as the
// other generator tests. The page-purpose-guidance prompt content is
// covered by manual/sandbox verification, not unit tests; the rendered
// FAQ-block output is covered separately in marker-merge.test.js.
describe('faq generator', () => {
  test('requires query or topic', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'faq');
  });
});

// Real incident, 2026-08-25: faq.js fabricated a brand-new, mismatched FAQ
// for a page (/resources/) that already had real, correct FAQ content
// sitting in the repo's own data file. These cover the fix: prefer real
// data when it's found, and refuse rather than fabricate when the page
// clearly has FAQ content this generator can't confidently ground in.
describe('faq generator — real-data grounding (2026-08-25 fix)', () => {
  siteForPage = { id: 1, repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web' };

  test('uses real Q&A pairs verbatim, with no LLM call, when the page has real backing data', async () => {
    dataSourceResult = {
      ok: true,
      dataFile: 'src/_data/faq.json',
      items: [
        { question: 'What is Zunkiree Labs?', answer: 'An AI development company in Kathmandu, Nepal.' },
        { question: 'Is Zunkiree Labs based in Nepal?', answer: 'Yes, headquartered in Kathmandu.' },
      ],
    };
    const { content, summary } = await generate({ siteId: 1, params: { page: 'https://zunkireelabs.com/resources/', query: 'resources' } });
    assert.equal(content.groundedInRealData, 'src/_data/faq.json');
    assert.equal(content.items.length, 2);
    assert.equal(content.items[0].question, 'What is Zunkiree Labs?');
    assert.equal(content.schemaJsonLd.mainEntity.length, 2);
    assert.equal(content.schemaJsonLd.mainEntity[0].name, 'What is Zunkiree Labs?');
    assert.match(summary, /real FAQ item/);
  });

  test('refuses rather than fabricates when the page has organic FAQ content that could not be confidently read', async () => {
    dataSourceResult = { ok: false, organicSignal: true };
    await assert.rejects(
      generate({ siteId: 1, params: { page: 'https://zunkireelabs.com/resources/', query: 'resources' } }),
      /already has real FAQ content/,
    );
  });
});
