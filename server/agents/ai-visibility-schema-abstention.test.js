import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

// Same stub set as ai-visibility-finding-ids.test.js, with the one difference
// this file exists for: inferSchemaType ABSTAINS. That is now a real
// production case — page-content.js's inferSchemaType returns null rather
// than defaulting an unrecognised URL path to 'Article', which on a
// non-English site is every single page.
mock.module(resolve('./lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => ({
      ok: true,
      analysis: {
        schemaTypes: [], h1Count: 0, h2Count: 0, listCount: 0, tableCount: 0,
        hasFaqSchema: false, hasFaqHeading: false, questionHeadingCount: 0,
        hasAuthorSignal: false, hasComparisonContent: false, hasFreshnessSignal: false,
      },
    }),
    checkLlmsReadiness: async () => ({ hasLlmsTxt: true, hasValidLlmsTxtStructure: true, hasRobotsTxt: true, robotsAllowsAiCrawlers: true }),
    checkWebMcpPresence: async () => ({ hasManifest: true }),
    effortForGenerator: () => 'Medium',
    inferSchemaType: () => null,
  },
});
mock.module(resolve('../store/read.js'), {
  namedExports: { getQueriesForPage: async () => [{ query: 'roof repair' }] },
});
mock.module(resolve('./lib/candidate-pages.js'), {
  namedExports: { selectCandidatePages: async () => ({ batch: [], impressionsByPage: new Map() }), markPagesChecked: async () => {} },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const { run } = await import('./ai-visibility.js');

const runOnce = () => run({ siteId: 1, start: '2026-08-01', end: '2026-08-28', params: { pages: ['https://example.com/p'] } });

describe('ai-visibility — schema actions when the page type cannot be derived', () => {
  // generators/schema.js throws a 400 on a missing schemaType, so a schema
  // action with no type is work that can only ever fail — re-queued on every
  // run, forever. opportunity.js and content-gap.js make the same abstention.
  test('never offers a schema-generator action with a null schemaType', async () => {
    const { facts } = await runOnce();
    const schemaActions = facts.findings
      .map((f) => f.recommendedAction)
      .filter((a) => a?.generatorId === 'schema');
    assert.deepEqual(schemaActions, []);
  });

  // The gap the agent detected is still real and still verified — only the
  // draft offer is withheld, so the finding must survive.
  test('still reports the schema findings themselves, with no action', async () => {
    const { facts } = await runOnce();
    const schemaFindings = facts.findings.filter((f) => /^ai-visibility:(add-schema|entity-schema):/.test(f.id));
    assert.equal(schemaFindings.length > 0, true);
    for (const f of schemaFindings) assert.equal(f.recommendedAction, null);
  });

  // Abstaining on schema must not disarm the rest of the agent — every other
  // generator treats schemaType as optional.
  test('non-schema actions are unaffected', async () => {
    const { facts } = await runOnce();
    const faqAction = facts.findings.map((f) => f.recommendedAction).find((a) => a?.generatorId === 'faq');
    assert.equal(!!faqAction, true);
    assert.equal(faqAction.params.schemaType, null);
    assert.equal(faqAction.params.page, 'https://example.com/p');
  });
});
