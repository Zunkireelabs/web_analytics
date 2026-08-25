import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let files; // path -> raw content string, or undefined for "not found"

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getFileContent: async (site, path) => {
      const content = files[path];
      return content === undefined ? null : { content, sha: 'abc123' };
    },
    defaultBranchName: (site) => site.repo_default_branch || 'main',
  },
});

const { findRealFaqDataSource } = await import('./faq-data-source.js');

const TEMPLATE_PATH = 'src/pages/resources/index.njk';
const site = {
  repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web', repo_default_branch: 'main',
  url_file_map: { pages: { '/resources/': { file: TEMPLATE_PATH } } },
};

const ORGANIC_LOOP = '{% for item in faq %}<h3>{{ item.question }}</h3><p>{{ item.answer }}</p>{% endfor %}';
const REAL_FAQ_JSON = JSON.stringify([
  { question: 'What is Zunkiree Labs?', answer: 'An AI development company in Kathmandu, Nepal.' },
  { question: 'Is Zunkiree Labs based in Nepal?', answer: 'Yes, headquartered in Kathmandu.' },
]);

beforeEach(() => { files = {}; });

describe('findRealFaqDataSource', () => {
  test('reads real Q&A pairs from the template loop\'s backing data file', async () => {
    files[TEMPLATE_PATH] = `<section>${ORGANIC_LOOP}</section>`;
    files['src/_data/faq.json'] = REAL_FAQ_JSON;
    const result = await findRealFaqDataSource(site, '/resources/');
    assert.equal(result.ok, true);
    assert.equal(result.dataFile, 'src/_data/faq.json');
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].question, 'What is Zunkiree Labs?');
  });

  test('returns null (capability gap) when no repo is connected', async () => {
    const result = await findRealFaqDataSource({ repo_owner: null, repo_name: null }, '/resources/');
    assert.equal(result, null);
  });

  test('reports no organic signal when the template has no FAQ evidence at all', async () => {
    files[TEMPLATE_PATH] = '<section><h1>No FAQ here</h1></section>';
    const result = await findRealFaqDataSource(site, '/resources/');
    assert.deepEqual(result, { ok: false, organicSignal: false });
  });

  test('ignores a loop that only exists inside a tool-managed marker block', async () => {
    files[TEMPLATE_PATH] = `<!-- SEOAI:QACONTENT:START -->${ORGANIC_LOOP}<!-- SEOAI:QACONTENT:END -->`;
    files['src/_data/faq.json'] = REAL_FAQ_JSON;
    const result = await findRealFaqDataSource(site, '/resources/');
    assert.deepEqual(result, { ok: false, organicSignal: false });
  });

  test('a "faq"-named variable whose loop body has no question/answer fields cannot be grounded, but still conservatively flags organicSignal (a "faq"-shaped loop exists — refuse rather than risk fabricating over it)', async () => {
    files[TEMPLATE_PATH] = '{% for cat in faqCategories %}<a href="{{ cat.url }}">{{ cat.label }}</a>{% endfor %}';
    files['src/_data/faqCategories.json'] = '[{"url":"/a","label":"A"}]';
    const result = await findRealFaqDataSource(site, '/resources/');
    assert.deepEqual(result, { ok: false, organicSignal: true });
  });

  test('flags organicSignal when a real loop exists but its data file is missing — caller must refuse, not fabricate', async () => {
    files[TEMPLATE_PATH] = ORGANIC_LOOP;
    // files['src/_data/faq.json'] intentionally absent
    const result = await findRealFaqDataSource(site, '/resources/');
    assert.deepEqual(result, { ok: false, organicSignal: true });
  });

  test('flags organicSignal when the data file has fewer than 2 valid pairs', async () => {
    files[TEMPLATE_PATH] = ORGANIC_LOOP;
    files['src/_data/faq.json'] = JSON.stringify([{ question: 'Only one?', answer: 'Yes.' }]);
    const result = await findRealFaqDataSource(site, '/resources/');
    assert.deepEqual(result, { ok: false, organicSignal: true });
  });

  test('flags organicSignal for a hand-authored accordion with no data-file loop at all', async () => {
    files[TEMPLATE_PATH] = '<div x-data="{ activeIndex: null }"><h3>Frequently Asked Questions</h3></div>';
    const result = await findRealFaqDataSource(site, '/resources/');
    assert.deepEqual(result, { ok: false, organicSignal: true });
  });

  test('returns null (capability gap) when no url_file_map mapping exists for the page', async () => {
    const result = await findRealFaqDataSource({ ...site, url_file_map: { pages: {} } }, '/resources/');
    assert.equal(result, null);
  });
});
