import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { ensureIndexNowKey, recordIndexNowPing } from './indexnow.js';
import { isValidIndexNowKey } from '../lib/indexnow.js';

// Real DB: the point is the SQL (first write wins, evidence merges). Fixtures are removed afterwards.
const TAG = `indexnow-db-${Date.now()}`;
const siteIds = []; let workspaceId;
async function site(label) {
  if (!workspaceId) workspaceId = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-ws`])).rows[0].id;
  const stamp = `${TAG}-${label}`;
  const { rows } = await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain) VALUES ($1, $2, $2, 'UTC', $3, $4) RETURNING id`, [`${TAG} ${label}`, stamp, workspaceId, `${label}.${TAG}.example`]);
  siteIds.push(rows[0].id); return rows[0].id;
}
after(async () => { if (siteIds.length) await query('DELETE FROM sites WHERE id = ANY($1)', [siteIds]); if (workspaceId) await query('DELETE FROM workspaces WHERE id = $1', [workspaceId]); await pool.end(); });

test('a key is minted once, valid, and never changes; each project has its own', async () => {
  const a = await site('a'); const b = await site('b');
  const k1 = await ensureIndexNowKey(a);
  assert.ok(isValidIndexNowKey(k1));
  assert.equal(await ensureIndexNowKey(a), k1, 'asking again returns the same key');
  const kb = await ensureIndexNowKey(b);
  assert.notEqual(kb, k1);
  const { rows } = await query('SELECT indexnow_key FROM sites WHERE id = $1', [a]);
  assert.equal(rows[0].indexnow_key, k1);
});

test('two callers racing for the first key both end up with the same one', async () => {
  const s = await site('race');
  const keys = await Promise.all(Array.from({ length: 8 }, () => ensureIndexNowKey(s)));
  assert.equal(new Set(keys).size, 1);
});

test('an unknown site has no key', async () => assert.equal(await ensureIndexNowKey(2147483000), null));

test('the ping outcome is merged onto the deployment\'s existing evidence', async () => {
  const s = await site('dep');
  const { rows: [d] } = await query(`INSERT INTO deployments (site_id, commit_sha, pr_number, status, evidence) VALUES ($1, $2, 5, 'deployed', '{"via":"page-content"}'::jsonb) RETURNING id`, [s, `sha-${TAG}`]);
  await recordIndexNowPing(d.id, { ok: true, status: 200, submitted: 3, reason: 'Accepted.' });
  const { rows: [r] } = await query('SELECT evidence FROM deployments WHERE id = $1', [d.id]);
  assert.equal(r.evidence.via, 'page-content', 'what was already there stays');
  assert.deepEqual([r.evidence.indexnow.ok, r.evidence.indexnow.status, r.evidence.indexnow.submitted], [true, 200, 3]);
  assert.ok(r.evidence.indexnow.at);
});
