import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { urlKey, pathKey, topicTokens, tokensForEntry, topicMatch } from './normalize.js';
import { blogSignal, buildIndexEntries, detectBlogRoots, DRAFT_STATE_BY_STATUS } from './build.js';
import { checkTopicAgainstIndex, checkNewPath } from './check.js';
import { decideWrite, validateNoBlindOverwrite, noteFileRead, readShaFor, clearReadLedger, overwriteGuardMode } from './overwrite-guard.js';

describe('normalisation', () => {
  test('the same page is the same key whatever the spelling', () => {
    assert.equal(urlKey('https://www.Admizzeducation.com/Study-UK/?utm=1#x'), 'admizzeducation.com/study-uk');
    assert.equal(urlKey('https://admizzeducation.com/study-uk/'), 'admizzeducation.com/study-uk');
    assert.equal(urlKey('https://admizzeducation.com/'), 'admizzeducation.com');
    assert.equal(urlKey('not a url'), null);
    assert.equal(pathKey('https://x.com/Blog/Post/'), '/blog/post');
  });
  test('topic matching: same words match, a single shared word never does, a long entry that contains a short topic is not enough', () => {
    const t = (s) => topicTokens(s);
    assert.deepEqual(topicMatch(t('uk student visa success rate'), t('Visa success rate for UK students')).kind, 'near');
    assert.equal(topicMatch(t('student visa'), t('student visa')).kind, 'exact');
    assert.equal(topicMatch(t('ielts preparation'), t('london metropolitan university fees')).match, false);
    assert.equal(topicMatch(t('visa'), t('uk student visa success rate for nepali students')).match, false, 'one word is never a match');
    assert.equal(topicMatch(t('best courses abroad'), t('best courses for studying abroad in 2026')).match, true);
  });
  test('entry tokens come from the title AND the slug', () => {
    const tk = tokensForEntry({ title: '', url: 'https://x.com/scholarships-for-nepali-students-to-study-in-india' });
    assert.ok(tk.includes('scholarships') && tk.includes('students') && tk.includes('study'));
    assert.ok(!tk.includes('india'), 'geo words are not topic words (the shared tokenizer drops them)');
  });
});

describe('published blogs are found by signals, never by URL patterns alone (the Admizz case)', () => {
  // Admizz posts live at the site root; a /blog/ pattern finds none of them.
  const inventory = [
    { page: 'https://admizzeducation.com/uk-student-visa-success-rate-nepali-students-2027' },
    { page: 'https://admizzeducation.com/minimum-ielts-requirement-for-canadian-universities' },
    { page: 'https://admizzeducation.com/scholarships-for-nepali-students-to-study-in-india' },
    { page: 'https://admizzeducation.com/contact' },
    { page: 'https://admizzeducation.com/category/study-in-uk' },
  ];
  const snapshots = [
    { url: inventory[0].page, title: 'UK Student Visa Success Rate for Nepal (2027)', schema_types: ['BlogPosting', 'FAQPage'], open_graph: {} },
    { url: inventory[1].page, title: 'Minimum IELTS Score for Canadian Universities', schema_types: ['WebSite'], open_graph: { type: 'article' } },
    { url: inventory[3].page, title: 'Contact', schema_types: ['WebSite'], open_graph: {} },
  ];
  const classifications = [{ page: inventory[2].page, content_type: 'blog', confidence: 0.9 }, { page: inventory[4].page, content_type: 'category', confidence: 0.95 }];

  test('a URL-pattern approach would find zero; the signals find all three posts', () => {
    const byPattern = inventory.filter((r) => /\/(blog|articles|news|insights)\//.test(r.page));
    assert.equal(byPattern.length, 0);
    const entries = buildIndexEntries({ inventory, snapshots, classifications });
    const blogs = entries.filter((e) => e.kind === 'blog');
    assert.equal(blogs.length, 3);
    assert.deepEqual(blogs.map((b) => b.source).sort(), ['classifier', 'og-article', 'schema']);
    assert.equal(entries.find((e) => e.url.endsWith('/contact')).kind, 'page', 'a non-blog page is indexed as a page: its path is still protected');
  });
  test('a low-confidence classification is not trusted', () => {
    assert.equal(blogSignal({ url: 'https://x.com/a', classification: { content_type: 'blog', confidence: 0.4 } }), null);
  });
  test('a page under a detected listing root counts, so a stack that does use /blog/ still works', () => {
    assert.equal(blogSignal({ url: 'https://x.com/blog/some-post', listingRoots: ['/blog/'] }), 'listing-root');
    assert.equal(blogSignal({ url: 'https://x.com/blog/', listingRoots: ['/blog/'] }), null, 'the listing itself is not a post');
  });
  test('a snapshot of a page the inventory missed is still a page that exists; an error page is not', () => {
    const e = buildIndexEntries({ inventory: [], snapshots: [{ url: 'https://x.com/p', title: 'P', schema_types: ['Article'] }, { url: 'https://x.com/gone', status_code: 404 }] });
    assert.equal(e.length, 1); assert.equal(e[0].kind, 'blog');
  });
});

describe('blog roots come from the site\'s own structure, at any depth (the Zennly and Zunkiree cases)', () => {
  const slugs = (root, n) => Array.from({ length: n }, (_, i) => `${root}post-number-${i + 1}/`);
  test('a nested root (/businesses/blog/), a language root (/nl/blog/) and a plain one are all found; a thin folder is not', () => {
    const paths = [...slugs('/businesses/blog/', 9), ...slugs('/nl/blog/', 6), ...slugs('/blog/', 12), ...slugs('/services/', 20), ...slugs('/news/', 2)];
    assert.deepEqual(detectBlogRoots(paths), ['/blog/', '/businesses/blog/', '/nl/blog/']);
  });
  test('pagination pages are never posts and never make a root; a child listing is a root of its own, not a post of its parent', () => {
    const paths = [...slugs('/blog/', 8), ...Array.from({ length: 30 }, (_, i) => `/blog/page/${i + 1}/`), ...slugs('/blog/articles/', 7), '/blog/articles/'];
    const roots = detectBlogRoots(paths);
    assert.deepEqual(roots, ['/blog/', '/blog/articles/']);
    assert.equal(blogSignal({ url: 'https://s.com/blog/page/27/', listingRoots: roots }), null, 'pagination');
    assert.equal(blogSignal({ url: 'https://s.com/blog/articles/', listingRoots: roots }), null, 'a child listing');
    assert.equal(blogSignal({ url: 'https://s.com/blog/', listingRoots: roots }), null, 'the root itself');
    assert.equal(blogSignal({ url: 'https://s.com/blog/articles/a-real-post/', listingRoots: roots }), 'listing-root');
    assert.equal(blogSignal({ url: 'https://s.com/blog/page/27/', classification: { content_type: 'blog', confidence: 0.99 } }), null, 'even a confident classification does not make a pagination page a post');
  });
  test('Zennly\'s case: posts under /businesses/blog/ with NO snapshot and NO classification are still indexed as blogs, so their topics are never duplicated', () => {
    const paths = slugs('/businesses/blog/', 10).map((p) => `https://zennly.test${p}`);
    const roots = detectBlogRoots(paths.map((u) => new URL(u).pathname));
    const entries = buildIndexEntries({ inventory: [...paths.map((page) => ({ page })), { page: 'https://zennly.test/businesses/blog/how-to-start-a-spa-business-in-nepal' }], listingRoots: roots });
    assert.ok(entries.every((e) => e.kind === 'blog'));
    const hit = checkTopicAgainstIndex({ topic: 'how to start a spa business in nepal', entries });
    assert.equal(hit.ok, false); assert.match(hit.reason, /already published/);
  });
});

describe('a page is one page whatever host spelling it was stored with', () => {
  test('a bare path and a full URL for the same page are ONE entry; a bare path is indexed, not dropped (five Zunkiree posts on 2026-11-25)', () => {
    const e = buildIndexEntries({
      inventory: [{ page: '/blog/specialized-ai-applications-in-the-dental-industry-in-nepal' }, { page: 'https://s.com/blog/specialized-ai-applications-in-the-dental-industry-in-nepal/' }, { page: 'https://www.s.com/contact/' }],
      classifications: [{ page: '/blog/specialized-ai-applications-in-the-dental-industry-in-nepal', content_type: 'blog', confidence: 0.95 }],
    });
    assert.equal(e.length, 2); assert.equal(e.find((x) => /specialized/.test(x.url)).kind, 'blog');
    assert.equal(checkTopicAgainstIndex({ topic: 'specialized ai applications in the dental industry', entries: e }).ok, false);
  });
  test('a snapshot stored under a different spelling still supplies the title and schema for the same page', () => {
    const e = buildIndexEntries({ inventory: [{ page: '/guide/how-to-apply' }], snapshots: [{ url: 'https://s.com/guide/how-to-apply/', title: 'How to apply', schema_types: ['Article'] }] });
    assert.equal(e.length, 1); assert.equal(e[0].kind, 'blog'); assert.equal(e[0].title, 'How to apply');
  });
});

describe('drafts map to the five states', () => {
  const d = (over) => ({ id: 1, action_type: 'blog-outline', status: 'draft', content: { topic: 'visa success rate', title: 'Visa success rate' }, ...over });
  const state = (over) => buildIndexEntries({ drafts: [d(over)] })[0]?.state ?? null;
  test('every live status lands in the right state', () => {
    assert.equal(state({ status: 'submitted_for_approval' }), 'draft');
    assert.equal(state({ status: 'revision_requested' }), 'draft');
    assert.equal(state({ status: 'approved' }), 'approved');
    assert.equal(state({ status: 'branch_pushed' }), 'approved');
    assert.equal(state({ status: 'pr_opened', pr_state: 'open' }), 'in_pr');
    assert.equal(state({ status: 'merged_to_stage' }), 'in_pr');
    assert.equal(state({ status: 'pr_opened', pr_state: 'merged' }), 'merged');
    assert.equal(state({ status: 'implemented' }), 'merged');
  });
  test('an abandoned draft, or a PR closed without merging, blocks nothing; other action types are not content', () => {
    assert.equal(state({ status: 'abandoned' }), null);
    assert.equal(state({ status: 'pr_opened', pr_state: 'closed' }), null);
    assert.equal(state({ action_type: 'meta-title' }), null);
    assert.ok(Object.keys(DRAFT_STATE_BY_STATUS).every((s) => s !== 'abandoned'));
  });
});

describe('the duplicate check: one question for every generator and research path', () => {
  const entries = buildIndexEntries({
    inventory: [{ page: 'https://s.com/best-courses-for-studying-abroad-in-2026' }],
    snapshots: [{ url: 'https://s.com/best-courses-for-studying-abroad-in-2026', title: 'Best courses for studying abroad in 2026', schema_types: ['BlogPosting'] }],
    drafts: [
      { id: 11, action_type: 'blog-outline', status: 'submitted_for_approval', content: { topic: 'ielts preparation guide', title: 'IELTS preparation guide' } },
      { id: 12, action_type: 'blog-outline', status: 'approved', content: { topic: 'uk visa interview questions', title: 'UK visa interview questions' } },
      { id: 13, action_type: 'blog-outline', status: 'pr_opened', pr_state: 'open', pr_url: 'https://github.com/o/r/pull/70', content: { topic: 'student accommodation london', title: 'Student accommodation in London' } },
      { id: 14, action_type: 'blog-outline', status: 'implemented', content: { topic: 'scholarships for nepali students', title: 'Scholarships for Nepali students' } },
      { id: 15, action_type: 'blog-outline', status: 'abandoned', content: { topic: 'part time jobs for students uk', title: 'Part time jobs' } },
    ],
  });
  test('each of the five states is caught, and the reason names the state and where it is', () => {
    const cases = [
      ['best courses abroad 2026', 'is already published'],
      ['ielts preparation guide', 'draft awaiting approval'],
      ['uk visa interview questions', 'approved and being shipped'],
      ['student accommodation in london', 'open pull request'],
      ['scholarships for nepali students', 'already merged'],
    ];
    for (const [topic, phrase] of cases) { const r = checkTopicAgainstIndex({ topic, entries }); assert.equal(r.ok, false, topic); assert.match(r.reason, new RegExp(phrase), topic); }
    assert.match(checkTopicAgainstIndex({ topic: 'student accommodation in london', entries }).reason, /pull\/70/);
  });
  test('something in flight is reported before something live', () => {
    const e = buildIndexEntries({ inventory: [{ page: 'https://s.com/uk-visa-guide-nepal' }], snapshots: [{ url: 'https://s.com/uk-visa-guide-nepal', title: 'UK visa guide Nepal', schema_types: ['Article'] }], drafts: [{ id: 1, action_type: 'blog-outline', status: 'pr_opened', pr_state: 'open', content: { topic: 'uk visa guide nepal', title: 'UK visa guide Nepal' } }] });
    assert.equal(checkTopicAgainstIndex({ topic: 'uk visa guide nepal', entries: e }).matches[0].state, 'in_pr');
  });
  test('an abandoned draft does not block its topic; a new topic passes; a draft never matches itself', () => {
    assert.equal(checkTopicAgainstIndex({ topic: 'part time jobs for students uk', entries }).ok, true);
    assert.equal(checkTopicAgainstIndex({ topic: 'canada study permit processing time', entries }).ok, true);
    assert.equal(checkTopicAgainstIndex({ topic: 'ielts preparation guide', entries, ignoreDraftIds: [11] }).ok, true);
  });
  test('only blogs can duplicate a blog topic', () => {
    const e = buildIndexEntries({ inventory: [{ page: 'https://s.com/study-in-uk-from-nepal' }] });
    assert.equal(checkTopicAgainstIndex({ topic: 'study in uk from nepal', entries: e }).ok, true);
    assert.equal(checkTopicAgainstIndex({ topic: 'study in uk from nepal', entries: e, blogsOnly: false }).ok, false);
  });
});

describe('a new page is refused when its path already exists', () => {
  const entries = [
    { state: 'in_pr', draftId: 5, filePath: 'src/blog/visa-guide.md', url: null },
    { state: 'published', draftId: null, filePath: null, url: 'https://s.com/blog/live-post', kind: 'blog' },
  ];
  test('on the base branch, claimed by a draft, or live at that address', () => {
    assert.equal(checkNewPath({ path: 'src/blog/a.md', existingPaths: new Set(['src/blog/a.md']), entries }).ok, false);
    assert.match(checkNewPath({ path: 'src/blog/visa-guide.md', entries }).reason, /draft #5/);
    assert.match(checkNewPath({ path: 'src/blog/live-post.md', urlPath: '/blog/live-post/', entries }).reason, /already live/);
    assert.equal(checkNewPath({ path: 'src/blog/fresh.md', urlPath: '/blog/fresh/', entries }).ok, true);
    assert.equal(checkNewPath({ path: 'src/blog/visa-guide.md', entries, ignoreDraftIds: [5] }).ok, true, 'a draft does not collide with itself');
  });
});

describe('overwrite protection: decideWrite', () => {
  test('a free path is written; an unchanged edit is written', () => {
    assert.equal(decideWrite({ path: 'a', exists: false, netNew: true }).action, 'write');
    assert.equal(decideWrite({ path: 'a', exists: true, readSha: 's1', currentSha: 's1' }).action, 'write');
  });
  test('a file that changed after the read is REBUILT, never written over', () => {
    const d = decideWrite({ path: 'a', exists: true, readSha: 'aaaaaaaa1', currentSha: 'bbbbbbbb2' });
    assert.deepEqual([d.ok, d.action], [false, 'rebuild']); assert.match(d.reason, /changed on the base branch after this item read it/);
  });
  test('a path another in-flight item holds is BLOCKED; a new page onto an existing file is BLOCKED', () => {
    assert.equal(decideWrite({ path: 'a', exists: true, readSha: 's', currentSha: 's', claimedBy: { draftId: 9, state: 'in_pr' } }).action, 'block');
    assert.equal(decideWrite({ path: 'a', exists: true, netNew: true }).action, 'block');
  });
  test('an existing file never read by this item is reported as unverified, never as safe', () => {
    const d = decideWrite({ path: 'a', exists: true, readSha: null, currentSha: 's' });
    assert.deepEqual([d.ok, d.action], [true, 'unverified']);
  });
});

describe('overwrite protection: the gate', () => {
  const site = { id: 1 }; const REF = 'main';
  const shas = new Map();
  const getSha = async (_s, p) => (shas.has(p) ? shas.get(p) : null);
  const run = (draft, files, over = {}) => validateNoBlindOverwrite(site, draft, files, { ref: REF, getSha, entries: [], ...over });
  const reset = () => { shas.clear(); clearReadLedger(); };

  test('mode: default is log; unknown values fall back to log', () => {
    assert.equal(overwriteGuardMode({}), 'log'); assert.equal(overwriteGuardMode({ OVERWRITE_GUARD: 'enforce' }), 'enforce'); assert.equal(overwriteGuardMode({ OVERWRITE_GUARD: 'x' }), 'log');
  });
  test('the read ledger records the sha a file was read at', () => {
    reset(); noteFileRead(1, REF, 'src/a.md', 'abc123'); assert.equal(readShaFor(1, REF, 'src/a.md'), 'abc123'); assert.equal(readShaFor(2, REF, 'src/a.md'), null);
  });
  test('enforce: an unchanged file is written, a changed one is refused as retryable, nothing is written either way', async () => {
    reset(); shas.set('src/a.md', 's1'); noteFileRead(1, REF, 'src/a.md', 's1');
    assert.equal((await run({ id: 1, action_type: 'faq' }, [{ path: 'src/a.md' }], { mode: 'enforce' })).ok, true);
    shas.set('src/a.md', 's2'); // someone merged to main in between
    const r = await run({ id: 1, action_type: 'faq' }, [{ path: 'src/a.md' }], { mode: 'enforce' });
    assert.deepEqual([r.ok, r.reason, r.retryable], [false, 'file-changed-since-read', true]); assert.match(r.error, /Nothing was written/);
  });
  test('enforce: a new blog onto an existing path, and a path held by another draft, are refused (not retryable)', async () => {
    reset(); shas.set('src/blog/x.md', 'old');
    const a = await run({ id: 2, action_type: 'blog-outline' }, [{ path: 'src/blog/x.md' }], { mode: 'enforce' });
    assert.deepEqual([a.ok, a.reason, a.retryable], [false, 'overwrite-blocked', false]);
    const b = await run({ id: 3, action_type: 'faq' }, [{ path: 'src/b.md' }], { mode: 'enforce', entries: [{ filePath: 'src/b.md', draftId: 8, state: 'in_pr' }] });
    assert.equal(b.ok, false); assert.match(b.error, /draft #8/);
    shas.set('src/b.md', 's');
    assert.equal((await run({ id: 8, action_type: 'faq' }, [{ path: 'src/b.md' }], { mode: 'enforce', entries: [{ filePath: 'src/b.md', draftId: 8, state: 'in_pr' }] })).notes[0].action, 'unverified', 'a draft is never blocked by its own claim');
  });
  test('a file read from the BATCH branch is compared at the batch branch, so an edit built on an earlier item\'s work is judged against that, not against main', async () => {
    reset(); const BATCH = 'action-center/batch-1-2026-11-25';
    const refSha = new Map([[`${BATCH}|src/c.md`, 'b1'], [`${REF}|src/c.md`, 'm1']]);
    const gs = async (_s, p, r) => refSha.get(`${r}|${p}`) ?? null;
    noteFileRead(1, BATCH, 'src/c.md', 'b1');
    const same = await validateNoBlindOverwrite(site, { id: 4, action_type: 'faq' }, [{ path: 'src/c.md' }], { ref: REF, batchRef: BATCH, getSha: gs, mode: 'enforce' });
    assert.equal(same.ok, true, 'unchanged at the batch ref, even though main has a different sha');
    refSha.set(`${BATCH}|src/c.md`, 'b2'); // another item changed the file on the batch branch after this item read it
    const changed = await validateNoBlindOverwrite(site, { id: 4, action_type: 'faq' }, [{ path: 'src/c.md' }], { ref: REF, batchRef: BATCH, getSha: gs, mode: 'enforce' });
    assert.deepEqual([changed.ok, changed.reason], [false, 'file-changed-since-read']);
  });
  test('log mode decides and warns but never refuses; off does nothing', async () => {
    reset(); shas.set('src/a.md', 's2'); noteFileRead(1, REF, 'src/a.md', 's1');
    const warn = console.warn; const lines = []; console.warn = (m) => lines.push(m);
    try {
      const r = await run({ id: 1, action_type: 'faq' }, [{ path: 'src/a.md' }], { mode: 'log' });
      assert.equal(r.ok, true); assert.equal(r.wouldRefuse.length, 1); assert.match(lines[0], /would refuse/);
    } finally { console.warn = warn; }
    assert.deepEqual(await run({ id: 1 }, [{ path: 'src/a.md' }], { mode: 'off' }), { ok: true, notes: [] });
  });
  test('a file the guard cannot read is never a silent pass in enforce mode', async () => {
    reset();
    const r = await validateNoBlindOverwrite(site, { id: 1, action_type: 'faq' }, [{ path: 'a' }], { ref: REF, getSha: async () => { throw new Error('rate limited'); }, mode: 'enforce' });
    assert.equal(r.ok, false); assert.match(r.error, /rate limited/);
    assert.equal((await validateNoBlindOverwrite(site, { id: 1 }, [{ path: 'a' }], { ref: REF, getSha: async () => { throw new Error('x'); }, mode: 'log' })).ok, true);
  });
});
