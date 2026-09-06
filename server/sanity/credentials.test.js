// THE security property of this module: a site never resolves to another
// site's Sanity token, and never falls back to a shared one.
//
// Modelled on server/github/credentials.test.js, which marks its own
// tenant-isolation assertion the same way. The rule here is deliberately
// stricter than the GitHub side's: github_pat_env_var defaults to a shared
// 'GITHUB_PAT', which migration 106 documents as a known scaling problem,
// whereas a Sanity token is scoped to one project and dataset — so a shared
// default wouldn't merely be untidy, it would be a token for a different
// tenant's content.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sanityTokenEnvVar, siteHasSanityWriteCapability, resolveSanityToken, describeSanityCredentialGap } from './credentials.js';

const TENANT_A = { id: 1, sanity_write_token_env_var: 'SANITY_TOKEN_TENANT_A' };
const TENANT_B = { id: 2, sanity_write_token_env_var: 'SANITY_TOKEN_TENANT_B' };
const UNCONFIGURED = { id: 3, sanity_write_token_env_var: null };

const SAVED = {};
const KEYS = ['SANITY_TOKEN_TENANT_A', 'SANITY_TOKEN_TENANT_B', 'SANITY_WRITE_TOKEN', 'SANITY_TOKEN'];

beforeEach(() => {
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
});

describe('tenant isolation', () => {
  test('each site resolves ONLY the token its own column names', async () => {
    process.env.SANITY_TOKEN_TENANT_A = 'token-a';
    process.env.SANITY_TOKEN_TENANT_B = 'token-b';
    assert.equal(await resolveSanityToken(TENANT_A), 'token-a');
    assert.equal(await resolveSanityToken(TENANT_B), 'token-b');
  });

  test("a site whose own env var is unset resolves null — never the other tenant's token, even when that one IS set", async () => {
    // THE security property. Tenant B is fully configured; Tenant A is not.
    // A must come back empty rather than borrowing anything.
    process.env.SANITY_TOKEN_TENANT_B = 'token-b';
    assert.equal(await resolveSanityToken(TENANT_A), null);
  });

  test('an unconfigured site never falls back to a plausible shared env var', async () => {
    // These are the names a fallback would most plausibly reach for. None of
    // them may be consulted: there is no default, by design.
    process.env.SANITY_WRITE_TOKEN = 'shared-token';
    process.env.SANITY_TOKEN = 'another-shared-token';
    assert.equal(await resolveSanityToken(UNCONFIGURED), null);
    assert.equal(sanityTokenEnvVar(UNCONFIGURED), null);
  });

  test('a null/undefined site resolves null rather than throwing', async () => {
    assert.equal(await resolveSanityToken(null), null);
    assert.equal(await resolveSanityToken(undefined), null);
    assert.equal(sanityTokenEnvVar(null), null);
  });
});

describe('capability reporting', () => {
  test('capability tracks configuration, not whether the env var happens to be set', () => {
    // Deliberate: "configured but the variable is missing here" is a deploy
    // mistake worth naming separately from "this site has no Sanity at all".
    assert.equal(siteHasSanityWriteCapability(TENANT_A), true);
    assert.equal(siteHasSanityWriteCapability(UNCONFIGURED), false);
  });
});

describe('failure descriptions distinguish the two ways a credential goes missing', () => {
  test('unconfigured site reports sanity-not-configured', async () => {
    const gap = await describeSanityCredentialGap(UNCONFIGURED);
    assert.equal(gap.reason, 'sanity-not-configured');
  });

  test('configured site with an unset env var reports sanity-credential-missing, and names the variable', async () => {
    const gap = await describeSanityCredentialGap(TENANT_A);
    assert.equal(gap.reason, 'sanity-credential-missing');
    assert.match(gap.error, /SANITY_TOKEN_TENANT_A/);
  });

  test('a fully resolvable site reports no gap', async () => {
    process.env.SANITY_TOKEN_TENANT_A = 'token-a';
    assert.equal(await describeSanityCredentialGap(TENANT_A), null);
  });

  test('no failure message ever contains the token value itself', async () => {
    process.env.SANITY_TOKEN_TENANT_B = 'super-secret-value';
    const gap = await describeSanityCredentialGap(TENANT_A);
    assert.ok(!JSON.stringify(gap).includes('super-secret-value'));
  });
});
