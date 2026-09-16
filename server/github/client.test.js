import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getFileContent, getFileSha, beginFileOverlay, endFileOverlay, recordFileOverlayWrites,
  createCommitObject, updateRef, commitFilesAtomic,
  getBranchSha, getLastKnownRateLimit, RATE_LIMIT_RESERVE, searchCodeForString,
} from './client.js';
import { clearInstallationTokenCache } from './app-auth.js';

// Real HTTP calls need a resolvable token — githubTokenEnvVar defaults to
// 'GITHUB_PAT' for a site with no per-site override (credentials.js).
const originalToken = process.env.GITHUB_PAT;
process.env.GITHUB_PAT = 'test-token';
after(() => {
  if (originalToken === undefined) delete process.env.GITHUB_PAT;
  else process.env.GITHUB_PAT = originalToken;
});

const site = { id: 1, repo_owner: 'acme', repo_name: 'site' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Regression coverage for the Action Center batching feature: dozens of
// implementers read "what's currently on this branch" via getFileContent/
// getFileSha to decide how to merge the next change in. During a deferred
// batch (see implementers/lib/github-ops.js's beginBatchPush), the real
// branch ref doesn't move until the whole batch finishes — without this
// overlay, every read after the batch's first commit would silently return
// stale, pre-batch content instead of the earlier item's own write.
describe('file overlay', () => {
  test('getFileContent returns the overlay-recorded write instead of hitting the network', async () => {
    let fetchCalled = false;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; throw new Error('should never be called'); };
    try {
      beginFileOverlay(site, 'batch-branch');
      recordFileOverlayWrites(site, 'batch-branch', [{ path: 'src/_data/locations.js', content: 'module.exports = { updated: true };' }]);

      const file = await getFileContent(site, 'src/_data/locations.js', 'batch-branch');
      assert.deepEqual(file, { content: 'module.exports = { updated: true };', sha: null });
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = original;
      endFileOverlay(site, 'batch-branch');
    }
  });

  test('getFileSha returns null for an overlay-written file (tree-API writes never need a blob sha)', async () => {
    beginFileOverlay(site, 'batch-branch');
    try {
      recordFileOverlayWrites(site, 'batch-branch', [{ path: 'a.txt', content: 'hi' }]);
      assert.equal(await getFileSha(site, 'a.txt', 'batch-branch'), null);
    } finally {
      endFileOverlay(site, 'batch-branch');
    }
  });

  test('a read for a path NOT yet written this batch still falls through to the real network call', async () => {
    const original = globalThis.fetch;
    let requestedPath = null;
    globalThis.fetch = async (url) => {
      requestedPath = String(url);
      return jsonResponse({ content: Buffer.from('real content').toString('base64'), sha: 'realsha' });
    };
    try {
      beginFileOverlay(site, 'batch-branch');
      recordFileOverlayWrites(site, 'batch-branch', [{ path: 'other.txt', content: 'x' }]);

      const file = await getFileContent(site, 'untouched.txt', 'batch-branch');
      assert.deepEqual(file, { content: 'real content', sha: 'realsha' });
      assert.match(requestedPath, /untouched\.txt/);
    } finally {
      globalThis.fetch = original;
      endFileOverlay(site, 'batch-branch');
    }
  });

  test('a read on a DIFFERENT branch is unaffected by another branch\'s overlay', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ content: Buffer.from('main content').toString('base64'), sha: 'mainsha' });
    try {
      beginFileOverlay(site, 'batch-branch');
      recordFileOverlayWrites(site, 'batch-branch', [{ path: 'a.txt', content: 'batch content' }]);

      const file = await getFileContent(site, 'a.txt', 'main');
      assert.deepEqual(file, { content: 'main content', sha: 'mainsha' });
    } finally {
      globalThis.fetch = original;
      endFileOverlay(site, 'batch-branch');
    }
  });

  test('endFileOverlay clears recorded writes — a later read falls back to the network again', async () => {
    beginFileOverlay(site, 'batch-branch');
    recordFileOverlayWrites(site, 'batch-branch', [{ path: 'a.txt', content: 'batch content' }]);
    endFileOverlay(site, 'batch-branch');

    const original = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return jsonResponse({ content: Buffer.from('post-batch').toString('base64'), sha: 's' }); };
    try {
      await getFileContent(site, 'a.txt', 'batch-branch');
      assert.equal(fetchCalled, true, 'overlay must not leak past endFileOverlay');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('recordFileOverlayWrites is a no-op when no overlay is active for that branch (never throws)', () => {
    assert.doesNotThrow(() => recordFileOverlayWrites(site, 'no-such-batch', [{ path: 'a.txt', content: 'x' }]));
  });
});

// createCommitObject/updateRef split (Action Center batching): the whole
// point is that createCommitObject must NEVER move a branch ref — only
// updateRef does, and only when the caller explicitly calls it.
describe('createCommitObject / updateRef split', () => {
  test('createCommitObject never calls the ref-update endpoint', async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      if (String(url).includes('/git/commits/parent-sha')) return jsonResponse({ tree: { sha: 'base-tree-sha' } });
      if (String(url).includes('/git/trees')) return jsonResponse({ sha: 'new-tree-sha' });
      if (String(url).endsWith('/git/commits')) return jsonResponse({ sha: 'new-commit-sha' });
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      const sha = await createCommitObject(site, 'parent-sha', [{ path: 'a.txt', content: 'hi' }], 'a commit');
      assert.equal(sha, 'new-commit-sha');
      assert.ok(!calls.some((c) => c.url.includes('/git/refs/heads/')), 'createCommitObject must never touch a ref');
      assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'POST']);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('updateRef issues exactly one PATCH to the branch ref', async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      return jsonResponse({});
    };
    try {
      await updateRef(site, 'batch-branch', 'final-sha');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'PATCH');
      assert.match(calls[0].url, /\/git\/refs\/heads\/batch-branch$/);
      assert.deepEqual(calls[0].body, { sha: 'final-sha' });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('commitFilesAtomic (the original single-call shape) still reads the branch tip, creates a commit, AND moves the ref — unchanged behavior for every non-batching caller', async () => {
    const methods = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      methods.push(opts?.method || 'GET');
      if (u.includes('/git/ref/heads/')) return jsonResponse({ object: { sha: 'tip-sha' } });
      if (u.includes('/git/commits/tip-sha')) return jsonResponse({ tree: { sha: 'base-tree' } });
      if (u.includes('/git/trees')) return jsonResponse({ sha: 'tree-sha' });
      if (u.endsWith('/git/commits')) return jsonResponse({ sha: 'commit-sha' });
      if (u.includes('/git/refs/heads/')) return jsonResponse({});
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const result = await commitFilesAtomic(site, 'main', [{ path: 'a.txt', content: 'hi' }], 'msg');
      assert.deepEqual(result, { sha: 'commit-sha' });
      assert.deepEqual(methods, ['GET', 'GET', 'POST', 'POST', 'PATCH']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// The 2026-09-01 outage: the 08:00 auto-remediation run created ~130 drafts
// in one hour, exhausted the shared PAT's 5,000 req/hour budget, and every
// write after that came back `403 API rate limit exceeded for user ID
// 286862633`. Nothing here read GitHub's own rate-limit headers, so a
// one-hour wait was indistinguishable from a permanent fault and 113 drafts
// were abandoned for it.
describe('rate limiting', () => {
  // Both of GitHub's limits are covered, because they signal differently and
  // a check written for one silently misses the other.
  function limitedResponse({ remaining = '0', reset = null, retryAfter = null, body = '{"message":"API rate limit exceeded"}' } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (remaining != null) headers['x-ratelimit-remaining'] = remaining;
    if (reset != null) headers['x-ratelimit-reset'] = reset;
    if (retryAfter != null) headers['retry-after'] = retryAfter;
    return new Response(body, { status: 403, headers });
  }

  // A reset already in the past clamps the wait to the 1s floor, so these
  // tests exercise the real retry loop without sleeping out a real window.
  const pastReset = String(Math.floor(Date.now() / 1000) - 60);

  test('retries a primary rate limit (x-ratelimit-remaining: 0) and succeeds once the budget refills', async () => {
    let attempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) return limitedResponse({ reset: pastReset });
      return jsonResponse({ object: { sha: 'recovered-sha' } });
    };
    try {
      assert.equal(await getBranchSha(site, 'main'), 'recovered-sha');
      assert.equal(attempts, 2, 'should have retried exactly once');
    } finally {
      globalThis.fetch = original;
    }
  });

  // The secondary ("abuse"/content-creation) limit is what creating commits
  // and PRs trips — it arrives with `retry-after` and can leave
  // x-ratelimit-remaining well above zero, so a remaining-only check misses
  // it entirely.
  test('retries a secondary rate limit signalled by retry-after, not by a zero remaining', async () => {
    let attempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) return limitedResponse({ remaining: '4200', retryAfter: '0.001', body: '{"message":"You have exceeded a secondary rate limit"}' });
      return jsonResponse({ object: { sha: 'recovered-sha' } });
    };
    try {
      assert.equal(await getBranchSha(site, 'main'), 'recovered-sha');
      assert.equal(attempts, 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a still-limited request throws a TYPED error, so callers never have to regex the provider message', async () => {
    let attempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { attempts++; return limitedResponse({ reset: pastReset }); };
    try {
      const err = await getBranchSha(site, 'main').then(() => null, (e) => e);
      assert.ok(err, 'should have thrown');
      assert.equal(err.rateLimited, true);
      // Bounded: this runs inside a cron pass with other sites to reach, so
      // it must give up rather than sleep out a 50-minute window.
      assert.equal(attempts, 3, 'initial attempt + 2 retries, then give up');
    } finally {
      globalThis.fetch = original;
    }
  });

  // Review finding: retrying blindly sleeps up to RATE_LIMIT_MAX_RETRIES *
  // RATE_LIMIT_MAX_WAIT_MS through a wait the header ALREADY proves can't
  // succeed — a reset 40 minutes out can never be reached by 2 retries
  // clamped to 60s each, so every one of those seconds is wasted before the
  // identical throw. This must fail on the FIRST attempt instead.
  test('a reset far in the future fails fast instead of sleeping through retries that cannot help', async () => {
    let attempts = 0;
    const farFuture = String(Math.floor(Date.now() / 1000) + 60 * 40); // 40 minutes out
    const original = globalThis.fetch;
    globalThis.fetch = async () => { attempts++; return limitedResponse({ reset: farFuture }); };
    try {
      const start = Date.now();
      const err = await getBranchSha(site, 'main').then(() => null, (e) => e);
      assert.ok(err, 'should have thrown');
      assert.equal(err.rateLimited, true);
      assert.equal(attempts, 1, 'must not retry a wait the header already ruled out');
      assert.ok(Date.now() - start < 5_000, 'must not sleep before failing');
    } finally {
      globalThis.fetch = original;
    }
  });

  // The distinction that makes retrying safe at all: a 403 meaning "this
  // token cannot write to this repo" is permanent, and retrying it would
  // just add latency to a failure that is already certain.
  test('a 403 that is NOT a rate limit is returned immediately, never retried', async () => {
    let attempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      attempts++;
      return new Response('{"message":"Resource not accessible by personal access token"}', {
        status: 403, headers: { 'x-ratelimit-remaining': '4900' },
      });
    };
    try {
      const err = await getBranchSha(site, 'main').then(() => null, (e) => e);
      assert.ok(err, 'should have thrown');
      assert.notEqual(err.rateLimited, true, 'a permission failure must not be reported as a rate limit');
      assert.equal(attempts, 1, 'no retries for a permanent failure');
    } finally {
      globalThis.fetch = original;
    }
  });

  // The pre-check side: callers stop STARTING new work near the floor,
  // rather than each burning a generation call before failing at the push.
  test('getLastKnownRateLimit reports `low` once the observed budget is under the reserve', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ object: { sha: 's' } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': String(RATE_LIMIT_RESERVE - 1) },
    });
    try {
      await getBranchSha(site, 'main');
      const state = getLastKnownRateLimit(site);
      assert.equal(state.remaining, RATE_LIMIT_RESERVE - 1);
      assert.equal(state.low, true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a healthy budget does not read as low', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ object: { sha: 's' } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4900' },
    });
    try {
      await getBranchSha(site, 'main');
      assert.equal(getLastKnownRateLimit(site).low, false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// Three defects caught in review before this ever ran against a real site.
// Each one alone would have halted every site's autonomous run — the opposite
// of what the rate-limit handling was added to achieve.
describe('rate-limit state — the ways it must NOT latch', () => {
  const ok = (headers = {}) => new Response(JSON.stringify({ object: { sha: 's' } }), {
    status: 200, headers: { 'content-type': 'application/json', ...headers },
  });

  // `res.headers.get()` returns null for an absent header and `Number(null)`
  // is 0, NOT NaN — so a Number.isFinite guard does not catch it, and the
  // intended "unknown" case silently recorded "0 requests left".
  test('a response with NO rate-limit header leaves the budget unknown, never zero', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ok({ 'x-ratelimit-remaining': '4900' }); // seed a healthy value
    try {
      await getBranchSha(site, 'main');
      globalThis.fetch = async () => ok(); // now a response with no headers at all
      await getBranchSha(site, 'main');

      const state = getLastKnownRateLimit(site);
      assert.notEqual(state.remaining, 0, 'a missing header must not read as an exhausted budget');
      assert.equal(state.low, false, 'and must not halt the run');
    } finally {
      globalThis.fetch = original;
    }
  });

  // GitHub's limits are per-RESOURCE. /search/code gets ~30/minute against
  // core's 5,000/hour, and searchCodeForString sits directly on the ship path
  // — so recording its headers as the core budget would put every run under
  // the reserve after its first marker lookup.
  test('a code-search response does not poison the core budget', async () => {
    const originalSearch = process.env.GITHUB_SEARCH_PAT;
    process.env.GITHUB_SEARCH_PAT = 'ghp_classic_test_token';
    const original = globalThis.fetch;
    globalThis.fetch = async () => ok({ 'x-ratelimit-remaining': '4900' });
    try {
      await getBranchSha(site, 'main');
      globalThis.fetch = async () => new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '3' }, // search's own tiny budget
      });
      await searchCodeForString(site, 'needle');

      const state = getLastKnownRateLimit(site);
      assert.equal(state.remaining, 4900, 'core state still reflects the last CORE response');
      assert.equal(state.low, false, 'search exhaustion must not stop the ship path');
    } finally {
      globalThis.fetch = original;
      if (originalSearch === undefined) delete process.env.GITHUB_SEARCH_PAT;
      else process.env.GITHUB_SEARCH_PAT = originalSearch;
    }
  });

  // auto-remediation's pre-check breaks the loop BEFORE making any GitHub
  // call, so a run that starts low makes zero requests and learns nothing.
  // Without expiry the state stays stale forever and the loop can never
  // recover from within itself.
  test('`low` expires once the reset time has passed', async () => {
    const original = globalThis.fetch;
    const past = String(Math.floor(Date.now() / 1000) - 60);
    globalThis.fetch = async () => ok({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': past });
    try {
      await getBranchSha(site, 'main');
      const state = getLastKnownRateLimit(site);
      assert.equal(state.remaining, 3, 'the observation is still reported honestly');
      assert.equal(state.low, false, 'but a budget that has already refilled must not keep halting runs');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('`low` still fires for a genuinely exhausted budget whose reset is ahead', async () => {
    const original = globalThis.fetch;
    const future = String(Math.floor(Date.now() / 1000) + 600);
    globalThis.fetch = async () => ok({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': future });
    try {
      await getBranchSha(site, 'main');
      assert.equal(getLastKnownRateLimit(site).low, true);
    } finally {
      globalThis.fetch = original;
    }
  });

  // Real bug, found 2026-09-07 while auditing for client #2's onboarding
  // (site 8862, "Admizz Education"): this state used to be one shared value
  // for the whole process, on the reasoning that every site shared one PAT.
  // That stopped being true the moment a second tenant gets its OWN
  // credential — a distinct github_pat_env_var, or its own GitHub App
  // installation. Before this fix, exhausting site A's budget would falsely
  // report site B's unrelated, healthy budget as `low` (or the reverse: mask
  // a real exhaustion on B behind A's healthy reading) — auto-remediation.js
  // and routes/action-center.js both gate an entire site's shipping run on
  // this single check.
  test('two sites on DIFFERENT credentials have independent rate-limit state', async () => {
    const siteA = { id: 1, repo_owner: 'acme', repo_name: 'site-a' };
    const siteB = { id: 2, repo_owner: 'acme', repo_name: 'site-b', github_pat_env_var: 'GITHUB_PAT_B' };
    const originalB = process.env.GITHUB_PAT_B;
    process.env.GITHUB_PAT_B = 'test-token-b';
    const original = globalThis.fetch;
    try {
      globalThis.fetch = async () => ok({ 'x-ratelimit-remaining': '3' }); // exhaust A
      await getBranchSha(siteA, 'main');
      globalThis.fetch = async () => ok({ 'x-ratelimit-remaining': '4900' }); // B is healthy
      await getBranchSha(siteB, 'main');

      assert.equal(getLastKnownRateLimit(siteA).low, true, "A's own exhausted budget must still read low");
      assert.equal(getLastKnownRateLimit(siteB).low, false, "B's healthy budget must not be poisoned by A's");
    } finally {
      globalThis.fetch = original;
      if (originalB === undefined) delete process.env.GITHUB_PAT_B;
      else process.env.GITHUB_PAT_B = originalB;
    }
  });

  // The inverse and equally real case: two sites that deliberately still
  // share one PAT (the default before a tenant has its own GitHub App
  // installation) hit the exact same real GitHub-side budget, so they must
  // be reported as ONE shared state, not artificially separated by site.id.
  test('two sites sharing the SAME credential see one real shared budget', async () => {
    const siteA = { id: 1, repo_owner: 'acme', repo_name: 'site-a' }; // both default to GITHUB_PAT
    const siteC = { id: 3, repo_owner: 'acme', repo_name: 'site-c' };
    const original = globalThis.fetch;
    try {
      globalThis.fetch = async () => ok({ 'x-ratelimit-remaining': '3' });
      await getBranchSha(siteA, 'main');

      assert.equal(getLastKnownRateLimit(siteC).low, true, "sharing site A's token means sharing its exhausted budget");
    } finally {
      globalThis.fetch = original;
    }
  });
});

// Regression coverage: authHeaders' missing-credential error must name the
// credential actually missing, for all three real cases — a site on the
// App path is not misdiagnosed as a PAT problem, a site on the PAT path is
// not misdiagnosed as an App problem, and code search (which NEVER
// consults the App path, even for a site that otherwise uses one — see
// credentials.js's searchToken) is never told to "configure the App" when
// the real gap is a missing classic PAT for search specifically.
describe('authHeaders — missing-credential error names the right credential', () => {
  const originalEnv = { ...process.env };
  function resetEnv() {
    for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  }
  after(resetEnv);

  test('PAT-path site with no PAT set: blames the PAT env var, not the App', async () => {
    resetEnv();
    delete process.env.GITHUB_PAT;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_B64;
    const patSite = { id: 99, repo_owner: 'acme', repo_name: 'site', github_app_installation_id: null };
    await assert.rejects(
      () => getBranchSha(patSite, 'main'),
      (err) => { assert.match(err.message, /No GitHub PAT set in env var "GITHUB_PAT"/); return true; },
    );
  });

  test('App-path site with the App unconfigured: blames GITHUB_APP_ID/PRIVATE_KEY, never the PAT', async () => {
    resetEnv();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_B64;
    process.env.GITHUB_PAT = 'irrelevant-should-not-be-named';
    clearInstallationTokenCache();
    const appSite = { id: 100, repo_owner: 'acme', repo_name: 'site', github_app_installation_id: 12345 };
    await assert.rejects(
      () => getBranchSha(appSite, 'main'),
      (err) => {
        assert.match(err.message, /GitHub App is not configured/);
        assert.doesNotMatch(err.message, /GITHUB_PAT\b/, 'must not blame the PAT env var when the site is on the App path');
        return true;
      },
    );
  });

  test('a site with its OWN registered App (migration 154) and no matching key: blames its own env var, not the shared default', async () => {
    resetEnv();
    // The shared default App IS configured here — proving the bug: before
    // this fix, a site on its own dedicated App still got blamed for the
    // shared GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_B64 even though those were
    // never the actual credential this site depends on.
    process.env.GITHUB_APP_ID = 'shared-default-app-is-fine';
    process.env.GITHUB_APP_PRIVATE_KEY_B64 = 'shared-default-key-is-fine';
    delete process.env.GITHUB_APP_PRIVATE_KEY_B64_CHAYCE;
    clearInstallationTokenCache();
    const chaycePropertiesSite = {
      id: 8864, repo_owner: 'acme', repo_name: 'site',
      github_app_installation_id: 160525254,
      github_app_id: 4894335,
      github_app_private_key_env_var: 'GITHUB_APP_PRIVATE_KEY_B64_CHAYCE',
    };
    await assert.rejects(
      () => getBranchSha(chaycePropertiesSite, 'main'),
      (err) => {
        assert.match(err.message, /GITHUB_APP_PRIVATE_KEY_B64_CHAYCE/);
        assert.match(err.message, /4894335/);
        assert.doesNotMatch(err.message, /set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_B64\b/, 'must not blame the shared default App when this site has its own');
        return true;
      },
    );
  });

  test('code search with no search-specific PAT, even on an otherwise-fully-configured App site: blames the search PAT, never the App', async () => {
    resetEnv();
    process.env.GITHUB_APP_ID = 'irrelevant-app-is-fine';
    process.env.GITHUB_APP_PRIVATE_KEY_B64 = 'irrelevant-app-is-fine';
    delete process.env.GITHUB_PAT_SEARCH;
    delete process.env.GITHUB_SEARCH_PAT;
    clearInstallationTokenCache();
    const appSite = { id: 101, repo_owner: 'acme', repo_name: 'site', github_app_installation_id: 12345 };
    await assert.rejects(
      () => searchCodeForString(appSite, 'needle'),
      (err) => {
        assert.match(err.message, /GITHUB_PAT_SEARCH/);
        assert.doesNotMatch(err.message, /GitHub App is not configured/, 'the App being unconfigured is not the problem here — it is fully configured and irrelevant to search');
        return true;
      },
    );
  });
});
