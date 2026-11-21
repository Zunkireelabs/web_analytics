import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The llms.txt and robots-bootstrap writes go through lib/site-root-write-guard.js. Only the two GitHub touch points are replaced.
let files, pushes;
const resolve = (p) => new URL(p, import.meta.url).href;
// The real GitHub client cannot be imported under the module-mock loader here (a dependency quirk), so both GitHub modules are stubbed
// with every export name they really have; only the two touch points this test is about do anything.
const exportNames = (rel) => [...readFileSync(new URL(rel, import.meta.url), 'utf8').matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
const stub = (rel, overrides) => ({
  ...Object.fromEntries(exportNames(rel).map((n) => [n, async () => { throw new Error(`${n} must not be reached in this test`); }])),
  ...overrides,
});
mock.module(resolve('../github/client.js'), { namedExports: stub('../github/client.js', { getFileContent: async (_site, path) => (path in files ? { content: files[path] } : null) }) });
// llm.js pulls in the openai SDK, which cannot load under the module-mock loader here either; nothing in these paths calls it.
mock.module(resolve('../llm.js'), { namedExports: stub('../llm.js', {}) });
mock.module(resolve('./lib/github-ops.js'), {
  namedExports: stub('./lib/github-ops.js', { baseBranch: () => 'main', resolveBatchBranch: async () => ({ batchInfo: { exists: false, conflicted: false, branchName: 'seoai/batch-test' }, failure: null }), pushDraftBranch: async (_site, _draft, list) => { pushes.push(list); return { ok: true, pushed: list.length }; } }),
});
const { apply } = await import('./backend.js');

const site = (siteRoot) => ({ id: 1, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', url_file_map: { siteRoot } });
const NJK = '---\npermalink: /llms.txt\n---\n# old body\n';

beforeEach(() => { files = {}; pushes = []; });

describe('llms-txt write', () => {
  const draft = (extra = {}) => ({ action_type: 'llms-txt', content: { llmsTxt: '# New llms\n\n> text\n', ...extra } });

  test('a plain mapped file is overwritten', async () => {
    files = { 'public/llms.txt': '# old\n' };
    const r = await apply(site({ llmsTxt: 'public/llms.txt' }), draft());
    assert.equal(r.ok, true);
    assert.equal(pushes[0][0].content, '# New llms\n\n> text\n');
  });
  test('a template keeps its front matter, so its permalink is not lost', async () => {
    files = { 'src/llms.njk': NJK };
    await apply(site({ llmsTxt: 'src/llms.njk' }), draft());
    assert.equal(pushes[0][0].content, '---\npermalink: /llms.txt\n---\n# New llms\n\n> text\n');
  });
  test('chayce case: a mapped path that does not exist beside the real template writes nothing', async () => {
    files = { 'src/llms.njk': NJK };
    const r = await apply(site({ llmsTxt: 'src/llms.txt' }), draft());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'output-conflict');
    assert.equal(pushes.length, 0);
  });
  test('a templated robots file is left alone while llms.txt is still written', async () => {
    files = { 'src/llms.njk': NJK, 'src/robots.njk': '---\npermalink: /robots.txt\n---\n{% if env == "production" %}User-agent: *{% endif %}' };
    await apply(site({ llmsTxt: 'src/llms.njk', robotsTxt: 'src/robots.njk' }), draft({ robotsDirectives: 'User-agent: GPTBot\nAllow: /\n' }));
    assert.deepEqual(pushes[0].map((f) => f.path), ['src/llms.njk']);
  });
  test('a plain robots file still gets its directives, as before', async () => {
    files = { 'public/llms.txt': '# old\n', 'public/robots.txt': 'User-agent: *\n' };
    await apply(site({ llmsTxt: 'public/llms.txt', robotsTxt: 'public/robots.txt' }), draft({ robotsDirectives: 'User-agent: GPTBot\nAllow: /\n' }));
    assert.deepEqual(pushes[0].map((f) => f.path), ['public/llms.txt', 'public/robots.txt']);
  });
});

describe('robots-bootstrap write', () => {
  const draft = { action_type: 'robots-bootstrap', content: { robotsTxt: 'User-agent: *\nAllow: /\n' } };

  test('zennly case: an existing robots template is never overwritten', async () => {
    files = { 'src/robots.njk': '---\npermalink: /robots.txt\n---\n{% if env == "production" %}x{% endif %}' };
    const r = await apply(site({ robotsTxt: 'src/robots.njk' }), draft);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'file-exists');
    assert.equal(pushes.length, 0);
  });
  test('with no robots source at all it creates the file, as it always did', async () => {
    const r = await apply(site({ robotsTxt: 'public/robots.txt' }), draft);
    assert.equal(r.ok, true);
    assert.equal(pushes[0][0].path, 'public/robots.txt');
  });
});
