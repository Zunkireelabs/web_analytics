import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createAppJwt, appConfigured, getInstallationToken, clearInstallationTokenCache } from './app-auth.js';

// A real RSA pair, so the JWT below is verified by actually checking its
// signature rather than by asserting on the shape of a string.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

const saved = {};
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  clearInstallationTokenCache();
  setEnv({
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(PEM).toString('base64'),
    GITHUB_APP_PRIVATE_KEY: null,
  });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function decode(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('createAppJwt', () => {
  test('produces a JWT whose signature actually verifies against the App key', () => {
    const jwt = createAppJwt(Date.now());
    const [header, payload, signature] = jwt.split('.');

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
    assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  });

  test('is issued by the App and lives inside GitHub\'s 10-minute ceiling', () => {
    const now = 1_760_000_000_000;
    const { iat, exp, iss } = decode(createAppJwt(now).split('.')[1]);

    assert.equal(iss, '123456');
    // Backdated to absorb clock drift — GitHub rejects a future iat outright.
    assert.ok(iat < Math.floor(now / 1000), 'iat must be backdated');
    assert.ok(exp - iat <= 600, 'GitHub rejects an App JWT living longer than 10 minutes');
    assert.ok(exp > Math.floor(now / 1000), 'must not be born expired');
  });

  test('accepts a raw PEM too, for local development', () => {
    setEnv({ GITHUB_APP_PRIVATE_KEY_B64: null, GITHUB_APP_PRIVATE_KEY: PEM });
    assert.ok(createAppJwt().split('.').length === 3);
  });

  test('says what is missing rather than failing obscurely', () => {
    setEnv({ GITHUB_APP_ID: null });
    assert.throws(() => createAppJwt(), /GITHUB_APP_ID/);
  });
});

describe('appConfigured', () => {
  test('is false unless both the id and a key are present', () => {
    assert.equal(appConfigured(), true);
    setEnv({ GITHUB_APP_ID: null });
    assert.equal(appConfigured(), false);
    setEnv({ GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY_B64: null });
    assert.equal(appConfigured(), false);
  });
});

describe('getInstallationToken', () => {
  function fakeGitHub({ token = 'ghs_installation_token', expiresInMs = 3600_000, status = 201, calls = [] } = {}) {
    return async (url, opts) => {
      calls.push({ url, auth: opts.headers.Authorization });
      if (status !== 201) return { ok: false, status, json: async () => ({}) };
      return {
        ok: true, status,
        json: async () => ({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }),
      };
    };
  }

  test('mints a token for the right installation, authenticating as the App', async () => {
    const calls = [];
    const t = await getInstallationToken(42, { fetchImpl: fakeGitHub({ calls }) });

    assert.equal(t, 'ghs_installation_token');
    assert.match(calls[0].url, /\/app\/installations\/42\/access_tokens$/);
    assert.match(calls[0].auth, /^Bearer /, 'the mint call authenticates with the App JWT, not a token');
  });

  test('caches, so one token is not minted per API call', async () => {
    const calls = [];
    const impl = fakeGitHub({ calls });
    await getInstallationToken(42, { fetchImpl: impl });
    await getInstallationToken(42, { fetchImpl: impl });

    assert.equal(calls.length, 1);
  });

  // The cache is keyed per installation because a shared one would be a
  // cross-tenant credential leak, not merely a performance bug.
  test('never hands one installation another installation\'s token', async () => {
    const calls = [];
    await getInstallationToken(42, { fetchImpl: fakeGitHub({ token: 'ghs_tenant_a', calls }) });
    const b = await getInstallationToken(99, { fetchImpl: fakeGitHub({ token: 'ghs_tenant_b', calls }) });

    assert.equal(b, 'ghs_tenant_b');
    assert.equal(calls.length, 2, 'a second installation must mint its own token');
  });

  test('re-mints when the cached token is close to expiry', async () => {
    const calls = [];
    // 5 minutes left is inside the refresh margin — using it risks expiring
    // mid-request.
    await getInstallationToken(42, { fetchImpl: fakeGitHub({ expiresInMs: 5 * 60_000, calls }) });
    await getInstallationToken(42, { fetchImpl: fakeGitHub({ calls }) });

    assert.equal(calls.length, 2);
  });

  test('reports a refusal by status only, without echoing the response body', async () => {
    await assert.rejects(
      getInstallationToken(42, { fetchImpl: fakeGitHub({ status: 404 }) }),
      (err) => {
        assert.match(err.message, /HTTP 404/);
        assert.match(err.message, /installation 42/);
        return true;
      },
    );
  });

  test('requires an installation id', async () => {
    await assert.rejects(getInstallationToken(null), /installation id is required/i);
  });
});
