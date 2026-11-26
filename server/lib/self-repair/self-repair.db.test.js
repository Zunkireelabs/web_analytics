// SELF-REPAIR across six clients, on a real Postgres (the LOCAL throwaway srtest; skipped unless DATABASE_URL points there). Six temporary projects in the
// situations the real six are in on 2026-11-26, each built from its OWN facts (nothing is copied from one to another). Proves detection per project, tenant
// isolation (a finding only ever carries its own project's id and evidence), resolution when the cause goes away, and that one project failing never stops
// the others.
//   DB_SSL=off DATABASE_URL=postgres://postgres:<local password>@localhost:55432/srtest node --experimental-test-module-mocks --test server/lib/self-repair/self-repair.db.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = /@(localhost|127\.0\.0\.1):55432\//.test(process.env.DATABASE_URL || '');
const OLD = new Date(Date.now() - 20 * 86400000).toISOString();
const blogMap = (dir, extra = {}) => ({ newContentTargets: { 'blog-outline': { dir, extension: '.md', ...extra } }, siteRoot: { pageTemplates: { 'blog-article': {} } } });
const CLIENTS = {
  admizz: { name: 'Admizz (self-repair test)', map: blogMap('src/app') },
  chayce: { name: 'Chayce (self-repair test)', map: blogMap('src/blog') },
  zennly: { name: 'Zennly (self-repair test)', map: { newContentTargets: { 'blog-outline': { dir: 'docs/marketing', extension: '.md' } }, siteRoot: { designProfile: {} } } },
  zunkiree: { name: 'Zunkiree (self-repair test)', map: blogMap('src/blog') },
  superrank: { name: 'SuperRank (self-repair test)', map: blogMap('src/content/blog') },
  mobilise: { name: 'MOBILISE (self-repair test)', map: blogMap('src/blog') },
};

describe('self-repair across six clients', { skip: !LOCAL }, () => {
  let db; let sr; const id = {};
  const cleanup = async () => {
    const ids = Object.values(id).filter(Boolean); if (!ids.length) return;
    for (const t of ['capability_findings', 'design_proposals', 'generator_outcomes', 'drafts', 'recommendations', 'keyword_gaps', 'keyword_discovery_status']) await db.query(`DELETE FROM ${t} WHERE site_id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM sites WHERE id = ANY($1::int[])`, [ids]);
  };
  const blogRecs = (k, n) => Promise.all(Array.from({ length: n }, (_, i) => db.query(`INSERT INTO recommendations (site_id, page, recommendation_type, issue, finding_ids) VALUES ($1, $2, 'blog-outline', $3, $4)`, [id[k], `topic::${k} ${i}`, `topic ${i}`, [`${k}-${i}`]])));
  const abandoned = (k, n, reason) => Promise.all(Array.from({ length: n }, () => db.query(`INSERT INTO drafts (site_id, action_type, source, input, content, status, abandoned_reason) VALUES ($1, 'blog-outline', 'selfrepair-test', '{}', '{}'::jsonb, 'abandoned', $2)`, [id[k], reason])));
  const kinds = async (k) => (await db.query(`SELECT kind FROM capability_findings WHERE site_id = $1 AND status = 'open' ORDER BY kind`, [id[k]])).rows.map((r) => r.kind);

  before(async () => {
    db = await import('../../db.js'); sr = await import('./index.js');
    await cleanup();
    for (const [k, c] of Object.entries(CLIENTS)) {
      const { rows } = await db.query(`INSERT INTO sites (name, website_domain, timezone, repo_owner, repo_name, url_file_map, growth_started_at) VALUES ($1, $2, 'Asia/Kolkata', 'o', $3, $4::jsonb, $5) RETURNING id`, [c.name, `${k}.selfrepair.test`, `${k}-web`, JSON.stringify(c.map), OLD]);
      id[k] = rows[0].id;
    }
    // Admizz: blog topics, no blog article ever drafted, a layout decision pending for 20 days.
    await blogRecs('admizz', 4);
    await db.query(`INSERT INTO design_proposals (id, site_id, kind, page_path, status, payload, created_at) VALUES ('p-admizz', $1, 'new-page-pattern', 'pattern:blog-article', 'pending', $2::jsonb, $3)`, [id.admizz, JSON.stringify({ pageType: 'blog-article', generatorId: 'blog-outline' }), OLD]);
    // Chayce and Zunkiree: complete articles abandoned by the render check.
    await blogRecs('chayce', 2); await abandoned('chayce', 3, 'Auto-ship failed: Rendered into a real "inline-article" page on this site it measures differently: body-size 19 → 17');
    await blogRecs('zunkiree', 2); await abandoned('zunkiree', 2, 'Auto-ship failed: Rendered into a real "inline-article" page on this site it measures differently: body-size 18 → 20');
    // Zennly: no article page exists on the site.
    await blogRecs('zennly', 2); await abandoned('zennly', 2, 'Auto-ship failed: No real "inline-article" page on this site could be found to compare it against');
    // SuperRank: refused because every post declares keys with no default.
    await blogRecs('superrank', 3);
    await db.query(`INSERT INTO generator_outcomes (site_id, generator_id, outcome, detail) VALUES ($1, 'blog-outline', 'refused', 'unspecified-refusal: This recommendation could not be prepared yet — Every existing post in this directory declares "auth')`, [id.superrank]);
    // MOBILISE: nothing wrong with blogs; its keyword discovery is blocked (recorded by the discovery job).
    await db.query(`INSERT INTO keyword_discovery_status (site_id, path, status, reason_code, message) VALUES ($1, 'own_search_queries', 'blocked', 'no_connection_token', 'No Search Console connection token for this project.')`, [id.mobilise]);
  });
  after(async () => { await cleanup(); });

  const contract = { unknown: false, sampled: 8, requiredKeys: ['author', 'category', 'cover', 'date', 'excerpt', 'title'], siblingConstants: { author: 'Team', category: 'SEO', cover: { kind: 'agent' } } };
  const run = () => sr.runSelfRepairForAllSites({ sites: Object.values(id).map((i) => ({ id: i })), readContract: async (site) => (site.id === id.superrank ? contract : { unknown: true }) });

  test('each client gets exactly the findings its own situation calls for', async () => {
    await run();
    assert.deepEqual(await kinds('admizz'), ['blog-waiting-on-design-decision', 'keyword-discovery-missing']); // fixtures have no keywords: every project also reports it
    assert.deepEqual(await kinds('chayce'), ['blog-render-mismatch', 'keyword-discovery-missing']);
    assert.deepEqual(await kinds('zunkiree'), ['blog-render-mismatch', 'keyword-discovery-missing']);
    assert.deepEqual(await kinds('zennly'), ['keyword-discovery-missing', 'no-blog-template']);
    assert.deepEqual(await kinds('superrank'), ['front-matter-defaults-missing', 'keyword-discovery-missing']);
    assert.deepEqual(await kinds('mobilise'), ['keyword-discovery-blocked', 'keyword-discovery-missing']);
  });

  test('Admizz: names the wait and proposes a re-derivation; SuperRank: the repair is the deploy, not a config change', async () => {
    const a = (await db.query(`SELECT * FROM capability_findings WHERE site_id = $1 AND kind = 'blog-waiting-on-design-decision'`, [id.admizz])).rows[0];
    assert.equal(a.severity, 'high'); assert.equal(a.evidence.pendingDays, 20); assert.equal(a.proposal.action, 'rederive-design-profile');
    const s = (await db.query(`SELECT * FROM capability_findings WHERE site_id = $1 AND kind = 'front-matter-defaults-missing'`, [id.superrank])).rows[0];
    assert.equal(s.proposal.action, 'deploy-sibling-derivation'); assert.equal(s.blocker, null); assert.deepEqual(s.evidence.keys, ['author', 'category', 'cover']);
  });

  test('tenant isolation: every finding carries only its own project\'s evidence and id; nothing leaks across projects', async () => {
    const rows = (await db.query(`SELECT site_id, kind, evidence, summary FROM capability_findings WHERE site_id = ANY($1::int[])`, [Object.values(id)])).rows;
    for (const r of rows) {
      const own = Object.entries(id).find(([, v]) => v === r.site_id)[0];
      assert.ok(r.summary.toLowerCase().includes(CLIENTS[own].name.split(' ')[0].toLowerCase()), `${r.kind} summary names its own project`);
    }
    const chayce = rows.find((r) => r.site_id === id.chayce && r.kind === 'blog-render-mismatch'); assert.equal(chayce.evidence.abandoned, 3);
    const zun = rows.find((r) => r.site_id === id.zunkiree && r.kind === 'blog-render-mismatch'); assert.equal(zun.evidence.abandoned, 2);
  });

  test('re-running does not duplicate, and a finding resolves when its cause goes away', async () => {
    await run();
    assert.equal((await db.query(`SELECT count(*)::int n FROM capability_findings WHERE site_id = $1 AND kind = 'blog-waiting-on-design-decision'`, [id.admizz])).rows[0].n, 1);
    await db.query(`UPDATE design_proposals SET status = 'approved' WHERE site_id = $1`, [id.admizz]);
    await run();
    assert.deepEqual(await kinds('admizz'), ['keyword-discovery-missing']);
    assert.equal((await db.query(`SELECT status FROM capability_findings WHERE site_id = $1 AND kind = 'blog-waiting-on-design-decision'`, [id.admizz])).rows[0].status, 'resolved');
  });

  test('one project failing, or missing, never stops the others', async () => {
    const out = await sr.runSelfRepairForAllSites({ sites: [{ id: id.chayce }, { id: 999999999 }, { id: id.zennly }], log: { error() {}, log() {} }, query: async (sql, p) => {
      if (/FROM drafts/.test(sql) && p?.[0] === id.chayce && /renderMismatch|measures differently/.test(sql)) throw new Error('boom');
      return db.query(sql, p);
    } });
    assert.equal(out.length, 3);
    assert.ok(out[0].error, 'the failing project is reported, not thrown');
    assert.equal(out[1].skipped, 'no-such-project');
    assert.ok(out[2].open >= 1, 'the next project still ran');
  });

  test('an open finding is visible per project', async () => {
    const z = await sr.listOpenFindings(id.zennly);
    assert.ok(z.length >= 1 && z.every((f) => f.site_id === id.zennly));
  });
});
