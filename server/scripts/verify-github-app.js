#!/usr/bin/env node
// Proves a GitHub App installation actually works, before a client depends on it.
//
// The App credential path (server/github/app-auth.js) is thoroughly unit-tested
// — including verifying a real RS256 signature against a generated key pair —
// but unit tests cannot tell you whether the App you registered has the right
// permissions, whether the client installed it on the right repository, or
// whether the private key survived base64-encoding into your deploy. Those are
// exactly the things that go wrong the first time, and the first time is
// usually a client's onboarding call.
//
// So this runs the real chain against real GitHub, in the same order the
// autonomous loop does, and says which step broke:
//   1. Is the App configured at all (id + private key present and parseable)?
//   2. Can we sign an App JWT and does GitHub accept it? (proves the key matches
//      the App, the single most common misconfiguration)
//   3. Does the installation exist, and what repositories does it cover?
//   4. Can we mint an installation token for it?
//   5. Does that token actually reach the site's configured repo, with the
//      Contents and Pull requests access the Action Center needs?
//
// Read-only. Nothing is created, pushed, or modified.
//
// Usage:
//   node server/scripts/verify-github-app.js --site-id 2
//   node server/scripts/verify-github-app.js --installation-id 12345678

import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { appConfigured, createAppJwt, getInstallationToken } from '../github/app-auth.js';
import { usesGithubApp } from '../github/credentials.js';
import { pool } from '../db.js';

const API_BASE = 'https://api.github.com';
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) flags[argv[i].replace(/^--/, '')] = argv[i + 1];
  return flags;
}

async function gh(path, token, { asApp = false } = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `${asApp ? 'Bearer' : 'token'} ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  let installationId = flags['installation-id'] ? Number(flags['installation-id']) : null;
  let site = null;

  if (flags['site-id']) {
    site = await getSiteById(Number(flags['site-id']));
    if (!site) throw new Error(`No site #${flags['site-id']}`);
    if (!usesGithubApp(site)) {
      console.log(`\nSite #${site.id} "${site.name}" has no github_app_installation_id — it uses the PAT named by ${site.github_pat_env_var || 'GITHUB_PAT'}.`);
      console.log('Set one with:  npm run connect-repo -- --site-id ' + site.id + ' --github-app-installation-id <id>\n');
      return;
    }
    installationId = Number(site.github_app_installation_id);
  }

  if (!installationId) {
    throw new Error('Pass --site-id <id> or --installation-id <id>.');
  }

  console.log(`\nVerifying GitHub App installation ${installationId}${site ? ` for site #${site.id} "${site.name}"` : ''}\n`);
  let failed = false;

  // 1 — configuration
  if (!appConfigured()) {
    bad('GITHUB_APP_ID and/or the private key are not set.');
    info('Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_B64 (base64 of the .pem GitHub gave you):');
    info("  base64 -i your-app.private-key.pem | tr -d '\\n'");
    return process.exitCode = 1;
  }
  ok(`App configured (id ${process.env.GITHUB_APP_ID})`);

  // 2 — the key genuinely belongs to that App. This is the step that catches a
  // mismatched or truncated key, and it fails confusingly everywhere else.
  let jwt;
  try {
    jwt = createAppJwt();
  } catch (err) {
    bad(`Could not sign an App JWT: ${err.message}`);
    info('The private key is likely malformed — check the base64 round-trips to a "-----BEGIN RSA PRIVATE KEY-----" block.');
    return process.exitCode = 1;
  }
  const appRes = await gh('/app', jwt, { asApp: true });
  if (!appRes.ok) {
    bad(`GitHub rejected the App JWT (HTTP ${appRes.status}).`);
    info(appRes.status === 401
      ? 'That means the private key does not match GITHUB_APP_ID. Re-check which App the key was generated from.'
      : 'Unexpected — re-run, and check the App still exists.');
    return process.exitCode = 1;
  }
  const app = await appRes.json();
  ok(`GitHub accepts the App JWT — authenticated as "${app.slug}"`);

  // 3 — the installation, and what it covers
  const instRes = await gh(`/app/installations/${installationId}`, jwt, { asApp: true });
  if (!instRes.ok) {
    bad(`Installation ${installationId} not found for this App (HTTP ${instRes.status}).`);
    info('Either the id is wrong, or the client installed a different App. The id appears in the URL after they install: /settings/installations/<id>');
    return process.exitCode = 1;
  }
  const inst = await instRes.json();
  ok(`Installation belongs to "${inst.account?.login}" (${inst.repository_selection} repositories)`);
  const perms = inst.permissions || {};
  for (const [need, label] of [['contents', 'Contents'], ['pull_requests', 'Pull requests']]) {
    if (perms[need] === 'write') ok(`${label}: write`);
    else { bad(`${label}: ${perms[need] || 'not granted'} — the Action Center needs write.`); failed = true; }
  }

  // 4 — minting
  let token;
  try {
    token = await getInstallationToken(installationId);
    ok('Minted an installation token');
  } catch (err) {
    bad(`Could not mint an installation token: ${err.message}`);
    return process.exitCode = 1;
  }

  // 5 — does it reach the repo the site is actually configured for
  if (site?.repo_owner && site?.repo_name) {
    const repo = `${site.repo_owner}/${site.repo_name}`;
    const repoRes = await gh(`/repos/${repo}`, token);
    if (repoRes.ok) {
      ok(`Token reaches ${repo}`);
    } else {
      bad(`Token cannot reach ${repo} (HTTP ${repoRes.status}).`);
      info('The App is installed, but not on this repository — ask the client to add it to the installation.');
      failed = true;
    }
  } else {
    info('(No repo configured on this site yet, so repo access was not checked.)');
  }

  console.log(failed
    ? '\nSome checks failed — this installation is not ready to ship PRs.\n'
    : '\nAll checks passed. This installation can open pull requests for this site.\n');
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => { console.error(`\nverify-github-app failed: ${err.message}\n`); process.exitCode = 1; })
  .finally(() => pool.end());
