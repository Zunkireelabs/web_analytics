import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeChange, isDataReady, identifyTarget, keyFromPage } from './ts-named-export-content.js';
import { verifyDataEdit, findNamedExport, listTopLevelEntries, parseDataLiteral } from './lib/ts-export-data.js';

const POST_FAQS = `// Header comment mentioning export const postFaqs = {} should not confuse the locator.
export interface PostFaqItem {
  question: string;
  answer: string;
}

export const postFaqs: Record<string, PostFaqItem[]> = {
  "existing-post": [
    {
      question: "Hand written question?",
      answer: "Hand written answer with [brackets], {braces} and a \\"quote\\".",
    },
  ],
  "empty-post": [],
  'single-quoted-post': [
    { question: 'Q one?', answer: 'A one.' },
  ],
};

export const somethingElse = ["keep me"];
`;

const PAGE_FAQS = `import type { FAQItem } from "@/components/ui/FAQ";

export const blogIndexFaqs: FAQItem[] = [
  {
    question: "What does the blog cover?",
    answer: "Guides.",
  },
];

export const categoryFaqs: Record<string, FAQItem[]> = {
  "visa-guides": [
    { question: "Where from?", answer: "Official pages." },
  ],
};
`;

const files = { 'src/data/post-faqs.ts': POST_FAQS, 'src/data/page-faqs.ts': PAGE_FAQS, 'src/content/blog/posts/new-post.json': '{"slug":"new-post"}', 'src/content/blog/categories.json': '[{"slug": "scholarships"}]' };
const fetchFile = async (_s, path) => (path in files ? { content: files[path] } : null);

const faqCfg = (over) => ({ id: 'ts-named-export-content', dataFile: 'src/data/post-faqs.ts', exportName: 'postFaqs', shape: 'keyed-record', urlPattern: '^/([a-z0-9-]+)$', ...over });
const siteWith = (patterns) => ({ id: 8862, url_file_map: { patterns: patterns.map(([match, cfg]) => ({ match, adapters: { faq: cfg } })) } });
const postSite = (over) => siteWith([['^/([a-z0-9-]+)/?$', faqCfg(over)]]);
const draft = (page, items, action_type = 'faq') => ({ action_type, content: { page: `https://admizzeducation.com${page}`, items } });
const items = [{ question: 'New question?', answer: 'New answer.' }];

describe('ts-named-export-content — keyed-record (post-faqs.ts)', () => {
  test('adds a managed block to an existing key, leaves hand-authored items and every other key/export untouched', async () => {
    const r = await computeChange(postSite(), draft('/existing-post', items), fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    assert.match(r.newContent, /SEOAI:FAQ:START/);
    assert.match(r.newContent, /Hand written answer with \[brackets\], \{braces\} and a \\"quote\\"\./);
    assert.ok(r.newContent.includes('"empty-post": []'));
    assert.ok(r.newContent.includes("'single-quoted-post'"));
    assert.ok(r.newContent.endsWith('export const somethingElse = ["keep me"];\n'));
    assert.deepEqual(r.faqDiff.added.map((x) => x.question), ['New question?']);
    assert.equal(r.renderMode, 'visible');
  });

  test('handles a single-quoted key and an empty array', async () => {
    for (const slug of ['single-quoted-post', 'empty-post']) {
      const r = await computeChange(postSite(), draft(`/${slug}`, items), fetchFile, 'main');
      assert.equal(r.ok, true, `${slug}: ${r.error}`);
      assert.match(r.newContent, /New answer\./);
    }
  });

  test('is idempotent: a second apply of the same items produces identical file text', async () => {
    const first = await computeChange(postSite(), draft('/existing-post', items), fetchFile, 'main');
    files['src/data/post-faqs.ts'] = first.newContent;
    try {
      const second = await computeChange(postSite(), draft('/existing-post', items), fetchFile, 'main');
      assert.equal(second.ok, true, second.error);
      assert.equal(second.newContent, first.newContent);
      assert.equal(second.faqDiff.unchanged.length, 1);
      const changed = await computeChange(postSite(), draft('/existing-post', [{ question: 'New question?', answer: 'Better answer.' }]), fetchFile, 'main');
      assert.equal(changed.faqDiff.modified.length, 1);
      assert.match(changed.newContent, /Hand written answer/);
    } finally { files['src/data/post-faqs.ts'] = POST_FAQS; }
  });

  test('never duplicates a question a human already wrote; all-duplicates is "already-satisfied", not a write', async () => {
    const r = await computeChange(postSite(), draft('/existing-post', [{ question: ' hand WRITTEN question? ', answer: 'x' }]), fetchFile, 'main');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'already-satisfied');
    const mixed = await computeChange(postSite(), draft('/existing-post', [{ question: 'Hand written question?', answer: 'x' }, ...items]), fetchFile, 'main');
    assert.equal(mixed.ok, true);
    assert.equal((mixed.newContent.match(/Hand written question\?/g) || []).length, 1);
  });

  test('creates a missing key ONLY when allowCreateKey is set AND keyEvidence proves the page exists', async () => {
    const cfg = { allowCreateKey: true, keyEvidence: { file: 'src/content/blog/posts/{key}.json' } };
    const ok = await computeChange(postSite(cfg), draft('/new-post', items), fetchFile, 'main');
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.createdKey, 'new-post');
    assert.match(ok.newContent, /"new-post": \[/);

    const noEvidenceFile = await computeChange(postSite(cfg), draft('/not-a-post', items), fetchFile, 'main');
    assert.equal(noEvidenceFile.ok, false);
    assert.equal(noEvidenceFile.reason, 'target-not-identified');

    const noFlag = await computeChange(postSite({ keyEvidence: cfg.keyEvidence }), draft('/new-post', items), fetchFile, 'main');
    assert.equal(noFlag.reason, 'target-not-identified');

    const noEvidenceCfg = await computeChange(postSite({ allowCreateKey: true }), draft('/new-post', items), fetchFile, 'main');
    assert.equal(noEvidenceCfg.reason, 'target-not-identified');
  });

  test('keyEvidence.includes must actually be present in the evidence file', async () => {
    const cfg = { allowCreateKey: true, keyEvidence: { file: 'src/content/blog/posts/{key}.json', includes: '"slug":"other"' } };
    const r = await computeChange(postSite(cfg), draft('/new-post', items), fetchFile, 'main');
    assert.equal(r.reason, 'target-not-identified');
  });
});

describe('ts-named-export-content — page-faqs.ts (category keyed-record + blog index flat-array)', () => {
  const site = siteWith([
    ['^/category/([^/]+)/?$', faqCfg({ dataFile: 'src/data/page-faqs.ts', exportName: 'categoryFaqs', urlPattern: '^/category/([^/]+)$', allowCreateKey: true, keyEvidence: { file: 'src/content/blog/categories.json', includes: '"slug": "{key}"' } })],
    ['^/blogs/?$', faqCfg({ dataFile: 'src/data/page-faqs.ts', exportName: 'blogIndexFaqs', shape: 'flat-array', urlPattern: '^/blogs$' })],
  ]);

  test('category: existing key written, new proven key created, unproven key refused', async () => {
    const a = await computeChange(site, draft('/category/visa-guides', items), fetchFile, 'main');
    assert.equal(a.ok, true, a.error);
    const b = await computeChange(site, draft('/category/scholarships', items), fetchFile, 'main');
    assert.equal(b.ok, true, b.error);
    assert.equal(b.createdKey, 'scholarships');
    const c = await computeChange(site, draft('/category/made-up', items), fetchFile, 'main');
    assert.equal(c.reason, 'target-not-identified');
  });

  test('flat-array: writes into blogIndexFaqs and leaves categoryFaqs byte-identical', async () => {
    const r = await computeChange(site, draft('/blogs', items), fetchFile, 'main');
    assert.equal(r.ok, true, r.error);
    assert.ok(r.newContent.includes(PAGE_FAQS.slice(PAGE_FAQS.indexOf('export const categoryFaqs'))));
    assert.match(r.newContent, /What does the blog cover\?/);
  });
});

describe('ts-named-export-content — stops safely when the target cannot be identified', () => {
  const run = (site, page, f = fetchFile, d) => computeChange(site, d || draft(page, items), f, 'main');

  test('no adapter config for the page', async () => {
    const r = await run({ id: 1, url_file_map: { patterns: [] } }, '/existing-post');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-file-mapping');
  });
  test('url does not match urlPattern (e.g. a /course-finder/ page hitting a /[slug] pattern)', async () => {
    const r = await run(siteWith([['^/.*$', faqCfg()]]), '/course-finder/msc-computer-science');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-file-mapping');
  });
  test('missing urlPattern / invalid regex / missing capture group', async () => {
    assert.equal(keyFromPage('https://x.com/a', { shape: 'keyed-record' }).ok, false);
    assert.equal(keyFromPage('https://x.com/a', { shape: 'keyed-record', urlPattern: '(' }).ok, false);
    assert.equal(keyFromPage('https://x.com/a', { shape: 'keyed-record', urlPattern: '^/a$' }).ok, false);
  });
  test('invalid config (no exportName / bad shape)', async () => {
    assert.equal((await run(postSite({ exportName: undefined }), '/existing-post')).reason, 'invalid-config');
    assert.equal((await run(postSite({ shape: 'nonsense' }), '/existing-post')).reason, 'invalid-config');
  });
  test('data file missing on the branch', async () => {
    const r = await run(postSite(), '/existing-post', async () => null);
    assert.equal(r.reason, 'file-not-found');
  });
  test('export missing, or declared twice', async () => {
    assert.equal((await run(postSite({ exportName: 'nope' }), '/existing-post')).reason, 'no-insertion-marker');
    const dup = async () => ({ content: `${POST_FAQS}\nexport const postFaqs: Record<string, X[]> = {};\n` });
    const r = await run(postSite(), '/existing-post', dup);
    assert.equal(r.reason, 'no-insertion-marker');
    assert.match(r.error, /2 times/);
  });
  test('shape mismatch (config says keyed-record, export is an array)', async () => {
    const r = await run(postSite({ dataFile: 'src/data/page-faqs.ts', exportName: 'blogIndexFaqs' }), '/existing-post');
    assert.equal(r.reason, 'invalid-config');
  });
  test('record that is not plain data (spread entry) is refused, not edited', async () => {
    const spread = async () => ({ content: 'export const postFaqs = {\n  ...other,\n  "a": [],\n};\n' });
    assert.equal((await run(postSite(), '/a', spread)).reason, 'no-insertion-marker');
  });
  test('duplicate key is refused rather than picking one', async () => {
    const dupKey = async () => ({ content: 'export const postFaqs = {\n  "a": [],\n  "a": [],\n};\n' });
    assert.equal((await run(postSite(), '/a', dupKey)).reason, 'no-insertion-marker');
  });
  test('entry whose value is not an array literal is refused', async () => {
    const notArr = async () => ({ content: 'export const postFaqs = {\n  "a": buildFaqs(),\n};\n' });
    assert.equal((await run(postSite(), '/a', notArr)).reason, 'no-insertion-marker');
  });
  test('target that is not plain data (function call inside) cannot be proven, so is refused', async () => {
    const fn = async () => ({ content: 'export const postFaqs = {\n  "a": [],\n  "b": make(),\n};\n' });
    const r = await run(postSite(), '/a', fn);
    assert.equal(r.ok, false);
  });
  test('non-faq action types are not written by this adapter, a Q&A (qa-content) included: it is body text, not the FAQ box', async () => {
    for (const a of ['qa-content', 'meta-title']) {
      const r = await run(postSite(), '/existing-post', fetchFile, draft('/existing-post', items, a));
      assert.equal(r.reason, 'unsupported-action', a);
    }
  });
  test('malformed / empty items never reach the file', async () => {
    assert.equal((await run(postSite(), '/existing-post', fetchFile, draft('/existing-post', []))).reason, 'draft-not-ready');
    assert.equal((await run(postSite(), '/existing-post', fetchFile, draft('/existing-post', [{ question: 'q', answer: '' }]))).reason, 'draft-not-ready');
  });
  test('isDataReady / identifyTarget agree with computeChange', async () => {
    const site = postSite();
    const cfg = faqCfg();
    assert.equal(await isDataReady(site, 'https://a.com/existing-post', cfg, fetchFile, 'main'), true);
    assert.equal(await isDataReady(site, 'https://a.com/unknown-post', cfg, fetchFile, 'main'), false);
    assert.equal((await identifyTarget(site, 'https://a.com/unknown-post', cfg, fetchFile, 'main')).reason, 'target-not-identified');
  });
});

describe('ts-export-data primitives', () => {
  test('findNamedExport ignores the same text inside a comment (must start a line) and handles type annotations with [] and <>', () => {
    const r = findNamedExport(POST_FAQS, 'postFaqs');
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'object');
  });
  test('listTopLevelEntries sees top-level keys only, even with brackets in strings', () => {
    const exp = findNamedExport(POST_FAQS, 'postFaqs');
    const l = listTopLevelEntries(POST_FAQS, exp.start, exp.end);
    assert.deepEqual(l.entries.map((e) => e.key), ['existing-post', 'empty-post', 'single-quoted-post']);
  });
  test('parseDataLiteral refuses anything executable', () => {
    assert.equal(parseDataLiteral('{ a: foo() }').ok, false);
    assert.equal(parseDataLiteral('{ a: `x${y}` }').ok, false);
    assert.equal(parseDataLiteral('[1, "a", { b: null }]').ok, true);
  });
  test('verifyDataEdit rejects tampering outside the target, with other keys, and with hand-authored items', () => {
    const base = { exportName: 'postFaqs', shape: 'keyed-record', key: 'existing-post', newItems: items, priorManaged: [] };
    const good = POST_FAQS.replace('"empty-post": [],', '"empty-post": [],').replace(
      '      answer: "Hand written answer with [brackets], {braces} and a \\"quote\\".",\n    },\n',
      '      answer: "Hand written answer with [brackets], {braces} and a \\"quote\\".",\n    },\n    { question: "New question?", answer: "New answer." },\n');
    assert.equal(verifyDataEdit(POST_FAQS, good, base).ok, true);
    assert.equal(verifyDataEdit(POST_FAQS, good + '// extra\n', base).ok, false, 'trailing text changed');
    assert.equal(verifyDataEdit(POST_FAQS, good.replace('"Q one?"', '"Q two?"').replace("'Q one?'", "'Q two?'"), base).ok, false, 'other key changed');
    assert.equal(verifyDataEdit(POST_FAQS, good.replace('Hand written question?', 'Edited question?'), base).ok, false, 'hand-authored item changed');
    assert.equal(verifyDataEdit(POST_FAQS, good.replace('"empty-post": [],', '"empty-post": [],\n  "sneaky": [],'), base).ok, false, 'unexpected key');
    assert.equal(verifyDataEdit(POST_FAQS, POST_FAQS, base).ok, false, 'new item missing');
  });
});

// The real file, when the Admizz repo is checked out next to this one: the adapter must be able to write into it for real.
const REAL = join(homedir(), 'Projects', 'admizz-web-dev', 'src', 'data');
describe('ts-named-export-content — against the real admizz-web-dev data files', { skip: !existsSync(join(REAL, 'post-faqs.ts')) }, () => {
  const real = (n) => readFileSync(join(REAL, n), 'utf8');
  const realFetch = async (_s, p) => (p === 'src/data/post-faqs.ts' ? { content: real('post-faqs.ts') } : p === 'src/data/page-faqs.ts' ? { content: real('page-faqs.ts') } : null);

  test('post-faqs.ts: every existing slug can be written and verified', async () => {
    const slugs = [...real('post-faqs.ts').matchAll(/^  "([a-z0-9-]+)": \[/gm)].map((m) => m[1]);
    assert.ok(slugs.length > 10);
    for (const slug of slugs.slice(0, 40)) {
      const r = await computeChange(postSite(), draft(`/${slug}`, items), realFetch, 'main');
      assert.equal(r.ok, true, `${slug}: ${r.error}`);
    }
  });
  test('page-faqs.ts: blog index and category entries can be written and verified', async () => {
    const site = siteWith([
      ['^/category/([^/]+)/?$', faqCfg({ dataFile: 'src/data/page-faqs.ts', exportName: 'categoryFaqs', urlPattern: '^/category/([^/]+)$' })],
      ['^/blogs/?$', faqCfg({ dataFile: 'src/data/page-faqs.ts', exportName: 'blogIndexFaqs', shape: 'flat-array', urlPattern: '^/blogs$' })],
    ]);
    assert.equal((await computeChange(site, draft('/blogs', items), realFetch, 'main')).ok, true);
    assert.equal((await computeChange(site, draft('/category/visa-guides', items), realFetch, 'main')).ok, true);
  });
});
