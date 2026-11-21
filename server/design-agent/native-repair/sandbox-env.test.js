import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxEnv, SANDBOX_ENV_ALLOWLIST, createSandbox, destroySandbox, runSandboxCommand } from './sandbox.js';

const SECRETS = { DATABASE_URL: 'postgres://prod:secret@db.prod/app', OPENAI_API_KEY: 'sk-live', ANTHROPIC_API_KEY: 'sk-ant', GITHUB_TOKEN: 'ghp_x', SESSION_SECRET: 's', AWS_SECRET_ACCESS_KEY: 'a' };

test('a sandbox command gets ONLY the allowlisted environment — never the server\'s secrets', () => {
  const env = buildSandboxEnv({ PATH: '/usr/bin', LANG: 'en', ...SECRETS }, '/sbx');
  for (const k of Object.keys(SECRETS)) if (k !== 'DATABASE_URL') assert.equal(env[k], undefined, k);
  assert.equal(env.PATH, '/usr/bin');
  assert.deepEqual(Object.keys(env).filter((k) => !SANDBOX_ENV_ALLOWLIST.includes(k)).sort(), ['DATABASE_URL', 'HOME', 'NODE_ENV', 'TMPDIR', 'npm_config_cache']);
});

test('DATABASE_URL is replaced by the fixed local test URL, never passed through', () => {
  const env = buildSandboxEnv({ DATABASE_URL: 'postgres://prod:secret@db.prod/app' }, '/sbx');
  assert.equal(env.DATABASE_URL, 'postgres://test:test@localhost:5432/test');
});

test('HOME, TMPDIR and the npm cache are inside the sandbox directory', () => {
  const env = buildSandboxEnv({}, '/sbx/work');
  assert.equal(env.HOME, '/sbx/work');
  assert.equal(env.TMPDIR, '/sbx/work');
  assert.equal(env.npm_config_cache, '/sbx/work/.npm-cache');
});

test('NODE_TEST_CONTEXT is not forwarded (it makes a nested node --test silently pass)', () => {
  assert.equal(buildSandboxEnv({ NODE_TEST_CONTEXT: 'child' }, '/s').NODE_TEST_CONTEXT, undefined);
});

test('a real command inside a sandbox cannot see the secrets of the process that launched it', async () => {
  const sandbox = await createSandbox();
  try {
    Object.assign(process.env, { OPENAI_API_KEY: 'sk-should-not-leak', GITHUB_TOKEN: 'ghp_should_not_leak' });
    const r = await runSandboxCommand(sandbox, 'node', ['-e', 'console.log(JSON.stringify({k: process.env.OPENAI_API_KEY ?? null, g: process.env.GITHUB_TOKEN ?? null, d: process.env.DATABASE_URL}))'], { allowlist: ['node'] });
    assert.equal(r.ok, true);
    const seen = JSON.parse(r.output.trim());
    assert.equal(seen.k, null);
    assert.equal(seen.g, null);
    assert.equal(seen.d, 'postgres://test:test@localhost:5432/test');
  } finally {
    delete process.env.OPENAI_API_KEY; delete process.env.GITHUB_TOKEN;
    await destroySandbox(sandbox);
  }
});
