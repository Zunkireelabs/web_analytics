import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { importsOf, keyedNames, resolveImportPath, classifyRecordShape, inferKeyEvidence, isSchemaOnlyStore, discoverTemplateDataStores, discoverPostBodyStore } from './template-data-stores.js';

// The shape of admizz-web-dev's src/app/[slug]/page.tsx (imports and indexing exactly as read from the live repo on 2026-11-24).
const TEMPLATE = `
import { urlFor } from "@/lib/image";
import PostSummary from "@/components/PostSummary";
import { postFaqs } from "@/data/post-faqs";
import { postSeoOverrides } from "@/data/post-seo-overrides";
import { postFacts as writtenPostFacts } from "@/data/post-facts";
import { postSummaries } from "@/data/post-summaries";
import { applyContentPatches } from "@/lib/content-patches";
export default async function BlogPostPage({ params }) {
  const ownFaq = postFaqs[post.slug.current];
  const seo = postSeoOverrides[post.slug.current];
  const facts = writtenPostFacts[post.slug.current];
  const all = Object.keys(postSummaries);
}`;
const KEYS = ['alpha-post', 'beta-post', 'gamma-post', 'delta-post', 'epsilon-post', 'zeta-post'];
const faqs = `export const postFaqs: Record<string, {question: string; answer: string}[]> = {\n${KEYS.map((k) => `  "${k}": [{ question: "Q ${k}?", answer: "A ${k}." }],`).join('\n')}\n};\n`;
const seo = `export const postSeoOverrides: Record<string, { title: string; description: string }> = {\n${KEYS.map((k) => `  "${k}": { title: "T ${k}", description: "D ${k}" },`).join('\n')}\n};\n`;
const facts = `export const postFacts: Record<string, { label: string; value: string }[]> = {\n${KEYS.map((k) => `  "${k}": [{ label: "L", value: "V" }],`).join('\n')}\n};\n`;
const summaries = `export const postSummaries: Record<string, string> = {\n${KEYS.map((k) => `  "${k}": "S",`).join('\n')}\n};\n`;
const FILES = {
  'src/app/[slug]/page.tsx': TEMPLATE, 'src/data/post-faqs.ts': faqs, 'src/data/post-seo-overrides.ts': seo, 'src/data/post-facts.ts': facts, 'src/data/post-summaries.ts': summaries,
  ...Object.fromEntries(KEYS.map((k) => [`src/content/blog/posts/${k}.json`, '{}'])),
};
const repoFiles = Object.keys(FILES);
const readFile = async (p) => FILES[p] ?? null;

describe('reading the template', () => {
  test('imports, including aliases and type imports', () => {
    const i = importsOf(TEMPLATE);
    assert.ok(i.some((x) => x.localName === 'postFaqs' && x.importPath === '@/data/post-faqs'));
    assert.ok(i.some((x) => x.localName === 'writtenPostFacts' && x.importedName === 'postFacts'));
  });
  test('only names the template INDEXES by a key are per-page stores; a name that is only iterated is not', () => {
    const names = importsOf(TEMPLATE).map((i) => i.localName);
    const keyed = keyedNames(TEMPLATE, names);
    assert.ok(keyed.includes('postFaqs') && keyed.includes('postSeoOverrides') && keyed.includes('writtenPostFacts'));
    assert.ok(!keyed.includes('postSummaries'), 'Object.keys(postSummaries) is not a per-page lookup');
    assert.ok(!keyed.includes('applyContentPatches'));
  });
  test('resolves "@/..." and relative imports to a file that exists, and never a package', () => {
    assert.equal(resolveImportPath('@/data/post-faqs', 'src/app/[slug]/page.tsx', repoFiles), 'src/data/post-faqs.ts');
    assert.equal(resolveImportPath('../../data/post-faqs', 'src/app/[slug]/page.tsx', repoFiles), 'src/data/post-faqs.ts');
    assert.equal(resolveImportPath('next/navigation', 'src/app/[slug]/page.tsx', repoFiles), null);
    assert.equal(resolveImportPath('@/data/missing', 'src/app/[slug]/page.tsx', repoFiles), null);
  });
});

describe('what a record holds', () => {
  test('FAQ items and SEO fields are recognised; anything else is not', () => {
    assert.equal(classifyRecordShape([[{ question: 'q', answer: 'a' }], [{ question: 'q2', answer: 'a2' }]]), 'faq');
    assert.equal(classifyRecordShape([{ title: 't', description: 'd' }, { title: 't2', description: 'd2' }]), 'meta-title');
    assert.equal(classifyRecordShape([[{ label: 'l', value: 'v' }], [{ label: 'l', value: 'v' }]]), null);
    assert.equal(classifyRecordShape([[{ question: 'q', answer: 'a' }]]), null, 'one entry is not a convention');
  });
});

describe('may a new key be created?', () => {
  test('only when every existing key names a real file at one common path', () => {
    assert.deepEqual(inferKeyEvidence(KEYS, repoFiles), { file: 'src/content/blog/posts/{key}.json' });
  });
  test('too few keys, or keys that do not line up with files: never', () => {
    assert.equal(inferKeyEvidence(KEYS.slice(0, 3), repoFiles), null);
    assert.equal(inferKeyEvidence(KEYS, repoFiles.filter((f) => !/alpha|beta|gamma/.test(f))), null);
    assert.equal(inferKeyEvidence(['a', 'b', 'c', 'd', 'e', 'f'], ['src/data/a.ts']), null);
  });
});

describe('discoverTemplateDataStores on the Admizz-shaped template', () => {
  test('finds the FAQ store and the SEO store, with the evidence to create new keys, and says why the rest were skipped', async () => {
    const r = await discoverTemplateDataStores({ templateFile: 'src/app/[slug]/page.tsx', templateSource: TEMPLATE, repoFiles, readFile });
    const byType = Object.fromEntries(r.stores.map((s) => [s.actionType, s.adapter]));
    assert.deepEqual(byType.faq, { id: 'ts-named-export-content', dataFile: 'src/data/post-faqs.ts', exportName: 'postFaqs', shape: 'keyed-record', allowCreateKey: true, keyEvidence: { file: 'src/content/blog/posts/{key}.json' } });
    assert.deepEqual(byType['meta-title'], { id: 'ts-keyed-record-fields', dataFile: 'src/data/post-seo-overrides.ts', exportName: 'postSeoOverrides', allowCreateKey: true, keyEvidence: { file: 'src/content/blog/posts/{key}.json' } });
    assert.equal(r.stores.length, 2);
    assert.ok(r.skipped.some((s) => s.name === 'postFacts' && /shape/.test(s.reason)));
  });
  test('without evidence for new keys it still finds the store but never allows creating one', async () => {
    const r = await discoverTemplateDataStores({ templateFile: 'src/app/[slug]/page.tsx', templateSource: TEMPLATE, repoFiles: repoFiles.filter((f) => !f.startsWith('src/content/')), readFile });
    for (const s of r.stores) { assert.equal(s.adapter.allowCreateKey, undefined); assert.equal(s.adapter.keyEvidence, undefined); }
    assert.equal(r.stores.length, 2);
  });
  test('a template that reads no per-page store gives nothing, so the page stays honestly blocked', async () => {
    const r = await discoverTemplateDataStores({ templateFile: 'src/app/x/page.tsx', templateSource: 'import Foo from "@/components/Foo";\nexport default function P() { return <Foo/>; }', repoFiles, readFile });
    assert.deepEqual(r.stores, []);
  });
});

describe('lessons from the real Admizz repo', () => {
  test('an image named after the key is not proof that a post exists; a content file is', () => {
    const files = [...KEYS.map((k) => `public/images/og/${k}.jpg`), ...KEYS.map((k) => `public/images/og/${k}-extra.jpg`), ...KEYS.slice(0, 6).map((k) => `src/content/blog/posts/${k}.json`)];
    assert.deepEqual(inferKeyEvidence(KEYS, files), { file: 'src/content/blog/posts/{key}.json' });
    assert.equal(inferKeyEvidence(KEYS, KEYS.map((k) => `public/images/og/${k}.jpg`)), null);
  });
  test('a data file that says it is schema only is never a place to write new visible content', () => {
    assert.equal(isSchemaOnlyStore('// FAQPage schema (schema only, no visible markup) for content posts\nexport const a = {};'), true);
    assert.equal(isSchemaOnlyStore('// Visible FAQ + FAQPage schema for content posts\n// [slug]/page.tsx renders these visibly AND emits the matching schema\nexport const a = {};'), false);
  });
  test('two stores for one action are both left out, never a guess', async () => {
    const extra = `// FAQ items\nexport const postFaqsB: Record<string, {question: string; answer: string}[]> = {\n${KEYS.map((k) => `  "${k}": [{ question: "Q?", answer: "A." }],`).join('\n')}\n};\n`;
    const files = { ...FILES, 'src/data/post-faqs-b.ts': extra };
    const tpl = TEMPLATE.replace('import { postSeoOverrides }', 'import { postFaqsB } from "@/data/post-faqs-b";\nimport { postSeoOverrides }').replace('const seo =', 'const b = postFaqsB[post.slug.current];\n  const seo =');
    const r = await discoverTemplateDataStores({ templateFile: 'src/app/[slug]/page.tsx', templateSource: tpl, repoFiles: Object.keys(files), readFile: async (p) => files[p] ?? null });
    assert.deepEqual(r.stores.map((x) => x.actionType), ['meta-title']);
    assert.equal(r.skipped.filter((x) => /more than one store/.test(x.reason)).length, 2);
  });
});

describe('where a post\'s BODY lives (Portable Text JSON)', () => {
  const blk = (t) => ({ _key: 'k', _type: 'block', children: [{ _key: 's', _type: 'span', marks: [], text: t }], markDefs: [], style: 'normal' });
  const tableRaw = '<div class="table-scroll"><table class="elig-table"><tr><td>x</td></tr></table></div>';
  const mk = (k, content) => JSON.stringify({ title: k, content }, null, 2);
  const KEYS6 = ['p-one', 'p-two', 'p-three', 'p-four', 'p-five', 'p-six'];
  const BODY_FILES = {
    'src/app/[slug]/page.tsx': 'import PortableTextRenderer from "@/components/PortableTextRenderer";\nimport { postFaqs } from "@/data/post-faqs";\nexport default function P() { const a = postFaqs[post.slug.current]; }',
    'src/components/PortableTextRenderer.tsx': 'import { PortableText } from "@portabletext/react";\nimport { RICH_POST_CSS } from "@/components/lib/blog-rich-styles";\nconst c = { block: { h2: 1, normal: 1 }, types: { image: 1, rawHtml: 1 } };',
    'src/components/lib/blog-rich-styles.ts': 'export const RICH_POST_CSS = `\n.table-scroll{width:100%}\n.elig-table{border-collapse:collapse}\n`;',
    'src/data/post-faqs.ts': faqs,
    ...Object.fromEntries(KEYS6.map((k, i) => [`src/content/blog/posts/${k}.json`, mk(k, i < 4 ? [blk('text'), { _key: 'r', _type: 'rawHtml', html: tableRaw }] : [blk('text')])])),
  };
  const run = (files, evidence = { file: 'src/content/blog/posts/{key}.json' }) => discoverPostBodyStore({ templateFile: 'src/app/[slug]/page.tsx', templateSource: files['src/app/[slug]/page.tsx'], repoFiles: Object.keys(files), readFile: async (p) => files[p] ?? null, keyEvidence: evidence });

  test('finds the post file, the renderer and the site\'s own table markup, all from evidence', async () => {
    const r = await run(BODY_FILES);
    assert.deepEqual(r.adapter, { id: 'portable-text-post-body', contentFile: 'src/content/blog/posts/{key}.json', rendererFile: 'src/components/PortableTextRenderer.tsx', bodyField: 'content', tableMarkup: { wrapperClass: 'table-scroll', tableClass: 'elig-table' }, tableCssFile: 'src/components/lib/blog-rich-styles.ts' });
    assert.equal(r.evidence.postFiles, 6);
  });
  test('no table markup in the site\'s posts means no tables are configured, never an invented one', async () => {
    const files = { ...BODY_FILES, ...Object.fromEntries(KEYS6.map((k) => [`src/content/blog/posts/${k}.json`, mk(k, [blk('text')])])) };
    assert.equal((await run(files)).adapter.tableMarkup, undefined);
  });
  test('posts that are mostly pasted-in raw-HTML pages are tolerated up to a quarter, not more', async () => {
    const rawOnly = (k) => mk(k, [{ _key: 'r', _type: 'rawHtml', html: '<p>page</p>' }]);
    const mostly = { ...BODY_FILES, ...Object.fromEntries(KEYS6.slice(0, 4).map((k) => [`src/content/blog/posts/${k}.json`, rawOnly(k)])) };
    assert.equal(await run(mostly), null);
  });
  test('nothing found without proof of where the posts are, without a renderer that draws Portable Text, or with too few posts', async () => {
    assert.equal(await run(BODY_FILES, null), null);
    assert.equal(await run(BODY_FILES, { file: 'public/images/{key}.jpg' }), null);
    const noRenderer = { ...BODY_FILES }; delete noRenderer['src/components/PortableTextRenderer.tsx'];
    assert.equal(await run(noRenderer), null);
    const few = Object.fromEntries(Object.entries(BODY_FILES).filter(([k]) => !/p-(four|five|six)/.test(k)));
    assert.equal(await run(few), null);
  });
});
