// END-TO-END (Phase 2 H): the real draft path for an existing page, from generateDraft to "eligible for a
// PR", against a REAL local Postgres, a REAL local website (HTTP server) and a REAL headless browser.
//
// Only two seams are replaced, both at the network edge: the LLM (deterministic FAQ items, prompt captured)
// and GitHub (an in-memory repo; commits are recorded, never sent; opening a PR FAILS the test).
// Everything between — the validation stage, live fetch, structural + class-containment + desktop/tablet/
// mobile visual checks, the design-context scope, the real faq generator, the quality gate, draft storage,
// validateDraft (preview + rendering gate), the implementer and pushDraftBranch with its gates — is real.
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.BROWSER_SLOT_WAIT_MS = '1500'; // capacity tests must not wait two minutes
const resolve = (p) => new URL(p, import.meta.url).href;

// ── the network edge ────────────────────────────────────────────────────────
// HARD NETWORK BOUNDARY: nothing in this test may reach GitHub (or any host but the local test site and
// the local database). Any attempt is recorded and fails the test, whatever module it comes from.
const escapedRequests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) { escapedRequests.push(url); throw new Error(`E2E BOUNDARY: blocked outbound request to ${url}`); }
  return realFetch(input, init);
};

const repo = new Map(); const commits = []; let githubDown = false; const prAttempts = []; const unexpectedGithub = [];
// Every export of the real GitHub client, so any call this test did not plan for FAILS loudly (and is
// listed) instead of reaching the network.
const { readFileSync } = await import('node:fs');
const clientSrc = readFileSync(new URL('../github/client.js', import.meta.url), 'utf8');
const allGithubExports = [...clientSrc.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?|const|let|class)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);
const strictGithub = Object.fromEntries(allGithubExports.map((n) => [n, async () => { unexpectedGithub.push(n); throw new Error(`E2E: unexpected GitHub call ${n}`); }]));
mock.module(resolve('../github/client.js'), {
  namedExports: {
    ...strictGithub,
    getFileContent: async (site, path) => (repo.has(path) ? { content: repo.get(path), sha: 'sha-' + path } : null),
    getBranchSha: async () => { if (githubDown) throw new Error('GitHub 502'); return 'base-sha'; },
    createBranch: async () => { if (githubDown) throw new Error('GitHub 502'); return {}; },
    commitFilesAtomic: async (site, branch, files) => { if (githubDown) throw new Error('GitHub 502'); commits.push({ branch, files: files.map((f) => ({ path: f.path, content: f.content })) }); return { sha: 'c' + commits.length }; },
    openPullRequest: async () => { prAttempts.push(1); throw new Error('E2E BOUNDARY: a pull request must never be opened'); },
    createCommitObject: async () => ({ sha: 'x' }), updateRef: async () => ({}), getCommitMessage: async () => '',
    beginFileOverlay: () => {}, endFileOverlay: () => {}, recordFileOverlayWrites: () => {},
    mergeBranchFromBase: async () => ({ ok: true, conflicted: false, synced: false }), compareCommits: async () => ({ files: [] }),
    retargetPullRequest: async () => ({}), listOpenPullRequestsForBranch: async () => [], getPullRequest: async () => ({}),
    getCheckRunsForRef: async () => [], defaultBranchName: (s) => s.repo_default_branch || 'main',
    prTargetBranchName: (s) => s.pr_target_branch || s.repo_default_branch || 'main',
    getRepoTree: async () => ({ files: [...repo.keys()].map((path) => ({ path })), truncated: false }), putFile: async () => ({}),
  },
});

const prompts = []; const unexpectedLlm = [];
// The real module's pure helpers and constants are kept; every call that would reach a model is replaced.
const realLlm = await import('../llm.js');
mock.module(resolve('../llm.js'), {
  namedExports: {
    ...realLlm,
    callLLMWithImages: async () => { unexpectedLlm.push('callLLMWithImages'); throw new Error('E2E: unexpected image LLM call'); },
    withRetry: async (fn) => fn(),
    callLLMForJson: async (system, user) => { prompts.push(user); return [{ question: 'How much does a care home removal cost?', answer: 'It depends on the size of the move and the distance; we quote after a free visit.' }, { question: 'How long does it take?', answer: 'Most moves are completed in one day.' }]; },
    // the render-mode inspector is the one plain-text caller on this path; it expects a JSON verdict
    callLLM: async (system, user) => { prompts.push(user); return '{"mode":"visible","reasoning":"e2e: the page has no visible FAQ yet"}'; },
  },
});
// ── a real website ─────────────────────────────────────────────────────────
const CSS = `body{font-family:Georgia,serif;margin:0}.svc-hero{background:#1f2a44;color:#fff;padding:96px 24px}.svc-hero h1{font-size:44px}
.svc-body{max-width:760px;margin:0 auto;padding:64px 24px}.svc-body h2{font-size:30px;font-weight:700;color:#1f2a44}.svc-body p{font-size:18px;color:#333}
.svc-cta{background:#f4b400;padding:48px 24px;text-align:center}.faq-list{display:grid;gap:12px}.faq-q{font-size:20px;font-weight:700}.faq-a{font-size:17px}
.post-wrap{max-width:680px;margin:0 auto;padding:40px 16px}.post-wrap h1{font-size:38px}.post-wrap p{font-size:19px;line-height:1.7}`;
const SERVICE = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/site.css"></head><body>
<header class="site-header"><nav>Home</nav></header><main>
<section class="svc-hero"><h1>${title}</h1><p>Moving with care.</p></section>
<section class="svc-body"><h2>What we do</h2><p>${body}</p><h2>How it works</h2><p>We plan every step with you and your family.</p></section>
<!-- FAQ:START --><!-- FAQ:END -->
<section class="svc-cta"><h2>Talk to us</h2><p>Free home visit.</p></section></main><footer class="site-footer">©</footer></body></html>`;
const POST = `<!doctype html><html><head><link rel="stylesheet" href="/site.css"></head><body><main><article class="post-wrap"><h1>A post</h1><p>Long text.</p><p>More.</p></article></main></body></html>`;
let downPaths = new Set();
const pagesServed = { '/': SERVICE('Home', 'Welcome.'), '/services/a': SERVICE('Care home removals', 'We move older people into care homes.'), '/services/b': SERVICE('Retirement village removals', 'We move people into retirement villages.'), '/services/d': SERVICE('Storage during your move', 'Secure storage between homes.'), '/blog/x': POST };
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (downPaths.has(path) || downPaths.has('*')) { res.destroy(); return; }
  if (path === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(CSS); return; }
  if (pagesServed[path]) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pagesServed[path]); return; }
  res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><body>Not found</body></html>');
});

let db; let ac; let drafts; let backend; let stageMod; let origin; let siteId;
const sec = (role, classes, h) => ({ role, classes, textHierarchy: h ? [{ role: 'subheading', classes: h }] : [] });
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  db = await import('../db.js');
  ac = await import('../routes/action-center.js');
  drafts = await import('../store/drafts.js');
  backend = await import('../implementers/backend.js');
  stageMod = await import('../design-agent/lib/design-validation-stage.js');
  for (const p of ['/services/a', '/services/b', '/services/d']) repo.set(`src${p}.html`, pagesServed[p]);
  const profile = {
    version: 2, derivedAt: '2026-11-07T00:00:00.000Z', styling: 'custom',
    typography: { body: 'svc-body', heading: { section: 'svc-body', item: 'faq-q' } }, color: {}, spacing: {}, layout: { container: 'svc-body' }, components: {},
    pages: [{ url: `${origin}/services/a`, pageType: 'service', sections: [sec('hero', 'svc-hero'), sec('content', 'svc-body', null), sec('cta', 'svc-cta')] },
      { url: `${origin}/blog/x`, pageType: 'blog-article', sections: [sec('content', 'post-wrap')] }],
    pageTypePatterns: { service: { sectionOrder: ['hero', 'content', 'cta'], textHierarchy: [{ role: 'heading', classes: null }] } },
    layoutGroups: { revision: 1, groups: [{ id: 'g1', sample: '/services/a', members: ['/services/a', '/services/b', '/services/d'] }, { id: 'g2', sample: '/blog/x', members: ['/blog/x'] }] },
  };
  // Local-only: the fixture site lives on 127.0.0.1:<port>, and knownDomain() keeps the port while a page's
  // hostname drops it, so the same page map is also given as an explicit host scope. (Production domains
  // carry no port; this is a test-environment detail, documented in the Phase 2 report.)
  const pageMap = { '/services/a': { file: 'src/services/a.html', markers: { faq: 'FAQ' } }, '/services/b': { file: 'src/services/b.html', markers: { faq: 'FAQ' } }, '/services/d': { file: 'src/services/d.html', markers: { faq: 'FAQ' } } };
  const urlFileMap = {
    pages: pageMap, hosts: { '127.0.0.1': { pages: pageMap } },
    siteRoot: { designProfile: profile, componentTemplates: { faq: { wrapper: '<div class="faq-list">{{ROWS}}</div>', row: '<div><h3 class="faq-q">{{QUESTION}}</h3><p class="faq-a">{{ANSWER}}</p></div>', verifiedBy: 'e2e-fixture', verifiedAt: '2026-11-07T00:00:00.000Z' } } },
  };
  siteId = (await db.query(`INSERT INTO sites (name, website_domain, repo_owner, repo_name, repo_default_branch, url_file_map) VALUES ('e2e design', $1, 'acme', 'site', 'main', $2) RETURNING id`, [origin, JSON.stringify(urlFileMap)])).rows[0].id;
});
after(async () => {
  await db.query('DELETE FROM sites WHERE id = $1', [siteId]).catch(() => {});
  await new Promise((r) => server.close(r));
  await db.pool.end();
});

const groupsNow = async () => JSON.stringify((await db.query('SELECT url_file_map FROM sites WHERE id=$1', [siteId])).rows[0].url_file_map.siteRoot.designProfile.layoutGroups);
const evidence = async () => (await db.query('SELECT status, payload FROM design_validation_evidence WHERE site_id=$1 ORDER BY id', [siteId])).rows;
let groupsAtStart;

describe('E2E — existing page, generateDraft -> eligible for a PR (nothing sent)', () => {
  let draft;
  test('1-6: generateDraft validates the LIVE page (structure + containment + 3-viewport render), the context reaches the REAL generator, a draft is stored', async () => {
    groupsAtStart = await groupsNow();
    prompts.length = 0;
    draft = await ac.generateDraft(siteId, { generatorId: 'faq', params: { page: `${origin}/services/b`, topic: 'care home removal costs' }, source: 'e2e', findingId: 'e2e-f1' });
    assert.ok(draft?.id, 'a draft was created');
    const ev = await evidence();
    const v = ev.find((e) => e.payload.kind === 'validation');
    assert.equal(v.status, 'matched', 'validated against its group sample');
    assert.equal(v.payload.signals.visual.verdict, 'match', 'the rendered desktop/tablet/mobile comparison ran and matched');
    assert.match(prompts.join('\n'), /checked against the live site .* matches layout group g1/, 'the validated context reached the real generator');
  });

  test('7-9: submit + validateDraft (quality gate, implementer preview, rendering gate) -> eligible; apply runs pushDraftBranch gates; the commit is recorded, NOT sent; no PR', async () => {
    await drafts.submitDraftForApproval(siteId, draft.id);
    const { draft: d, site, resolved } = await ac.validateDraft(siteId, draft.id, {});
    assert.ok(resolved?.implementer, 'eligible: an implementer resolved and every pre-PR check passed');
    const applied = await resolved.implementer.apply(site, d);
    assert.equal(applied.ok, true, applied.error || '');
    assert.equal(commits.length, 1, 'exactly one commit prepared');
    const written = commits[0].files.find((f) => f.path === 'src/services/b.html').content;
    assert.match(written, /class="faq-list"/); assert.match(written, /class="faq-q"/);
    assert.equal(prAttempts.length, 0, 'no pull request was opened');
    const integrity = (await evidence()).filter((e) => e.payload.kind === 'integrity');
    assert.ok(integrity.length >= 1 && integrity.every((e) => e.payload.ok), 'the final design-integrity gate checked the rendered file and passed it');
  });

  test('retrying the same finding returns the SAME draft (no duplicate), and no unapproved group change happened', async () => {
    const again = await ac.generateDraft(siteId, { generatorId: 'faq', params: { page: `${origin}/services/b`, topic: 'care home removal costs' }, source: 'e2e', findingId: 'e2e-f1' });
    assert.equal(again.id, draft.id);
    assert.equal((await db.query('SELECT count(*)::int n FROM drafts WHERE site_id=$1', [siteId])).rows[0].n, 1);
    assert.equal(await groupsNow(), groupsAtStart);
  });
});

describe('E2E — recovery: failures are held as PENDING, never pass, never duplicate, never block other pages', () => {
  test('page temporarily DOWN: pending (not refusal), no draft, evidence kept; an unrelated page still produces a draft', async () => {
    // /services/d has not been fetched by this process yet (a page read seconds ago is legitimately served
    // from the 5-minute page cache, so it would not show an outage)
    downPaths = new Set(['/services/d']);
    const before = (await db.query('SELECT count(*)::int n FROM drafts WHERE site_id=$1', [siteId])).rows[0].n;
    const err = await ac.generateDraft(siteId, { generatorId: 'faq', params: { page: `${origin}/services/d`, topic: 'x' }, source: 'e2e', findingId: 'e2e-down' }).catch((e) => e);
    assert.equal(err.designPending, true); assert.notEqual(err.refusal, true); assert.equal(err.status, 503);
    assert.equal((await db.query('SELECT count(*)::int n FROM drafts WHERE site_id=$1', [siteId])).rows[0].n, before, 'no draft for the held page');
    downPaths = new Set();
    const other = await ac.generateDraft(siteId, { generatorId: 'faq', params: { page: `${origin}/services/b`, topic: 'another question' }, source: 'e2e', findingId: 'e2e-other' });
    assert.ok(other.id, 'the unrelated page proceeds');
    const again = await ac.generateDraft(siteId, { generatorId: 'faq', params: { page: `${origin}/services/d`, topic: 'x' }, source: 'e2e', findingId: 'e2e-down' }).catch((e) => e);
    assert.equal(again.designPending, true, 'inside the back-off the held page is not re-tried (even though it is back up)');
    assert.match(again.message, /waiting/);
  });

  test('DELETED page: first 404 holds and re-checks later; nothing is concluded from one 404', async () => {
    const err = await ac.generateDraft(siteId, { generatorId: 'faq', params: { page: `${origin}/services/gone`, topic: 'x' }, source: 'e2e', findingId: 'e2e-gone' }).catch((e) => e);
    assert.equal(err.designPending, true); assert.equal(err.pendingReason, 'page-gone'); assert.equal(err.exhausted, false);
  });

  test('BROWSER capacity exhausted across workers: the visual check cannot run -> pending, never a silent pass', async () => {
    const { createBrowserSlots } = await import('../lib/browser-slots.js');
    const holders = await Promise.all([0, 1, 2].map(() => createBrowserSlots({ slots: 3, waitMs: 2000 }).acquire()));
    // a fresh page so nothing is remembered
    pagesServed['/services/c'] = SERVICE('Downsizing help', 'We help people downsize.'); repo.set('src/services/c.html', pagesServed['/services/c']);
    const { patchUrlFileMap } = await import('../db.js');
    await patchUrlFileMap(siteId, (m) => ({ ...m, pages: { ...m.pages, '/services/c': { file: 'src/services/c.html' } }, hosts: { '127.0.0.1': { pages: { ...m.hosts['127.0.0.1'].pages, '/services/c': { file: 'src/services/c.html' } } } } }));
    const err = await ac.generateDraft(siteId, { generatorId: 'faq', params: { page: `${origin}/services/c`, topic: 'x' }, source: 'e2e', findingId: 'e2e-cap' }).catch((e) => e);
    await Promise.all(holders.map((r) => r()));
    assert.equal(err.designPending, true, String(err.message));
  });

  test('GitHub failure at commit time: apply fails cleanly, nothing half-written; the retry succeeds with ONE commit and no PR', async () => {
    const d = (await db.query(`SELECT id FROM drafts WHERE site_id=$1 AND finding_id='e2e-other'`, [siteId])).rows[0];
    await drafts.submitDraftForApproval(siteId, d.id);
    const { draft, site, resolved } = await ac.validateDraft(siteId, d.id, {});
    const before = commits.length;
    githubDown = true;
    const failed = await resolved.implementer.apply(site, draft);
    githubDown = false;
    assert.equal(failed.ok, false); assert.equal(commits.length, before, 'nothing committed');
    const ok = await resolved.implementer.apply(site, draft);
    assert.equal(ok.ok, true); assert.equal(commits.length, before + 1); assert.equal(prAttempts.length, 0);
  });

  test('NEW page type with no page of its own and no approved pattern: held for a design decision, proposal recorded, no draft', async () => {
    const before = (await db.query('SELECT count(*)::int n FROM drafts WHERE site_id=$1', [siteId])).rows[0].n;
    const err = await ac.generateDraft(siteId, { generatorId: 'blog-outline', params: { topic: 'moving checklist', keyword: 'moving checklist' }, source: 'e2e', findingId: 'e2e-newtype' }).catch((e) => e);
    // the site HAS a blog-article pattern? no: only 'service' is observed — blog pages need an approved pattern
    assert.equal(err.designPending, true, String(err.message));
    assert.equal(err.pendingReason, 'needs-approved-pattern');
    const props = (await db.query(`SELECT kind, status FROM design_proposals WHERE site_id=$1 AND kind='new-page-pattern'`, [siteId])).rows;
    assert.deepEqual(props.map((p) => p.status), ['pending']);
    assert.equal((await db.query('SELECT count(*)::int n FROM drafts WHERE site_id=$1', [siteId])).rows[0].n, before);
  });

  test('at the end: no design-group change happened without approval, and NOTHING left the machine', async () => {
    assert.equal(await groupsNow(), groupsAtStart);
    assert.deepEqual(escapedRequests, [], 'no outbound request');
    assert.deepEqual(unexpectedGithub, [], 'no unplanned GitHub call');
    assert.deepEqual(unexpectedLlm, [], 'no unplanned LLM call');
    assert.equal(prAttempts.length, 0, 'no pull request');
  });
});
