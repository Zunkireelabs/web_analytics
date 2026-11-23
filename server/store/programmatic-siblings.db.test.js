import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { listSiblingDrafts } from './programmatic-siblings.js';

// Real DB: the query's filters (site, generator, status, age, same-target exclusion) are the point. Fixtures are removed afterwards.
const TAG = `prog-siblings-db-${Date.now()}`;
const siteIds = []; let workspaceId;
async function site(label) {
  if (!workspaceId) workspaceId = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-ws`])).rows[0].id;
  const stamp = `${TAG}-${label}`;
  const { rows } = await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain) VALUES ($1, $2, $2, 'UTC', $3, $4) RETURNING id`, [`${TAG} ${label}`, stamp, workspaceId, `${label}.${TAG}.example`]);
  siteIds.push(rows[0].id); return rows[0].id;
}
const draft = (siteId, type, status, target, ageDays = 1) => query(
  `INSERT INTO drafts (site_id, action_type, input, content, status, created_at) VALUES ($1, $2, '{}'::jsonb, $3::jsonb, $4, now() - make_interval(days => $5)) RETURNING id`,
  [siteId, type, JSON.stringify({ target, headline: `H ${target}` }), status, ageDays]).then((r) => r.rows[0].id);
after(async () => { if (siteIds.length) await query('DELETE FROM sites WHERE id = ANY($1)', [siteIds]); if (workspaceId) await query('DELETE FROM workspaces WHERE id = $1', [workspaceId]); await pool.end(); });

test('only this site\'s live drafts of this generator, recent, not of the same target, newest first, capped', async () => {
  const mine = await site('mine'); const other = await site('other');
  const keep1 = await draft(mine, 'landing-page', 'implemented', 'Denver', 2);
  const keep2 = await draft(mine, 'landing-page', 'draft', 'Aurora', 1);
  await draft(mine, 'landing-page', 'abandoned', 'Gone', 1);        // never published
  await draft(mine, 'landing-page', 'revision_requested', 'Revising', 1); // still a live draft: counts
  await draft(mine, 'landing-page', 'implemented', 'Ancient', 400); // too old
  await draft(mine, 'landing-page', 'draft', 'Boulder', 1);         // the page itself: same target
  await draft(mine, 'blog-outline', 'implemented', 'Other type', 1);
  await draft(other, 'landing-page', 'implemented', 'Other project', 1);
  const rows = await listSiblingDrafts(mine, 'landing-page', { excludeTarget: 'Boulder' });
  assert.deepEqual(rows.map((r) => r.content.target), ['Revising', 'Aurora', 'Denver'], 'newest first (Revising was created after Aurora), live drafts only');
  assert.deepEqual(rows.map((r) => r.id).filter((id) => [keep1, keep2].includes(id)), [keep2, keep1]);
  assert.equal((await listSiblingDrafts(mine, 'landing-page', { excludeTarget: 'Boulder', limit: 1 })).length, 1);
  assert.equal((await listSiblingDrafts(mine, 'landing-page')).length, 4, 'with no target to exclude, the page\'s own earlier draft counts');
});
