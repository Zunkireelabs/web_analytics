import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, createClientSite } from '../db.js';
import { takeSlot, giveBackSlot, slotsUsedToday, isCeilingError, AutonomousCeilingError } from './autonomous-slots.js';
import { createDraft } from './drafts.js';
import { AUTONOMOUS_DRAFT_SOURCES } from '../lib/autonomous-quota.js';

// Real Postgres. The point of every test here is the interleaving: the database, not the caller, decides who gets the last slot.
const TAG = `slots${Date.now()}`;
const ids = [];
async function site(limit = 60, surgeDays = null, extra = {}) {
  const r = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, website_domain, auto_remediation_daily_limit, surge_mode_until)
     VALUES ($1,$2,$2,'UTC',$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int * interval '1 day') END) RETURNING id`,
    [`${TAG} ${ids.length}`, `${TAG}-${ids.length}`, `s${ids.length}.${TAG}.example`, limit, surgeDays]);
  ids.push(r.rows[0].id); return r.rows[0].id;
}
const settle = (ps) => Promise.allSettled(ps);
const ok = (rs) => rs.filter((r) => r.status === 'fulfilled').length;
const refused = (rs) => rs.filter((r) => r.status === 'rejected' && isCeilingError(r.reason)).length;

after(async () => {
  if (ids.length) {
    await query('DELETE FROM drafts WHERE site_id = ANY($1::int[])', [ids]);
    await query('DELETE FROM autonomous_daily_slots WHERE site_id = ANY($1::int[])', [ids]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.end();
});

describe('the atomic ceiling', () => {
  test('150 simultaneous takers on a surge site: exactly 100 succeed, 50 are refused', async () => {
    const id = await site(60, 30);
    const rs = await settle(Array.from({ length: 150 }, () => takeSlot(id)));
    assert.equal(ok(rs), 100);
    assert.equal(refused(rs), 50);
    assert.equal((await slotsUsedToday(id)).used, 100);
  });

  test('the same 150 on a normal site stop at 60', async () => {
    const id = await site(60, null);
    const rs = await settle(Array.from({ length: 150 }, () => takeSlot(id)));
    assert.equal(ok(rs), 60);
  });

  test('an explicit lower limit is the cap even in surge', async () => {
    const id = await site(30, 30);
    assert.equal(ok(await settle(Array.from({ length: 80 }, () => takeSlot(id)))), 30);
  });

  test('a paused site (limit 0) takes nothing', async () => {
    const id = await site(0, 30);
    await assert.rejects(takeSlot(id), AutonomousCeilingError);
  });

  test('an expired surge falls back to 60 by itself', async () => {
    const id = await site(60, 30);
    await query(`UPDATE sites SET surge_mode_until = now() - interval '1 minute' WHERE id = $1`, [id]);
    assert.equal(ok(await settle(Array.from({ length: 100 }, () => takeSlot(id)))), 60);
  });

  test('a mid-day first touch is seeded with what was already spent, so a deploy hands out no second helping', async () => {
    const id = await site(60, 30);
    for (let i = 0; i < 70; i += 1) await query(`INSERT INTO drafts (site_id, action_type, source, content, input) VALUES ($1,'x',$2,'{}','{}')`, [id, AUTONOMOUS_DRAFT_SOURCES[i % 6]]);
    const rs = await settle(Array.from({ length: 60 }, () => takeSlot(id)));
    assert.equal(ok(rs), 30, '70 already spent across six sources leaves 30 of 100');
  });

  test('a manual draft is not autonomous and takes no slot', async () => {
    const id = await site(60, 30);
    await createDraft(id, { actionType: 'x', source: 'manual', content: {}, input: {} });
    await createDraft(id, { actionType: 'x', source: null, content: {}, input: {} });
    assert.equal((await slotsUsedToday(id)).used, null);
  });

  test('all six autonomous sources racing through createDraft share ONE 100', async () => {
    const id = await site(60, 30);
    const jobs = Array.from({ length: 180 }, (_, i) => createDraft(id, { actionType: 'x', source: AUTONOMOUS_DRAFT_SOURCES[i % 6], content: {}, input: {}, findingId: `${TAG}-f${i}` }));
    const rs = await settle(jobs);
    assert.equal(ok(rs), 100);
    assert.equal(refused(rs), 80);
    const n = (await query(`SELECT COUNT(*)::int n FROM drafts WHERE site_id = $1 AND source = ANY($2)`, [id, AUTONOMOUS_DRAFT_SOURCES])).rows[0].n;
    assert.equal(n, 100, 'rows that exist = slots taken');
  });

  test('a draft whose insert fails gives its slot back', async () => {
    const id = await site(60, 30);
    await createDraft(id, { actionType: 'x', source: 'auto-remediation', content: {}, input: {}, findingId: `${TAG}-dup` });
    assert.equal((await slotsUsedToday(id)).used, 1);
    const again = await createDraft(id, { actionType: 'x', source: 'auto-remediation', content: {}, input: {}, findingId: `${TAG}-dup` });
    assert.ok(again.id, 'the losing duplicate returns the winner');
    assert.equal((await slotsUsedToday(id)).used, 1, 'the duplicate did not cost a slot');
  });

  test('giving back never goes below zero, and frees exactly one', async () => {
    const id = await site(60, 30);
    await giveBackSlot(id);
    await takeSlot(id); await takeSlot(id);
    await giveBackSlot(id);
    assert.equal((await slotsUsedToday(id)).used, 1);
  });

  test('a full day is a ceiling error, not a generic failure', async () => {
    const id = await site(2, null);
    await takeSlot(id); await takeSlot(id);
    await assert.rejects(takeSlot(id), (e) => isCeilingError(e) && e.used === 2 && e.cap === 2);
  });

  test('a site is held to its own count: another site\'s full day does not block it', async () => {
    const a = await site(1, null); const b = await site(1, null);
    await takeSlot(a);
    await assert.rejects(takeSlot(a), AutonomousCeilingError);
    await takeSlot(b);
  });
});

describe('who gets Surge Mode', () => {
  test('a project created through createClientSite (admin onboarding AND client self-service) gets 30 days', async () => {
    const s = await createClientSite({ name: `${TAG} new`, websiteDomain: `new.${TAG}.example`, timezone: 'UTC' });
    ids.push(s.id);
    const days = (new Date(s.surge_mode_until).getTime() - Date.now()) / 86400000;
    assert.ok(days > 29.9 && days <= 30.01, `~30 days, got ${days}`);
  });

  test('a project that already existed is NULL: off', async () => {
    const id = await site(60, null);
    assert.equal((await query('SELECT surge_mode_until FROM sites WHERE id = $1', [id])).rows[0].surge_mode_until, null);
  });

  test('migration 242 changes no existing row', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../migrations/242_surge_mode.sql', import.meta.url), 'utf8');
    assert.ok(!/\b(UPDATE|INSERT|(?<!ON )DELETE)\b/i.test(sql.replace(/--.*$/gm, '')), 'no data statements');
    assert.ok(!/surge_mode_until[^;]*DEFAULT/i.test(sql.replace(/--.*$/gm, '')), 'no default: existing rows stay NULL');
  });
});
