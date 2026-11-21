import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, isTemplatedFile, siblingSourcePaths, guardSiteRootWrite } from './site-root-write-guard.js';

const repo = (files) => async (p) => (p in files ? { content: files[p] } : null);
const NJK = '---\npermalink: /llms.txt\neleventyExcludeFromCollections: true\n---\n# Zennly\n\n> body\n';

describe('splitFrontMatter / isTemplatedFile', () => {
  test('separates Eleventy front matter from the body, and leaves a plain file alone', () => {
    const s = splitFrontMatter(NJK);
    assert.equal(s.frontMatter, '---\npermalink: /llms.txt\neleventyExcludeFromCollections: true\n---\n');
    assert.equal(s.body, '# Zennly\n\n> body\n');
    assert.deepEqual(splitFrontMatter('# plain\n'), { frontMatter: null, body: '# plain\n' });
  });
  test('front matter or template syntax makes a file a template; plain text does not', () => {
    assert.equal(isTemplatedFile(NJK), true);
    assert.equal(isTemplatedFile('User-agent: *\n{% if env %}x{% endif %}'), true);
    assert.equal(isTemplatedFile('User-agent: *\nAllow: /\n'), false);
  });
  test('siblingSourcePaths: the template names an SSG could use for the same output', () => {
    assert.ok(siblingSourcePaths('src/llms.txt').includes('src/llms.njk'));
    assert.deepEqual(siblingSourcePaths('src/llms.njk'), []);
  });
});

describe('guardSiteRootWrite — llms', () => {
  test('a plain existing file is overwritten as before', async () => {
    assert.deepEqual(await guardSiteRootWrite({ path: 'public/llms.txt', kind: 'llms', readFile: repo({ 'public/llms.txt': '# old\n' }) }), { ok: true, mode: 'overwrite' });
  });
  test('a template keeps its front matter, so the permalink survives', async () => {
    const g = await guardSiteRootWrite({ path: 'src/llms.njk', kind: 'llms', readFile: repo({ 'src/llms.njk': NJK }) });
    assert.equal(g.ok, true);
    assert.equal(g.mode, 'keep-front-matter');
    assert.match(g.frontMatter, /permalink: \/llms\.txt/);
  });
  test('chayce case: a mapped path that does not exist next to the real template is refused, never created', async () => {
    const g = await guardSiteRootWrite({ path: 'src/llms.txt', kind: 'llms', readFile: repo({ 'src/llms.njk': NJK }) });
    assert.equal(g.ok, false);
    assert.equal(g.reason, 'output-conflict');
    assert.match(g.error, /src\/llms\.njk/);
  });
  test('a genuinely new file with no other source is created', async () => {
    assert.deepEqual(await guardSiteRootWrite({ path: 'public/llms.txt', kind: 'llms', readFile: repo({}) }), { ok: true, mode: 'create' });
  });
});

describe('guardSiteRootWrite — robots-bootstrap only ever creates', () => {
  test('zennly case: an existing robots template is never overwritten', async () => {
    const g = await guardSiteRootWrite({ path: 'src/robots.njk', kind: 'robots-bootstrap', readFile: repo({ 'src/robots.njk': '---\npermalink: /robots.txt\n---\n{% if env == "production" %}User-agent: *{% endif %}' }) });
    assert.equal(g.ok, false);
    assert.equal(g.reason, 'file-exists');
    assert.match(g.error, /as a template/);
    assert.match(g.error, /build or deploy problem/);
  });
  test('an existing plain robots.txt is not overwritten either', async () => {
    assert.equal((await guardSiteRootWrite({ path: 'public/robots.txt', kind: 'robots-bootstrap', readFile: repo({ 'public/robots.txt': 'User-agent: *\n' }) })).reason, 'file-exists');
  });
  test('no robots source anywhere: creating it is allowed', async () => {
    assert.deepEqual(await guardSiteRootWrite({ path: 'public/robots.txt', kind: 'robots-bootstrap', readFile: repo({}) }), { ok: true, mode: 'create' });
  });
  test('a robots template at a sibling path blocks creating a second source', async () => {
    assert.equal((await guardSiteRootWrite({ path: 'src/robots.txt', kind: 'robots-bootstrap', readFile: repo({ 'src/robots.njk': '---\n---\n' }) })).reason, 'output-conflict');
  });
});
