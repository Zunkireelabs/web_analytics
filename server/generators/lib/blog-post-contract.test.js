import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkBlogPostContract, normalize, describeBlogContractIssues } from './blog-post-contract.js';

// Two things under test. First, the contract is the TENANT'S, never a built-in one: a tenant that configured nothing
// must not have content refused for failing a rule they never set, and two tenants must be able to disagree. Second,
// the structural rules that are wrong for everyone (layout markup in a prose body, two H1s, a table with no header)
// apply with no configuration at all.

const target = {
  frontMatter: {
    required: ['title', 'seoTitle', 'seoDescription', 'date', 'category', 'tags', 'featuredImage', 'featuredImageAlt', 'translationKey'],
    lengths: { seoTitle: [30, 60], seoDescription: [110, 160] },
    allowed: { category: ['Guides', 'News'] },
    imagePrefix: 'src/assets/images/blog/',
  },
  body: { directAnswerWords: [40, 60], requireFaq: true, requireSources: true },
};

const answer = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const goodPost = (over = {}) => ({
  frontMatter: {
    title: 'Teeth whitening costs explained',
    seoTitle: 'Teeth Whitening Cost: What You Actually Pay',
    seoDescription: 'A clear breakdown of what teeth whitening costs, what changes the price, and how to compare quotes without guessing at the final bill today.',
    date: '2026-11-05', category: 'Guides', tags: ['dental'],
    featuredImage: 'src/assets/images/blog/whitening.jpg', featuredImageAlt: 'A dental chair',
    translationKey: 'whitening-cost', ...over.frontMatter,
  },
  body: over.body ?? `${answer(50)}\n\n## How pricing works\n\nSome prose.\n\n## FAQ\n\n### Is it safe?\n\nYes.\n\n## Sources\n\n- [A source](https://example.com)\n`,
});

describe('the contract belongs to the tenant', () => {
  test('a tenant that configured nothing gets only the universal structural checks', () => {
    const out = checkBlogPostContract({ frontMatter: {}, body: 'Just some prose.' }, {});
    assert.equal(out.ok, true, JSON.stringify(out.issues));
  });

  test('no target at all is also fine', () => {
    assert.equal(checkBlogPostContract({ frontMatter: {}, body: 'Prose.' }).ok, true);
  });

  test('a fully conforming post passes its tenant\'s contract', () => {
    const out = checkBlogPostContract(goodPost(), target);
    assert.equal(out.ok, true, JSON.stringify(out.issues));
  });

  test('each missing required field is reported by name', () => {
    const post = goodPost();
    delete post.frontMatter.translationKey;
    post.frontMatter.tags = [];
    const out = checkBlogPostContract(post, target);
    const fields = out.issues.filter((i) => i.code === 'missing-front-matter').map((i) => i.field);
    assert.deepEqual(fields.sort(), ['tags', 'translationKey']);
  });

  test('two tenants can require different things from the same post', () => {
    const post = goodPost();
    const strict = { frontMatter: { required: ['readTime'] } };
    assert.equal(checkBlogPostContract(post, strict).ok, false);
    assert.equal(checkBlogPostContract(post, { frontMatter: { required: ['title'] } }).ok, true);
  });

  test('length bounds are the tenant\'s numbers', () => {
    const short = checkBlogPostContract(goodPost({ frontMatter: { seoTitle: 'Too short' } }), target);
    assert.equal(short.issues.some((i) => i.code === 'front-matter-length' && i.field === 'seoTitle'), true);
    // The same post passes for a tenant with wider bounds.
    const relaxed = { frontMatter: { lengths: { seoTitle: [5, 60] } } };
    assert.equal(checkBlogPostContract(goodPost({ frontMatter: { seoTitle: 'Too short' } }), relaxed).ok, true);
  });

  test('a length rule is not re-reported for a field already flagged as missing', () => {
    const post = goodPost({ frontMatter: { seoTitle: '' } });
    const out = checkBlogPostContract(post, target);
    assert.equal(out.issues.filter((i) => i.field === 'seoTitle').length, 1);
  });

  test('a closed vocabulary is enforced only where the tenant set one', () => {
    const out = checkBlogPostContract(goodPost({ frontMatter: { category: 'Insights' } }), target);
    assert.equal(out.issues.some((i) => i.code === 'front-matter-not-allowed'), true);
    assert.match(out.issues.find((i) => i.code === 'front-matter-not-allowed').detail, /Guides, News/);
  });

  test('images must live where the tenant keeps them, and remote images are left alone', () => {
    assert.equal(
      checkBlogPostContract(goodPost({ frontMatter: { featuredImage: 'random/path.jpg' } }), target)
        .issues.some((i) => i.code === 'image-wrong-location'), true
    );
    assert.equal(
      checkBlogPostContract(goodPost({ frontMatter: { featuredImage: 'https://cdn.example.com/a.jpg' } }), target)
        .issues.some((i) => i.code === 'image-wrong-location'), false
    );
  });

  test('an image without alt text is a defect for every tenant', () => {
    const out = checkBlogPostContract(goodPost({ frontMatter: { featuredImageAlt: '' } }), { });
    assert.equal(out.issues.some((i) => i.code === 'missing-image-alt'), true);
  });
});

describe('body structure is wrong for everyone', () => {
  test('layout markup in a prose body is refused with no configuration', () => {
    for (const [body, code] of [
      ['<div class="card">text</div>', 'wrapper-div'],
      ['<section>text</section>', 'wrapper-section'],
      ['<p class="big">text</p>', 'inline-class'],
      ['<p style="color:red">text</p>', 'inline-style'],
    ]) {
      const out = checkBlogPostContract({ frontMatter: {}, body }, {});
      assert.equal(out.issues.some((i) => i.code === code), true, code);
    }
  });

  test('more than one H1 is refused, in markdown or HTML', () => {
    assert.equal(checkBlogPostContract({ body: '# One\n\n# Two' }, {}).issues.some((i) => i.code === 'multiple-h1'), true);
    assert.equal(checkBlogPostContract({ body: '# One\n\nprose' }, {}).ok, true);
  });

  test('a table needs a header row', () => {
    const noHeader = '| a | b |\n| 1 | 2 |\n';
    const withHeader = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    assert.equal(checkBlogPostContract({ body: noHeader }, {}).issues.some((i) => i.code === 'table-without-header'), true);
    assert.equal(checkBlogPostContract({ body: withHeader }, {}).ok, true);
    assert.equal(checkBlogPostContract({ body: '<table><tr><td>1</td></tr></table>' }, {}).issues.some((i) => i.code === 'table-without-header'), true);
  });

  test('an empty body is an issue, not a pass', () => {
    assert.equal(checkBlogPostContract({ frontMatter: {}, body: '  ' }, {}).issues[0].code, 'empty-body');
  });
});

describe('the opening answer and the required sections', () => {
  test('the opening answer is measured before the first heading', () => {
    const short = checkBlogPostContract(goodPost({ body: `${answer(10)}\n\n## FAQ\n\n## Sources\n` }), target);
    assert.equal(short.issues.some((i) => i.code === 'direct-answer-length'), true);
    const long = checkBlogPostContract(goodPost({ body: `${answer(200)}\n\n## FAQ\n\n## Sources\n` }), target);
    assert.equal(long.issues.some((i) => i.code === 'direct-answer-length'), true);
  });

  test('a post that opens with a heading has no opening answer at all', () => {
    const out = checkBlogPostContract(goodPost({ body: '## Straight to a heading\n\nprose\n\n## FAQ\n\n## Sources\n' }), target);
    assert.equal(out.issues.some((i) => i.code === 'missing-direct-answer'), true);
  });

  test('FAQ and Sources are required only where the tenant asks', () => {
    const body = `${answer(50)}\n\n## How it works\n\nprose\n`;
    const strict = checkBlogPostContract(goodPost({ body }), target);
    assert.deepEqual(strict.issues.map((i) => i.code).sort(), ['missing-faq', 'missing-sources']);
    assert.equal(checkBlogPostContract(goodPost({ body }), { body: {} }).ok, true);
  });

  test('the section headings are matched by meaning, not an exact string', () => {
    for (const faq of ['## FAQ', '## Frequently asked questions', '## Common questions']) {
      for (const sources of ['## Sources', '## References', '## Further reading']) {
        const body = `${answer(50)}\n\n${faq}\n\nq\n\n${sources}\n\n- link\n`;
        assert.equal(checkBlogPostContract(goodPost({ body }), target).ok, true, `${faq} / ${sources}`);
      }
    }
  });
});

describe('raw markdown input', () => {
  test('front matter is parsed from a raw file', () => {
    const raw = `---\ntitle: A post\ntags:\n  - one\n  - two\ncategory: Guides\n---\n\n${answer(50)}\n\n## FAQ\n\n## Sources\n`;
    const { frontMatter, body } = normalize(raw);
    assert.equal(frontMatter.title, 'A post');
    assert.deepEqual(frontMatter.tags, ['one', 'two']);
    assert.match(body, /## FAQ/);
  });

  test('an inline list and quoted values are both understood', () => {
    const { frontMatter } = normalize('---\ntags: [a, b]\ntitle: "Quoted title"\n---\nbody');
    assert.deepEqual(frontMatter.tags, ['a', 'b']);
    assert.equal(frontMatter.title, 'Quoted title');
  });

  test('a file with no front matter is all body, not an error', () => {
    const { frontMatter, body } = normalize('# Just a post\n\nprose');
    assert.deepEqual(frontMatter, {});
    assert.match(body, /Just a post/);
  });

  test('a raw file is checked exactly like a parsed one', () => {
    const raw = `---\ntitle: T\n---\n<div>filler</div>`;
    const out = checkBlogPostContract(raw, { frontMatter: { required: ['seoTitle'] } });
    assert.deepEqual(out.issues.map((i) => i.code).sort(), ['missing-front-matter', 'wrapper-div']);
  });

  test('nothing throws on junk input', () => {
    for (const junk of [null, undefined, 42, [], { frontMatter: null, body: null }]) {
      assert.doesNotThrow(() => checkBlogPostContract(junk, target));
    }
  });
});

describe('reporting', () => {
  test('issues read as plain sentences for a draft failure message', () => {
    const out = checkBlogPostContract({ frontMatter: {}, body: '<div>x</div>' }, { frontMatter: { required: ['title'] } });
    const text = describeBlogContractIssues(out.issues);
    assert.match(text, /title: Front matter is missing required field/);
    assert.match(text, /body: A blog post body is plain markdown/);
  });

  test('no issues describes as an empty string', () => {
    assert.equal(describeBlogContractIssues([]), '');
    assert.equal(describeBlogContractIssues(null), '');
  });
});
