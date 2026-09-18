import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let due;
let recorded;
let rescheduled = [];
let fetchResult;
let openRec;
let closedIds;
let watchlistReopened;
let reopenedIds = [];
let attempts = [];
let deployments = new Map();
let deployMarks = [];
let repoFiles = {};
let site = { id: 1, website_domain: 'x.com', repo_owner: 'acme', repo_name: 'site' };
let headerResult;
let textResult;
let tagsNowResult = [];

// Spread the real module so constants and helpers fix-verification.js imports
// (VERIFICATION_METHOD, rescheduleVerification, …) stay available — only the
// two persistence calls these tests assert on are stubbed.
const realFixVerifications = await import(resolve('../../store/fix-verifications.js'));
mock.module(resolve('../../store/fix-verifications.js'), {
  namedExports: {
    ...realFixVerifications,
    getDueVerifications: async () => due,
    recordVerificationOutcome: async (id, outcome, evidence) => { recorded.push({ id, outcome, evidence }); return null; },
    rescheduleVerification: async (id, opts) => { rescheduled.push({ id, ...opts }); return null; },
  },
});
mock.module(resolve('../../store/watchlist.js'), {
  namedExports: {
    getWatchlistItemById: async (siteId, id) => ({ id, status: 'completed' }),
    setWatchlistStatus: async (siteId, id, status, note) => { watchlistReopened.push({ siteId, id, status, note }); },
  },
});
const realPageContent = await import(resolve('./page-content.js'));
mock.module(resolve('./page-content.js'), {
  namedExports: {
    ...realPageContent,
    analyzePageUrl: async () => ({ ok: true, analysis: {} }),
    recommendationsFor: () => tagsNowResult,
    contentGapsFor: () => [],
    fetchHtml: async () => fetchResult,
    fetchResponseHeaders: async () => headerResult,
    fetchTextIfExists: async () => textResult,
  },
});
const realAgentMemory = await import(resolve('../../agent-memory.js'));
mock.module(resolve('../../agent-memory.js'), {
  namedExports: { ...realAgentMemory, recordFixOutcome: async () => {} },
});
const realRecommendations = await import(resolve('../../store/recommendations.js'));
mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    ...realRecommendations,
    findOpenRecommendation: async () => openRec,
    closeRecommendation: async (id) => { closedIds.push(id); },
    reopenRecommendation: async (id) => { reopenedIds.push(id); },
  },
});
mock.module(resolve('../../store/recommendation-attempts.js'), {
  namedExports: { recordAttempt: async (siteId, attempt) => { attempts.push({ siteId, ...attempt }); } },
});
const realRead = await import(resolve('../../store/read.js'));
mock.module(resolve('../../store/read.js'), {
  namedExports: { ...realRead, getSiteById: async () => site },
});
mock.module(resolve('../../store/deployments.js'), {
  namedExports: {
    getDeploymentById: async (id) => deployments.get(id) || null,
    markDeploymentDetected: async (id, evidence) => { deployMarks.push({ id, status: 'deployed', evidence }); return null; },
    markDeploymentNotDetected: async (id, evidence) => { deployMarks.push({ id, status: 'not-detected', evidence }); return null; },
    deploymentGraceElapsed: (d) => !!d?.graceElapsed,
    DEPLOY_GRACE_HOURS: 6,
  },
});
const realGithub = await import(resolve('../../github/client.js'));
mock.module(resolve('../../github/client.js'), {
  namedExports: { ...realGithub, getFileContent: async (s, path) => repoFiles[path] ?? null },
});

const { runDueVerifications, checkContentAgainstExpectation } = await import(resolve('./fix-verification.js'));
const { VERIFICATION_METHOD } = realFixVerifications;

function verificationRow(overrides = {}) {
  return {
    id: 1, site_id: 1, generator_id: 'analytics-install', page_url: 'https://x.com/',
    query: 'G-ABC123', finding_id: 'trust-compliance:analytics:missing', watchlist_item_id: null,
    memory_ref_id: null, source: 'trust-compliance',
    ...overrides,
  };
}

beforeEach(() => {
  due = [];
  recorded = [];
  fetchResult = { ok: true, html: '' };
  openRec = null;
  closedIds = [];
  watchlistReopened = [];
  reopenedIds = [];
  attempts = [];
  rescheduled = [];
  deployments = new Map();
  deployMarks = [];
  repoFiles = {};
  headerResult = { ok: true, headers: new Headers() };
  textResult = { ok: false };
  tagsNowResult = [];
  site = { id: 1, website_domain: 'x.com', repo_owner: 'acme', repo_name: 'site' };
});

describe('runDueVerifications — analytics-install tracking-ID verification', () => {
  test('the tracking ID is live on the page: verified-fixed, and the originating recommendation is closed', async () => {
    due = [verificationRow()];
    fetchResult = { ok: true, html: '<html><script>gtag("config","G-ABC123")</script></html>' };
    openRec = { id: 42 };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed');
    assert.equal(recorded[0].outcome, 'verified-fixed');
    assert.deepEqual(closedIds, [42], 'the real recommendation row is closed, not a made-up id');
  });

  test('the tracking ID is NOT live on the page: still-present, and nothing is closed', async () => {
    due = [verificationRow()];
    fetchResult = { ok: true, html: '<html>no tracking here</html>' };
    openRec = { id: 42 };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'still-present');
    assert.deepEqual(closedIds, [], 'a merged PR with no live tracking ID must never close the recommendation');
  });

  test('an unreachable page verifies neither way and closes nothing', async () => {
    due = [verificationRow()];
    fetchResult = { ok: false, error: 'timeout' };
    openRec = { id: 42 };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'unreachable');
    assert.deepEqual(closedIds, []);
  });

  test('verified-fixed but the recommendation was already closed some other way: no error, nothing double-closed', async () => {
    due = [verificationRow()];
    fetchResult = { ok: true, html: 'G-ABC123' };
    openRec = null; // findOpenRecommendation found nothing — already closed

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed');
    assert.deepEqual(closedIds, []);
  });

  test('a still-present outcome with a watchlist item reopens it', async () => {
    due = [verificationRow({ watchlist_item_id: 7 })];
    fetchResult = { ok: true, html: 'nothing tracked here' };

    await runDueVerifications();

    assert.equal(watchlistReopened.length, 1);
    assert.equal(watchlistReopened[0].id, 7);
    assert.equal(watchlistReopened[0].status, 'new');
  });

  test('non-analytics-install rows still take the ordinary tag-recheck path, unaffected', async () => {
    due = [{
      id: 2, site_id: 1, generator_id: 'meta-title', page_url: 'https://x.com/p',
      query: 'some query', finding_id: 'f1', watchlist_item_id: null, memory_ref_id: null, source: 'opportunity',
    }];

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed', 'empty tagsNow means nothing is still flagged');
    assert.deepEqual(closedIds, [], 'the recommendations.js close path is analytics-install-only');
  });
});

// --------------------------------------------------------------------------
// Wider verification coverage (migration 153)
// --------------------------------------------------------------------------

function methodRow(overrides = {}) {
  return {
    id: 10, site_id: 1, generator_id: 'expand-content', page_url: 'https://x.com/p',
    query: null, finding_id: 'f-10', watchlist_item_id: null, memory_ref_id: null,
    source: 'auto-remediation', method: 'page-content', expected: { needle: 'a distinctive sentence' },
    deployment_id: null,
    ...overrides,
  };
}

describe('verification methods beyond the original nine', () => {
  test('page-content: shipped copy present in visible text verifies the fix', async () => {
    due = [methodRow()];
    fetchResult = { ok: true, html: '<p>Here is a distinctive sentence on the page.</p>' };
    openRec = { id: 7 };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed');
    assert.deepEqual(closedIds, [7]);
  });

  test('page-content: copy that only exists inside markup (JSON-LD, meta) still counts as present', async () => {
    due = [methodRow({ expected: { needle: 'AI companies in Nepal' } })];
    fetchResult = { ok: true, html: '<script type="application/ld+json">{"headline":"AI companies in Nepal"}</script>' };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed', 'tag-stripping alone would have wrongly called this missing');
    assert.equal(recorded[0].evidence.foundIn, 'markup');
  });

  test('site-asset: llms.txt served but structurally invalid is NOT verified', async () => {
    due = [methodRow({ generator_id: 'llms-txt', method: 'site-asset', page_url: 'https://x.com/llms.txt', expected: { structure: 'llms-txt' } })];
    textResult = { ok: true, text: 'just some plain text, no heading or links' };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'still-present');
    assert.equal(recorded[0].evidence.validStructure, false);
  });

  test('response-header: a header that is not actually being sent fails verification', async () => {
    due = [methodRow({ generator_id: 'security-headers', method: 'response-header', expected: { headers: ['content-security-policy'] } })];
    headerResult = { ok: true, headers: new Headers({ 'x-frame-options': 'DENY' }) };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'still-present');
    assert.deepEqual(recorded[0].evidence.missing, ['content-security-policy']);
  });

  test('page-pattern: html-lang present verifies, absent does not', async () => {
    due = [methodRow({ generator_id: 'html-lang', method: 'page-pattern', expected: { check: 'html-lang-present' } })];
    fetchResult = { ok: true, html: '<html lang="en"><body>hi</body></html>' };
    assert.equal((await runDueVerifications())[0].outcome, 'verified-fixed');

    recorded = [];
    due = [methodRow({ generator_id: 'html-lang', method: 'page-pattern', expected: { check: 'html-lang-present' } })];
    fetchResult = { ok: true, html: '<html><body>hi</body></html>' };
    assert.equal((await runDueVerifications())[0].outcome, 'still-present');
  });

  test('page-absence: a broken link that is really gone verifies', async () => {
    due = [methodRow({ generator_id: 'broken-link-fix', method: 'page-absence', expected: { absent: '/dead-link' } })];
    fetchResult = { ok: true, html: '<a href="/live-link">ok</a>' };

    assert.equal((await runDueVerifications())[0].outcome, 'verified-fixed');
  });

  test('repo-file: file missing the shipped content fails, and never claims the page is live', async () => {
    due = [methodRow({ generator_id: 'blog-image', method: 'repo-file', page_url: null, expected: { files: ['src/blog/x.md'], needle: 'robot in tokyo' } })];
    repoFiles['src/blog/x.md'] = { content: 'a totally different body' };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'still-present');
    assert.equal(recorded[0].evidence.reason, 'file exists but no longer contains the shipped content');
  });

  test('an unknown/absent method is unreachable, never silently verified', async () => {
    due = [methodRow({ method: 'something-nobody-implemented' })];

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'unreachable');
    assert.notEqual(results[0].outcome, 'verified-fixed');
  });
});

describe('deployment awareness: merged-but-not-deployed is not a failed fix', () => {
  test('change absent while the deploy is still inside its grace window: rescheduled, not failed', async () => {
    deployments.set(5, { id: 5, status: 'pending', commit_sha: 'abc123', graceElapsed: false });
    due = [methodRow({ deployment_id: 5 })];
    fetchResult = { ok: true, html: '<p>nothing shipped here yet</p>' };
    openRec = { id: 7 };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'awaiting-deployment');
    assert.equal(rescheduled.length, 1, 'it comes back around rather than being written off');
    assert.deepEqual(reopenedIds, [], 'a fix that simply has not deployed yet must not be reopened as broken');
    assert.deepEqual(deployMarks, [], 'and the deployment is not yet judged either way');
  });

  test('change absent after the grace window: deployment marked not-detected and the finding is reconciled back', async () => {
    deployments.set(5, { id: 5, status: 'pending', commit_sha: 'abc123', graceElapsed: true });
    due = [methodRow({ deployment_id: 5 })];
    fetchResult = { ok: true, html: '<p>still nothing</p>' };
    openRec = { id: 7 };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'still-present');
    assert.equal(deployMarks[0].status, 'not-detected');
    assert.deepEqual(reopenedIds, [7], 'the finding goes back on the board rather than staying marked done');
    assert.equal(attempts[0].outcome, 'failed');
    assert.match(attempts[0].reason, /^verification-found-change-not-live/);
    assert.equal(attempts[0].retryPolicy, 'needs_human', 'a merge that never deployed is not the item\'s fault, so it must not be retried as one');
  });

  test('change present on the live site is what promotes the deployment to deployed', async () => {
    deployments.set(5, { id: 5, status: 'pending', commit_sha: 'abc123', graceElapsed: false });
    due = [methodRow({ deployment_id: 5 })];
    fetchResult = { ok: true, html: '<p>a distinctive sentence indeed</p>' };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed');
    assert.equal(deployMarks[0].status, 'deployed', 'the live site reflecting the change IS the deploy signal');
  });

  test('repo-file evidence proves the merge landed but never marks a deployment live', async () => {
    deployments.set(5, { id: 5, status: 'pending', commit_sha: 'abc123', graceElapsed: false });
    due = [methodRow({ generator_id: 'blog-image', method: 'repo-file', page_url: null, deployment_id: 5, expected: { files: ['a.md'], needle: 'shipped words' } })];
    repoFiles['a.md'] = { content: 'contains the shipped words here' };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed');
    assert.deepEqual(deployMarks, [], 'the repo is not evidence of what is live');
  });
});

describe('reconciliation on the tag-recheck path', () => {
  test('an issue still present after deployment returns the finding to the board with a real reason', async () => {
    due = [{
      id: 3, site_id: 1, generator_id: 'meta-title', page_url: 'https://x.com/p', query: 'q',
      finding_id: 'f3', watchlist_item_id: null, memory_ref_id: null, source: 'opportunity',
      method: null, expected: null, deployment_id: null,
    }];
    openRec = { id: 9 };
    tagsNowResult = ['Improve title'];

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'still-present');
    assert.deepEqual(reopenedIds, [9]);
    assert.match(attempts[0].reason, /^verification-found-issue-still-present/);
    assert.equal(attempts[0].retryPolicy, 'item_defect', 'a live change that did not fix the issue IS an item defect and should count toward the cap');
  });
});

describe('checkContentAgainstExpectation — pre-ship SEO/tech validate', () => {
  test('PAGE_PATTERN: html-lang-present matches the same regex the post-ship check uses', () => {
    const missing = checkContentAgainstExpectation(VERIFICATION_METHOD.PAGE_PATTERN, { check: 'html-lang-present' }, '<html><head></head></html>');
    assert.equal(missing.checkable, true);
    assert.equal(missing.present, false);
    const present = checkContentAgainstExpectation(VERIFICATION_METHOD.PAGE_PATTERN, { check: 'html-lang-present' }, '<html lang="en"><head></head></html>');
    assert.equal(present.present, true);
  });

  test('PAGE_ABSENCE: a link that is still in the about-to-ship content is not yet fixed', () => {
    const result = checkContentAgainstExpectation(
      VERIFICATION_METHOD.PAGE_ABSENCE, { absent: '/broken-page' }, '<a href="/broken-page">old link</a>',
    );
    assert.equal(result.checkable, true);
    assert.equal(result.present, false);
    assert.equal(result.evidence.stillPresent, true);
  });

  test('PAGE_CONTENT: the excerpt is found in the draft\'s own final content', () => {
    const result = checkContentAgainstExpectation(
      VERIFICATION_METHOD.PAGE_CONTENT, { needle: 'Book your stay today' }, '<p>Book your stay today</p>',
    );
    assert.equal(result.checkable, true);
    assert.equal(result.present, true);
    assert.equal(result.evidence.foundIn, 'text');
  });

  test('REPO_FILE: checks the pending content directly, not a repo fetch', () => {
    const result = checkContentAgainstExpectation(
      VERIFICATION_METHOD.REPO_FILE, { files: ['content/page.md'], needle: 'new paragraph' }, 'front matter\nnew paragraph here',
    );
    assert.equal(result.checkable, true);
    assert.equal(result.present, true);
  });

  test('a method that requires a live deploy (RESPONSE_HEADER, REDIRECT, SITE_ASSET, TAG_RECHECK) is reported as not checkable pre-ship, not as failing', () => {
    for (const method of [VERIFICATION_METHOD.RESPONSE_HEADER, VERIFICATION_METHOD.REDIRECT, VERIFICATION_METHOD.SITE_ASSET, VERIFICATION_METHOD.TAG_RECHECK]) {
      const result = checkContentAgainstExpectation(method, {}, '<html></html>');
      assert.equal(result.checkable, false, `${method} should not be treated as a pre-ship-checkable method`);
    }
  });
});
