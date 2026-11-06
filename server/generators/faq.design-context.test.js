// C1 — the validated design context must reach a REAL generator in real execution.
//
// The real faq.js generate() runs here, unmodified. Only its I/O is mocked: the site row it
// re-fetches (deliberately WITHOUT any attached context, exactly as getSiteById returns it in
// production), the page reader, the FAQ data-source lookup, tenant context and the LLM call
// (which captures the prompt). The assertion is on what the generator actually sent the model.
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const prompts = [];
const SITE = { id: 7, url_file_map: { siteRoot: { designProfile: { pages: [], pageTypePatterns: { faq: { sectionOrder: ['OLD-TYPE-SUMMARY'], textHierarchy: [] } } } } } };

mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => JSON.parse(JSON.stringify(SITE)), getSearchPerformanceRange: async () => [] } });
mock.module(resolve('../agents/lib/page-content.js'), { namedExports: { analyzePageUrl: async () => ({ ok: false }), hasSufficientGroundingContent: () => false } });
mock.module(resolve('./lib/faq-data-source.js'), { namedExports: { findRealFaqDataSource: async () => null } });
mock.module(resolve('../lib/tenant-context.js'), { namedExports: { tenantContextTextFor: async () => '' } });
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async (system, user) => { prompts.push(user); await new Promise((r) => setTimeout(r, 10)); return [{ question: 'How long does it take?', answer: 'About a day.' }]; },
    callLLM: async () => '',
  },
});

const { generate } = await import('./faq.js');
const { runWithDesignContexts } = await import('../design-agent/lib/design-context-scope.js');
const { resolveOrCreateCanonicalPageTemplate } = await import('../design-agent/lib/page-templates.js');
const { pageStructureGuidance } = await import('./lib/design-aware-composer.js');

const ctx = (path, groupId, roles) => ({
  version: 2, status: 'matched', source: 'group-sample', provisional: false, pagePath: path, groupId, sampleUrl: `/sample-of-${groupId}`,
  validatedAt: '2026-11-07T10:00:00.000Z', pageType: 'blog-article',
  sections: roles.map((role) => ({ role, width: 'full', alignment: 'left' })),
  pattern: { sectionOrder: roles, textHierarchy: [{ role: 'subheading', classes: 'post-h2' }] },
  fingerprint: { version: 2, hash: 'h' }, vocabulary: [],
});

describe('validated design context in real generator execution', () => {
  test('the real faq generator\'s prompt carries the VALIDATED design, not the stale page-type summary', async () => {
    prompts.length = 0;
    await runWithDesignContexts([ctx('/blog/b', 'g1', ['hero', 'content', 'faq'])], () => generate({ siteId: 7, params: { page: 'https://x.test/blog/b', topic: 'moving' } }));
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /checked against the live site on 2026-11-07 and matches layout group g1/);
    assert.match(prompts[0], /hero full left -> content full left -> faq full left/);
    assert.doesNotMatch(prompts[0], /OLD-TYPE-SUMMARY/);
  });

  test('without a validated context the generator behaves exactly as before (old guidance)', async () => {
    prompts.length = 0;
    await generate({ siteId: 7, params: { page: 'https://x.test/blog/b', topic: 'moving' } });
    assert.match(prompts[0], /OLD-TYPE-SUMMARY/);
  });

  test('CONCURRENT drafts for different pages each get their own page\'s design — never each other\'s', async () => {
    prompts.length = 0;
    await Promise.all([
      runWithDesignContexts([ctx('/blog/b', 'gA', ['hero', 'content'])], () => generate({ siteId: 7, params: { page: 'https://x.test/blog/b', topic: 'a' } })),
      runWithDesignContexts([ctx('/services/x', 'gB', ['banner', 'grid', 'cta'])], () => generate({ siteId: 7, params: { page: 'https://x.test/services/x', topic: 'b' } })),
    ]);
    const a = prompts.find((p) => /layout group gA/.test(p));
    const b = prompts.find((p) => /layout group gB/.test(p));
    assert.ok(a && b);
    assert.doesNotMatch(a, /gB|banner/); assert.doesNotMatch(b, /gA|hero full/);
  });

  test('the page-template builder reads the SAME object as the composer, and does not persist it', async () => {
    const c = ctx('/blog/b', 'g1', ['hero', 'content', 'faq']);
    await runWithDesignContexts([c], async () => {
      const site = JSON.parse(JSON.stringify(SITE));
      const built = await resolveOrCreateCanonicalPageTemplate(site, ['blog-article'], { pageUrl: 'https://x.test/blog/b', saveConfig: async () => assert.fail('a validated per-page context must not overwrite the page TYPE template') });
      assert.equal(built.source, 'validated-context');
      assert.deepEqual(built.template.sectionOrder, c.pattern.sectionOrder);
      assert.deepEqual(built.template.validatedContext.groupId, 'g1');
      assert.match(pageStructureGuidance(site, 'faq', { pageUrl: 'https://x.test/blog/b' }), /layout group g1/);
    });
  });
});
