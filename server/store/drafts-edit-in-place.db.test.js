// Real SQL against the LOCAL throwaway database (srtest on the sr-local-pg container, port 55432). Skipped unless DATABASE_URL points there.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = /@(localhost|127\.0\.0\.1):55432\//.test(process.env.DATABASE_URL || '');
const SITE = 1;
const MARK = 'edit-in-place-test';

describe('updateDraftContentInPlace (a person editing a draft waiting for approval)', { skip: !LOCAL }, () => {
  let db; let store;
  const insert = async (status) => (await db.query(
    `INSERT INTO drafts (site_id, action_type, source, input, content, status, rendered_body, target_file_path) VALUES ($1, 'blog-outline', $2, '{}', $3, $4, 'old body', 'src/old.md') RETURNING id`,
    [SITE, MARK, JSON.stringify({ title: 'Old', quickAnswer: 'Old answer.' }), status])).rows[0].id;
  before(async () => { db = await import('../db.js'); store = await import('./drafts.js'); });
  after(async () => { await db.query(`DELETE FROM drafts WHERE site_id = $1 AND source = $2`, [SITE, MARK]); await db.pool?.end?.(); });

  test('a draft waiting for approval is saved IN PLACE: same status, the prepared file cleared so it is rebuilt', async () => {
    const id = await insert('submitted_for_approval');
    const row = await store.updateDraftContentInPlace(SITE, id, { content: { title: 'Old', quickAnswer: 'New answer.' } });
    assert.equal(row.status, 'submitted_for_approval');
    assert.equal(row.content.quickAnswer, 'New answer.');
    assert.equal(row.rendered_body, null);
    assert.equal(row.target_file_path, null);
  });
  test('a second editor working from an older copy is refused instead of replacing the first one\'s edit', async () => {
    const id = await insert('submitted_for_approval');
    const seen = (await db.query('SELECT updated_at FROM drafts WHERE id = $1', [id])).rows[0].updated_at;
    const first = await store.updateDraftContentInPlace(SITE, id, { content: { title: 'Old', quickAnswer: 'First editor.' }, expectedUpdatedAt: seen });
    assert.equal(first.content.quickAnswer, 'First editor.');
    const second = await store.updateDraftContentInPlace(SITE, id, { content: { title: 'Old', quickAnswer: 'Second editor.' }, expectedUpdatedAt: seen });
    assert.equal(second, null, 'the second save was made from a copy that is no longer current');
    assert.equal((await db.query('SELECT content FROM drafts WHERE id = $1', [id])).rows[0].content.quickAnswer, 'First editor.');
    const fresh = await store.updateDraftContentInPlace(SITE, id, { content: { title: 'Old', quickAnswer: 'Third.' } });
    assert.equal(fresh.content.quickAnswer, 'Third.', 'with no version given the save works as before');
  });
  test('the existing updateDraft still saves nothing for it (why the edit box needs this one)', async () => {
    const id = await insert('submitted_for_approval');
    assert.equal(await store.updateDraft(SITE, id, { content: { title: 'x' } }), null);
  });
  test('an approved, shipped or merged draft is never changed, and another project\'s draft is never touched', async () => {
    for (const status of ['approved', 'implemented', 'pr_opened', 'abandoned']) {
      const id = await insert(status);
      assert.equal(await store.updateDraftContentInPlace(SITE, id, { content: { title: 'x' } }), null, status);
    }
    const id = await insert('submitted_for_approval');
    assert.equal(await store.updateDraftContentInPlace(999999, id, { content: { title: 'x' } }), null);
  });
});
