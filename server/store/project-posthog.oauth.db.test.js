import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pool, query } from '../db.js';
import { decryptSecret } from '../lib/secret-box.js';
import {
  saveOauthSignIn, selectOauthProject, getFreshPosthogAccess, getPosthogCredentials, getPosthogConnection, getPosthogConnectionState,
  getPosthogRevokeInfo, savePosthogConnection, deletePosthogConnection, listPosthogConnectedSites, recordPosthogStatus,
  upsertPosthogDay, getPosthogRange, getPosthogSummary, recordPosthogFailure, isPermanentPosthogFailure,
} from './project-posthog.js';

// Real DB (migration 244). The row lock around a token refresh, the CHECK constraints and "tokens are encrypted at rest and
// never in the UI read" are things only a real database can show.

const siteIds = [];
async function makeSite(label) {
  const stamp = `posthog-oauth-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('project-posthog.oauth.db.test.js fixture', $1, $2, 'UTC') RETURNING id`, [stamp, stamp]);
  siteIds.push(rows[0].id);
  return rows[0].id;
}
const CLIENT = 'https://app.superrank.si/api/posthog/oauth-client';
const tokens = (over = {}) => ({ accessToken: 'pha_first', refreshToken: 'phr_first', expiresAt: new Date(Date.now() + 3600_000), scopes: ['query:read', 'project:read'], ...over });
const signIn = (siteId, over = {}) => saveOauthSignIn(siteId, { host: 'https://us.posthog.com', clientId: CLIENT, tokens: tokens(), email: 'maya@brightsmile.com', connectedBy: null, ...over });

let savedKey;
before(() => { savedKey = process.env.SECRETS_ENCRYPTION_KEY; process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64'); });
after(async () => {
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  if (siteIds.length) await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  await pool.end();
});

describe('signing in with PostHog (real DB)', () => {
  test('the sign-in is stored encrypted, with no project yet, and is NOT picked up by the nightly job', async () => {
    const siteId = await makeSite('signin');
    await signIn(siteId);
    const { rows: [raw] } = await query('SELECT * FROM project_posthog_connections WHERE site_id = $1', [siteId]);
    assert.notEqual(raw.refresh_token_enc, 'phr_first'); assert.notEqual(raw.access_token_enc, 'pha_first');
    assert.equal(decryptSecret(raw.refresh_token_enc), 'phr_first'); assert.equal(decryptSecret(raw.access_token_enc), 'pha_first');
    assert.equal(raw.project_id, null); assert.equal(raw.api_key_enc, null); assert.equal(raw.auth_method, 'oauth'); assert.equal(raw.status, 'pending');
    assert.equal(raw.oauth_client_id, CLIENT);
    assert.ok(!(await listPosthogConnectedSites()).some((r) => r.id === siteId), 'no project chosen means nothing to ingest');
    assert.equal(await getPosthogCredentials(siteId), null);
  });

  test('the read a UI calls shows who connected and that a project is still to be chosen, and never a token', async () => {
    const siteId = await makeSite('uiread');
    await signIn(siteId);
    const c = await getPosthogConnection(siteId);
    assert.equal(c.pending, true); assert.equal(c.method, 'oauth'); assert.equal(c.connected_email, 'maya@brightsmile.com');
    for (const k of Object.keys(c)) assert.ok(!/token|key|secret|enc/i.test(k), `${k} must not be readable by the UI`);
    assert.deepEqual(await getPosthogConnectionState(siteId), { connected: false, status: null });
  });

  test('refuses to store anything when the server has no encryption key, rather than falling back to plaintext', async () => {
    const siteId = await makeSite('nokey');
    const k = process.env.SECRETS_ENCRYPTION_KEY; delete process.env.SECRETS_ENCRYPTION_KEY;
    try { await assert.rejects(() => signIn(siteId), /SECRETS_ENCRYPTION_KEY/); } finally { process.env.SECRETS_ENCRYPTION_KEY = k; }
    assert.equal(await getPosthogConnection(siteId), null);
  });

  test('choosing the project completes the connection, which then shows up for the job and in the project-member state', async () => {
    const siteId = await makeSite('choose');
    await signIn(siteId);
    const chosen = await selectOauthProject(siteId, { projectId: '4521', projectName: 'BrightSmile website' });
    assert.equal(chosen.project_id, '4521');
    await recordPosthogStatus(siteId, true);
    assert.ok((await listPosthogConnectedSites()).some((r) => r.id === siteId));
    assert.deepEqual(await getPosthogConnectionState(siteId), { connected: true, status: 'ok' });
    const c = await getPosthogConnection(siteId);
    assert.equal(c.pending, false); assert.equal(c.project_name, 'BrightSmile website');
  });

  test('a new sign-in is a new account: the old project choice and verdict are cleared', async () => {
    const siteId = await makeSite('resignin');
    await signIn(siteId); await selectOauthProject(siteId, { projectId: '1', projectName: 'Old' }); await recordPosthogStatus(siteId, true);
    await signIn(siteId, { email: 'other@example.com', tokens: tokens({ refreshToken: 'phr_second' }) });
    const c = await getPosthogConnection(siteId);
    assert.equal(c.pending, true); assert.equal(c.status, 'pending'); assert.equal(c.connected_email, 'other@example.com');
  });

  test('selecting a project for a pasted-key connection does nothing (only a sign-in has a project to choose)', async () => {
    const siteId = await makeSite('keyselect');
    await savePosthogConnection(siteId, { projectId: '9', host: 'https://us.posthog.com', apiKey: 'phx_k' });
    assert.equal(await selectOauthProject(siteId, { projectId: '10' }), null);
  });
});

describe('a usable token, refreshed only when needed (real DB)', () => {
  const connected = async (label, t = tokens()) => {
    const siteId = await makeSite(label);
    await signIn(siteId, { tokens: t }); await selectOauthProject(siteId, { projectId: '4521', projectName: 'P' });
    return siteId;
  };

  test('a fresh token is returned as stored, with no call to PostHog', async () => {
    const siteId = await connected('fresh');
    let called = 0;
    const out = await getFreshPosthogAccess(siteId, { refresh: async () => { called++; return { ok: false }; } });
    assert.equal(out.accessToken, 'pha_first'); assert.equal(called, 0);
    const creds = await getPosthogCredentials(siteId, { refresh: async () => { called++; } });
    assert.deepEqual(creds, { projectId: '4521', host: 'https://us.posthog.com', apiKey: 'pha_first' });
  });

  test('an expiring token is refreshed, and the new token AND the rotated refresh token are saved encrypted', async () => {
    const siteId = await connected('expiring', tokens({ expiresAt: new Date(Date.now() + 30_000) }));
    const seen = [];
    const refresh = async (a) => { seen.push(a); return { ok: true, accessToken: 'pha_second', expiresAt: new Date(Date.now() + 3600_000), refreshToken: 'phr_second' }; };
    const out = await getFreshPosthogAccess(siteId, { refresh });
    assert.equal(out.accessToken, 'pha_second');
    assert.deepEqual(seen[0], { host: 'https://us.posthog.com', refreshToken: 'phr_first', clientId: CLIENT });
    const { rows: [raw] } = await query('SELECT refresh_token_enc, access_token_enc FROM project_posthog_connections WHERE site_id = $1', [siteId]);
    assert.equal(decryptSecret(raw.refresh_token_enc), 'phr_second'); assert.equal(decryptSecret(raw.access_token_enc), 'pha_second');
    assert.equal((await getFreshPosthogAccess(siteId, { refresh: async () => assert.fail('already fresh') })).accessToken, 'pha_second');
  });

  test('two callers at once refresh ONCE: the second waits for the row lock and then uses the new token', async () => {
    const siteId = await connected('race', tokens({ expiresAt: new Date(Date.now() - 1000) }));
    let calls = 0;
    const refresh = async () => { calls++; await new Promise((r) => setTimeout(r, 150)); return { ok: true, accessToken: 'pha_once', expiresAt: new Date(Date.now() + 3600_000), refreshToken: 'phr_once' }; };
    const [a, b] = await Promise.all([getFreshPosthogAccess(siteId, { refresh }), getFreshPosthogAccess(siteId, { refresh })]);
    assert.equal(calls, 1, 'a rotated refresh token must never be spent twice');
    assert.deepEqual([a.accessToken, b.accessToken], ['pha_once', 'pha_once']);
  });

  test('a revoked grant is returned, not thrown, marks THIS connection as an error in plain words, and the credential carries the reason', async () => {
    const siteId = await connected('revoked', tokens({ expiresAt: new Date(Date.now() - 1000) }));
    const refresh = async () => ({ ok: false, reason: 'unauthorized', detail: 'invalid_grant' });
    const out = await getFreshPosthogAccess(siteId, { refresh });
    assert.equal(out.ok, false); assert.equal(out.reason, 'unauthorized');
    const c = await getPosthogConnection(siteId);
    assert.equal(c.status, 'error'); assert.match(c.status_error, /revoked or has expired/);
    const creds = await getPosthogCredentials(siteId, { refresh });
    assert.equal(creds.apiKey, null); assert.equal(creds.authError.reason, 'unauthorized'); assert.equal(creds.projectId, '4521');
  });

  test('an outage is NOT recorded as a broken connection (it will work tomorrow)', async () => {
    const siteId = await connected('outage', tokens({ expiresAt: new Date(Date.now() - 1000) }));
    const out = await getFreshPosthogAccess(siteId, { refresh: async () => ({ ok: false, reason: 'unreachable', detail: 'ETIMEDOUT' }) });
    assert.equal(out.reason, 'unreachable');
    assert.equal((await getPosthogConnection(siteId)).status, 'pending');
  });

  test('a pasted-key connection is untouched by all of this: same credential shape, no refresh', async () => {
    const siteId = await makeSite('key');
    await savePosthogConnection(siteId, { projectId: '9', host: 'https://eu.posthog.com', apiKey: 'phx_key' });
    assert.deepEqual(await getPosthogCredentials(siteId, { refresh: async () => assert.fail('keys do not refresh') }), { projectId: '9', host: 'https://eu.posthog.com', apiKey: 'phx_key' });
    assert.equal((await getFreshPosthogAccess(siteId)).reason, 'not_connected');
  });

  test('pasting a key over a sign-in removes every token, so there are never two live credentials', async () => {
    const siteId = await connected('replace');
    await savePosthogConnection(siteId, { projectId: '9', host: 'https://us.posthog.com', apiKey: 'phx_key' });
    const { rows: [raw] } = await query('SELECT * FROM project_posthog_connections WHERE site_id = $1', [siteId]);
    assert.deepEqual([raw.refresh_token_enc, raw.access_token_enc, raw.oauth_client_id, raw.connected_email, raw.auth_method], [null, null, null, null, 'key']);
  });
});

describe('disconnecting (real DB)', () => {
  test('the revoke info is read BEFORE the row is deleted, and nothing is left behind', async () => {
    const siteId = await makeSite('revoke');
    await signIn(siteId);
    assert.deepEqual(await getPosthogRevokeInfo(siteId), { host: 'https://us.posthog.com', token: 'phr_first', clientId: CLIENT });
    assert.equal(await deletePosthogConnection(siteId), true);
    assert.equal(await getPosthogRevokeInfo(siteId), null);
    assert.equal(await getPosthogConnection(siteId), null);
  });

  test('a pasted key has nothing to revoke at PostHog', async () => {
    const siteId = await makeSite('revokekey');
    await savePosthogConnection(siteId, { projectId: '9', host: 'https://us.posthog.com', apiKey: 'phx_key' });
    assert.equal(await getPosthogRevokeInfo(siteId), null);
  });

  test('the table itself refuses a half-formed row: a key connection with no key', async () => {
    const siteId = await makeSite('check');
    await assert.rejects(() => query("INSERT INTO project_posthog_connections (site_id, auth_method) VALUES ($1, 'key')", [siteId]), /project_posthog_credential_check|violates/);
    await assert.rejects(() => query("INSERT INTO project_posthog_connections (site_id, auth_method) VALUES ($1, 'oauth')", [siteId]), /project_posthog_credential_check|violates/);
  });
});

// ── what happens to the stored days when the connection changes ────────────────────────────────────────────

describe('a connection change never leaves another project\'s data behind (real DB)', () => {
  const dayRow = { date: '2026-11-03', totals: { events: 100, people: 10, pageviews: 60, sessions: 50 }, dropOffs: [{ event: 'page: /pricing', sessionsEndingHere: 9 }], topActions: [{ label: 'Faq opened', raw: 'faq_opened', times: 4 }] };
  const daysOf = async (siteId) => (await query('SELECT count(*)::int AS n FROM posthog_daily WHERE site_id = $1', [siteId])).rows[0].n;
  const withData = async (label, { oauth = true } = {}) => {
    const siteId = await makeSite(label);
    if (oauth) { await signIn(siteId); await selectOauthProject(siteId, { projectId: '4521', projectName: 'A' }); }
    else await savePosthogConnection(siteId, { projectId: '4521', host: 'https://us.posthog.com', apiKey: 'phx_k' });
    await upsertPosthogDay(siteId, dayRow);
    assert.equal(await daysOf(siteId), 1);
    return siteId;
  };

  test('DISCONNECTING clears the days, so the Overview and reports stop showing them', async () => {
    const siteId = await withData('disc');
    assert.ok(await getPosthogSummary(siteId, '2026-11-01', '2026-11-05'));
    await deletePosthogConnection(siteId);
    assert.equal(await daysOf(siteId), 0);
    assert.equal(await getPosthogSummary(siteId, '2026-11-01', '2026-11-05'), null);
  });

  test('CHOOSING A DIFFERENT PROJECT clears the old one\'s days, so the two are never mixed', async () => {
    const siteId = await withData('switch');
    await selectOauthProject(siteId, { projectId: '9999', projectName: 'B' });
    assert.equal(await daysOf(siteId), 0);
    await recordPosthogStatus(siteId, true);
    await upsertPosthogDay(siteId, { ...dayRow, date: '2026-11-04', totals: { events: 7, people: 1, pageviews: 3, sessions: 2 } });
    const s = await getPosthogSummary(siteId, '2026-11-01', '2026-11-05');
    assert.equal(s.events, 7, 'only the new project\'s day is counted');
    assert.equal(s.series.length, 1);
  });

  test('re-choosing the SAME project (e.g. after signing in again) keeps its history', async () => {
    const siteId = await withData('same');
    await signIn(siteId, { tokens: tokens({ refreshToken: 'phr_again' }) }); // new sign-in: no project yet
    assert.equal(await daysOf(siteId), 1, 'signing in again alone does not discard anything');
    assert.equal(await getPosthogSummary(siteId, '2026-11-01', '2026-11-05'), null, 'but nothing is SHOWN while no project is chosen');
    await selectOauthProject(siteId, { projectId: '4521', projectName: 'A' });
    assert.equal(await daysOf(siteId), 1);
    assert.equal((await getPosthogSummary(siteId, '2026-11-01', '2026-11-05')).events, 100);
  });

  test('signing in to a DIFFERENT host (say EU instead of US) and choosing the same project number is a different project: cleared', async () => {
    const siteId = await withData('host');
    await signIn(siteId, { host: 'https://eu.posthog.com' });
    await selectOauthProject(siteId, { projectId: '4521', projectName: 'A' });
    assert.equal(await daysOf(siteId), 0);
  });

  test('a pasted key: another project or host clears, the same does not', async () => {
    const siteId = await withData('key', { oauth: false });
    await savePosthogConnection(siteId, { projectId: '4521', host: 'https://us.posthog.com', apiKey: 'phx_rotated' });
    assert.equal(await daysOf(siteId), 1, 'a rotated key for the same project keeps history');
    await savePosthogConnection(siteId, { projectId: '777', host: 'https://us.posthog.com', apiKey: 'phx_k' });
    assert.equal(await daysOf(siteId), 0);
    await upsertPosthogDay(siteId, dayRow);
    await savePosthogConnection(siteId, { projectId: '777', host: 'https://eu.posthog.com', apiKey: 'phx_k' });
    assert.equal(await daysOf(siteId), 0, 'same number on another host is another project');
  });

  test('a connection saved before data_key existed is compared by its own host and project (no silent mixing on upgrade)', async () => {
    const siteId = await withData('legacy');
    await query('UPDATE project_posthog_connections SET data_key = NULL WHERE site_id = $1', [siteId]);
    await selectOauthProject(siteId, { projectId: '123', projectName: 'C' });
    assert.equal(await daysOf(siteId), 0);
  });

  test('reads show nothing without a live connection, even if rows are left in the table', async () => {
    const siteId = await makeSite('orphan');
    await query("INSERT INTO posthog_daily (site_id, date, events, sessions) VALUES ($1, '2026-11-03', 5, 2)", [siteId]); // bypasses the guard on purpose
    assert.deepEqual(await getPosthogRange(siteId, '2026-11-01', '2026-11-05'), []);
    assert.equal(await getPosthogSummary(siteId, '2026-11-01', '2026-11-05'), null);
    await signIn(siteId); // signed in, no project chosen
    assert.deepEqual(await getPosthogRange(siteId, '2026-11-01', '2026-11-05'), []);
    assert.equal(await getPosthogSummary(siteId, '2026-11-01', '2026-11-05'), null);
  });

  test('a fetch that finishes AFTER a disconnect cannot bring the data back', async () => {
    const siteId = await withData('late');
    await deletePosthogConnection(siteId);
    await upsertPosthogDay(siteId, dayRow);
    assert.equal(await daysOf(siteId), 0);
  });

  test('the switch is atomic: if the connection update fails after the days were cleared, NOTHING changes', async () => {
    const siteId = await withData('atomic');
    // Make the database refuse the UPDATE (which runs AFTER the old days are deleted inside the same transaction).
    const fn = `ph_atomic_fn_${siteId}`;
    await query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.site_id = ${siteId} AND NEW.project_id = '9999' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON project_posthog_connections FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await assert.rejects(() => selectOauthProject(siteId, { projectId: '9999', projectName: 'B' }), /simulated failure/);
    } finally {
      await query(`DROP TRIGGER IF EXISTS ${fn} ON project_posthog_connections`);
      await query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    assert.equal((await getPosthogConnection(siteId)).project_id, '4521', 'still the old project');
    assert.equal(await daysOf(siteId), 1, 'and its days were not lost');
  });
});

describe('a pasted key can only point at a safe address (real DB)', () => {
  test('http is refused by the store itself', async () => {
    const siteId = await makeSite('http');
    await assert.rejects(() => savePosthogConnection(siteId, { projectId: '1', host: 'http://ph.example.com', apiKey: 'k' }), /https/);
    assert.equal(await getPosthogConnection(siteId), null);
  });
});

describe('only a failure about the connection marks it (real DB)', () => {
  test('permanent reasons mark it as an error; transient ones leave the status exactly as it was', async () => {
    const siteId = await makeSite('failure');
    await signIn(siteId); await selectOauthProject(siteId, { projectId: '1', projectName: 'A' }); await recordPosthogStatus(siteId, true);
    for (const reason of ['unreachable', 'failed', 'not_connected', undefined]) {
      assert.equal(await recordPosthogFailure(siteId, reason, 'x'), false, String(reason));
      assert.equal((await getPosthogConnection(siteId)).status, 'ok');
      assert.ok((await listPosthogConnectedSites()).some((r) => r.id === siteId), 'still part of tomorrow\'s run');
    }
    assert.deepEqual(['unauthorized', 'project_not_found', 'bad_host'].map(isPermanentPosthogFailure), [true, true, true]);
    assert.equal(await recordPosthogFailure(siteId, 'project_not_found', 'PostHog has no project 1.'), true);
    const c = await getPosthogConnection(siteId);
    assert.deepEqual([c.status, c.status_error], ['error', 'PostHog has no project 1.']);
    assert.ok(!(await listPosthogConnectedSites()).some((r) => r.id === siteId), 'a real error pauses it until reconnected');
  });
});
