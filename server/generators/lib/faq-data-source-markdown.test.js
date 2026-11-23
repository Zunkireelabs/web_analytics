import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let fileText = '';
mock.module(resolve('../../github/client.js'), { namedExports: { getFileContent: async () => ({ content: fileText }), defaultBranchName: () => 'main' } });
mock.module(resolve('../../implementers/lib/url-file-map.js'), { namedExports: { resolveFile: () => 'src/content/blog/post.md' } });
const { findRealFaqDataSource } = await import('./faq-data-source.js');
const site = { repo_owner: 'o', repo_name: 'r' };

test('a Markdown page\'s own FAQ is the real data: its questions, verbatim, never invented ones', async () => {
  fileText = '---\ntitle: "T"\n---\n\n## FAQ\n\n### Does it work?\n\nYes, it does.\n\n### Is it fast?\n\nVery.\n';
  const r = await findRealFaqDataSource(site, 'https://x.com/blog/post');
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, [{ question: 'Does it work?', answer: 'Yes, it does.' }, { question: 'Is it fast?', answer: 'Very.' }]);
  assert.equal(r.dataFile, 'src/content/blog/post.md');
});

test('a Markdown page with no FAQ of its own is left to the normal path', async () => {
  fileText = '---\ntitle: "T"\n---\n\n## Body\n\nText.\n';
  const r = await findRealFaqDataSource(site, 'https://x.com/blog/post');
  assert.equal(r.ok, false);
  assert.equal(r.organicSignal, false);
});
