import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getFileContent, getFileSha, beginFileOverlay, endFileOverlay, recordFileOverlayWrites,
  createCommitObject, updateRef, commitFilesAtomic,
} from './client.js';

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
