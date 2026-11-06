import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validatePageDesignIntegrity } from './page-design-integrity-gate.js';

const BASE = '<main><section class="post-wrap prose"><p>Body</p></section></main>';
const site = { id: 3, url_file_map: { siteRoot: {
  designProfile: { typography: { body: 'text-base' }, pages: [{ url: 'https://x.test/blog/b', sections: [{ role: 'content', classes: 'captured-only-class' }] }] },
  componentTemplates: { faq: { wrapper: '<div class="faq-wrap">{{ROWS}}</div>', row: '<div class="faq-row">{{Q}}</div>' } },
} } };
const run = (after, { draft = { id: 1, action_type: 'faq', input: { page: '/blog/b' } }, mode = 'enforce', base = BASE } = {}) => {
  const records = [];
  return validatePageDesignIntegrity(site, draft, [{ path: 'src/b.njk', content: after }], { fetchFile: async () => (base == null ? null : { content: base }), mode, record: async (id, r) => records.push(r) }).then((r) => ({ r, records }));
};

describe('validatePageDesignIntegrity', () => {
  test('allowed vocabulary: the file\'s own classes, the captured design, verified templates and THIS page\'s captured sections', async () => {
    const { r } = await run(BASE.replace('</main>', '<div class="faq-wrap faq-row text-base captured-only-class post-wrap"></div></main>'));
    assert.equal(r.ok, true);
  });
  test('every decision is recorded as evidence — passes included — with mode and issue types (M2)', async () => {
    const pass = await run(BASE);
    assert.deepEqual(pass.records.map((x) => [x.kind, x.ok, x.mode]), [['integrity', true, 'enforce']]);
    const fail = await run(BASE + '<div class="new-thing"></div>', { mode: 'log' });
    assert.equal(fail.r.ok, true, 'log mode ships');
    assert.deepEqual(fail.records[0].issues, [{ type: 'unknown-class', classes: ['new-thing'] }]);
    assert.equal(fail.records[0].mode, 'log');
  });
  test('structured-data and analytics edits may add their scripts; others may not', async () => {
    const withScript = BASE + '<script async src="https://www.googletagmanager.com/gtag/js"></script>';
    assert.equal((await run(withScript, { draft: { id: 1, action_type: 'analytics-install' } })).r.ok, true);
    assert.equal((await run(withScript, { draft: { id: 1, action_type: 'faq' } })).r.ok, false);
    assert.equal((await run(BASE + '<script type="application/ld+json">{}</script>', { draft: { id: 1, action_type: 'schema' } })).r.ok, true);
  });
  test('an unreadable base fails OPEN (same contract as the section-preservation gate)', async () => {
    assert.equal((await run(BASE + '<div class="new-thing"></div>', { base: null })).r.ok, true);
  });
  test('a recorder that throws never blocks or crashes the push', async () => {
    const r = await validatePageDesignIntegrity(site, { id: 1, action_type: 'faq' }, [{ path: 'a.njk', content: BASE }], { fetchFile: async () => ({ content: BASE }), mode: 'enforce', record: async () => { throw new Error('db down'); } });
    assert.equal(r.ok, true);
  });
  test('net-new files: checked against the SITE vocabulary, recorded as evidence, log mode by default; enforce blocks', async () => {
    const records = [];
    const run2 = (content, env) => { const prev = process.env.PAGE_DESIGN_INTEGRITY_NEW_FILES; if (env) process.env.PAGE_DESIGN_INTEGRITY_NEW_FILES = env; else delete process.env.PAGE_DESIGN_INTEGRITY_NEW_FILES;
      return validatePageDesignIntegrity(site, { id: 2, action_type: 'landing-page' }, [{ path: 'src/new.njk', content }], { fetchFile: async () => null, mode: 'enforce', record: async (id, r) => records.push(r) })
        .finally(() => { if (prev === undefined) delete process.env.PAGE_DESIGN_INTEGRITY_NEW_FILES; else process.env.PAGE_DESIGN_INTEGRITY_NEW_FILES = prev; }); };
    assert.equal((await run2('<div class="faq-wrap captured-only-class text-base"></div>')).ok, true, 'site vocabulary passes');
    assert.equal((await run2('<div class="neon-hero"></div>')).ok, true, 'log mode ships…');
    assert.equal(records.at(-1).kind, 'integrity-new-file'); assert.equal(records.at(-1).ok, false, '…but the violation is recorded');
    assert.equal((await run2('<div class="neon-hero"></div>', 'enforce')).ok, false, 'enforce blocks');
  });
});
