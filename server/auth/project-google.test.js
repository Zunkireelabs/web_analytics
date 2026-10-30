import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

let rows = [];
let marked = [];
mock.module(resolve('../db.js'), { namedExports: { query: async () => ({ rows }) } });
mock.module(resolve('../lib/secret-box.js'), {
  namedExports: { decryptSecret: (v) => { if (v === 'BAD') throw new Error('bad key'); return `rt:${v}`; } },
});
mock.module(resolve('../integrations/google-connect.js'), { namedExports: { connectClientCreds: () => ({ id: 'id', secret: 'secret' }) } });
mock.module(resolve('../store/project-google.js'), {
  namedExports: { markGoogleConnectionStatus: async (siteId, status, _e, opts) => { marked.push([siteId, status, opts?.version ?? null]); } },
});

const { getProjectGoogleAuth, ProjectGoogleAuthError, forgetProjectGoogleAuth } = await import('./project-google.js');

beforeEach(() => { rows = []; marked = []; forgetProjectGoogleAuth(); });

test('no connection of its own -> null, so the shared path still applies', async () => {
  assert.equal(await getProjectGoogleAuth({ id: 1 }), null);
});

test('a healthy connection returns a client', async () => {
  rows = [{ refresh_token_enc: 'ok', status: 'ok' }];
  const client = await getProjectGoogleAuth({ id: 2 });
  assert.ok(client && typeof client.refreshTokenNoCache === 'function');
});

test('an expired connection throws a reconnect error, never null', async () => {
  rows = [{ refresh_token_enc: 'ok', status: 'expired', status_error: 'invalid_grant' }];
  await assert.rejects(() => getProjectGoogleAuth({ id: 3 }), (e) => e instanceof ProjectGoogleAuthError && e.code === 'GOOGLE_RECONNECT' && e.projectGoogle === true && e.userFacing === true);
});

test('a token that cannot be decrypted is marked unreadable and throws, not a silent fallback', async () => {
  rows = [{ refresh_token_enc: 'BAD', status: 'ok' }];
  await assert.rejects(() => getProjectGoogleAuth({ id: 4 }), ProjectGoogleAuthError);
  assert.deepEqual(marked, [[4, 'unreadable', null]]);
});

test('Google refusing the refresh token marks THAT project expired (tied to the connection version) and then throws a reconnect error', async () => {
  const { google } = await import('googleapis');
  const proto = google.auth.OAuth2.prototype;
  const original = proto.refreshTokenNoCache;
  // Make the library's own refresh fail the way Google does when access is revoked (no network).
  proto.refreshTokenNoCache = async () => { throw Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } }); };
  try {
    rows = [{ refresh_token_enc: 'ok', status: 'ok', updated_at: '2026-10-27T00:00:00Z' }];
    const client = await getProjectGoogleAuth({ id: 8 });
    await assert.rejects(() => client.refreshTokenNoCache('rt'), (e) => e instanceof ProjectGoogleAuthError && e.projectGoogle === true);
  } finally { proto.refreshTokenNoCache = original; }
  assert.deepEqual(marked, [[8, 'expired', '2026-10-27T00:00:00Z']]);
});

test("one project's dead connection does not affect another's", async () => {
  rows = [{ refresh_token_enc: 'ok', status: 'expired' }];
  await assert.rejects(() => getProjectGoogleAuth({ id: 5 }), ProjectGoogleAuthError);
  rows = [{ refresh_token_enc: 'ok', status: 'ok' }];
  assert.ok(await getProjectGoogleAuth({ id: 6 }));
});
