// Manual, one-off validation script for Step 6D/real-Docker verification of
// the Design Agent worker. NOT part of `npm test` (that suite stays fully
// stubbed, no Docker/API key needed — see server/design-agent/
// openhands-handler.test.js). This script is meant to be run BY HAND, once,
// on a host that actually has a working Docker daemon (e.g. the staging
// VPS) — this dev machine doesn't have one, which is why this exists as a
// script instead of being run directly.
//
// Usage (from the analytics repo root, on a host with Docker + this repo's
// .env, i.e. OPENAI_API_KEY, DATABASE_URL already configured):
//   node server/scripts/verify-design-agent-docker.js
//
// What it does, in order:
//   1. Confirms `docker version` works.
//   2. Confirms the OpenHands agent-server image is present, pulling it if
//      not (untimed — a first pull can be several GB).
//   3. Runs design_task.py directly (bypassing the Node worker) against a
//      script-owned, retained temp copy of the checked-in fixture, so the
//      edited files can be diffed and inspected before being deleted here —
//      proves the real container started, OpenHands really edited the
//      fixture, and the container is gone afterward.
//   4. Creates ONE disposable site + recommendation + design_generate job
//      row, then runs it through the real, unmodified production path
//      (server/design-agent/worker.js's processOneJob +
//      server/design-agent/openhands-handler.js's createOpenHandsHandler,
//      no stubs) — proves the actual worker code (not just design_task.py
//      directly) claims the job, runs it for real, and marks it completed.
//   5. Cleans up every temp directory and every DB row this script created,
//      in a `finally`, whether or not anything above failed.
//
// The checked-in fixture (server/design-agent/fixtures/test-site/) is never
// modified — every run works against its own throwaway copy. No customer
// repository, GitHub branch, PR, credential, or existing implementer flow
// is touched anywhere in this script.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const FIXTURE_DIR = join(repoRoot, 'server', 'design-agent', 'fixtures', 'test-site');
const PYTHON_BIN = join(repoRoot, 'server', 'design-agent', 'python', '.venv', 'bin', 'python3');
const SCRIPT_PATH = join(repoRoot, 'server', 'design-agent', 'python', 'design_task.py');
const DOCKER_IMAGE = process.env.DESIGN_AGENT_DOCKER_IMAGE || 'ghcr.io/openhands/agent-server:latest-python';
const RESULT_PREFIX = 'DESIGN_AGENT_RESULT: ';
const CONTAINER_PREFIX = 'DESIGN_AGENT_CONTAINER: ';

const results = []; // { name, pass, detail }
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}

function parseLastPrefixed(stdout, prefix) {
  const lines = stdout.split('\n').filter((l) => l.startsWith(prefix));
  const last = lines[lines.length - 1];
  if (!last) return null;
  try { return JSON.parse(last.slice(prefix.length)); } catch { return null; }
}

async function step1_dockerReachable() {
  console.log('\n=== Step 1: docker version ===');
  const { stdout } = await execFileAsync('docker', ['version']);
  console.log(stdout.trim());
  record('docker daemon reachable', true);
}

async function step2_imageAvailable() {
  console.log('\n=== Step 2: OpenHands agent-server image ===');
  try {
    await execFileAsync('docker', ['image', 'inspect', DOCKER_IMAGE]);
    record('image already present locally', true, DOCKER_IMAGE);
    return;
  } catch {
    console.log(`Image not cached locally — pulling ${DOCKER_IMAGE} (this can take a while on first run)...`);
  }
  await new Promise((resolve, reject) => {
    const child = execFile('docker', ['pull', DOCKER_IMAGE], { maxBuffer: 50 * 1024 * 1024 });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker pull exited ${code}`))));
  });
  record('image pulled successfully', true, DOCKER_IMAGE);
}

// Direct design_task.py run against a script-owned temp dir (not through
// the Node worker) so the edited files can be inspected before cleanup —
// same technique used to verify the real OpenHands edit in Step 6C.
async function step3_directRunAndDiff() {
  console.log('\n=== Step 3: direct design_task.py run (file-diff verification) ===');
  const dir = await mkdtemp(join(tmpdir(), 'design-agent-verify-'));
  let containerId = null;
  try {
    await cp(FIXTURE_DIR, dir, { recursive: true });

    const env = {
      ...process.env,
      LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
      LLM_API_KEY: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
      OPENHANDS_SUPPRESS_BANNER: '1',
    };
    if (!env.LLM_API_KEY) {
      record('LLM API key present', false, 'set OPENAI_API_KEY (or LLM_API_KEY) in .env before running this script');
      throw new Error('missing LLM_API_KEY/OPENAI_API_KEY');
    }

    const { stdout } = await execFileAsync(PYTHON_BIN, [SCRIPT_PATH, dir], {
      env, timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024,
    });
    console.log(stdout);

    const containerMsg = parseLastPrefixed(stdout, CONTAINER_PREFIX);
    containerId = containerMsg?.container_id || null;
    record('real container id reported', Boolean(containerId), containerId || 'none');

    const result = parseLastPrefixed(stdout, RESULT_PREFIX);
    record('design_task.py reported status:"ok"', result?.status === 'ok', JSON.stringify(result));

    const editedAboutHtml = readFileSync(join(dir, 'about.html'), 'utf8');
    const originalAboutHtml = readFileSync(join(FIXTURE_DIR, 'about.html'), 'utf8');
    const wasEdited = editedAboutHtml !== originalAboutHtml && /contact/i.test(editedAboutHtml);
    record('about.html was actually edited (Contact section present)', wasEdited);
    if (wasEdited) {
      console.log('--- about.html diff (added lines only) ---');
      console.log(editedAboutHtml.split('\n').filter((l) => !originalAboutHtml.includes(l)).join('\n'));
    }

    const indexUnchanged = readFileSync(join(dir, 'index.html'), 'utf8') === readFileSync(join(FIXTURE_DIR, 'index.html'), 'utf8');
    record('index.html left untouched, as instructed', indexUnchanged);

    const checkedInFixtureUntouched = readFileSync(join(FIXTURE_DIR, 'about.html'), 'utf8') === originalAboutHtml;
    record('checked-in fixture itself was never modified', checkedInFixtureUntouched);
  } finally {
    if (containerId) {
      try {
        const { stdout } = await execFileAsync('docker', ['ps', '-a', '-q', '--filter', `id=${containerId}`]);
        record('container is gone after the run (design_task.py\'s own cleanup)', stdout.trim() === '', stdout.trim() || '(none found — good)');
      } catch (err) {
        record('post-run container-gone check', false, err.message);
      }
    }
    await rm(dir, { recursive: true, force: true });
    record('script-owned temp workspace removed', !existsSync(dir));
  }
}

// Exercises the real, unmodified production path: worker.js's
// processOneJob() + openhands-handler.js's createOpenHandsHandler(), no
// stubs — a disposable DB job claimed and run for real.
async function step4_fullPipelineRun() {
  console.log('\n=== Step 4: real worker/handler pipeline run ===');
  const { query, pool } = await import(join(repoRoot, 'server', 'db.js'));
  const { createDesignAgentJob } = await import(join(repoRoot, 'server', 'store', 'execution-jobs.js'));
  const { processOneJob } = await import(join(repoRoot, 'server', 'design-agent', 'worker.js'));
  const { createOpenHandsHandler } = await import(join(repoRoot, 'server', 'design-agent', 'openhands-handler.js'));

  let siteId = null;
  try {
    const site = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
       VALUES ('verify-design-agent-docker.js fixture', $1, $1, 'UTC') RETURNING id`,
      [`verify-design-agent-docker-${Date.now()}`]
    );
    siteId = site.rows[0].id;
    const rec = await query(
      `INSERT INTO recommendations (site_id, page, recommendation_type, issue, params, finding_ids, detecting_agents, risk_tier)
       VALUES ($1, '/about', 'meta-title', 'real docker e2e verify', '{}', '{}', '{}', 'manual') RETURNING id`,
      [siteId]
    );
    const job = await createDesignAgentJob(siteId, rec.rows[0].id, {});
    console.log(`Created disposable design_generate job ${job.id} (status: ${job.status})`);

    const result = await processOneJob({ handler: createOpenHandsHandler({ timeoutMs: 10 * 60 * 1000 }) });
    record('processOneJob claimed and settled the job', Boolean(result), JSON.stringify(result));

    const { rows } = await query('SELECT status, started_at, finished_at, duration_ms FROM execution_jobs WHERE id = $1', [job.id]);
    const finalRow = rows[0];
    console.log('final DB row:', JSON.stringify(finalRow, null, 2));
    record('job reached status = completed', finalRow?.status === 'completed', finalRow?.status);
    record('duration_ms recorded', Number.isFinite(finalRow?.duration_ms) && finalRow.duration_ms > 0, String(finalRow?.duration_ms));
  } finally {
    if (siteId) {
      await query('DELETE FROM execution_jobs WHERE site_id = $1', [siteId]);
      await query('DELETE FROM recommendations WHERE site_id = $1', [siteId]);
      await query('DELETE FROM sites WHERE id = $1', [siteId]);
      const { rows } = await query('SELECT id FROM sites WHERE id = $1', [siteId]);
      record('disposable DB rows cleaned up', rows.length === 0);
    }
    await pool.end();
  }
}

async function main() {
  console.log(`Design Agent real-Docker/OpenHands validation — ${new Date().toISOString()}`);
  try {
    await step1_dockerReachable();
    await step2_imageAvailable();
    await step3_directRunAndDiff();
    await step4_fullPipelineRun();
  } catch (err) {
    console.error('\nFATAL — validation aborted:', err.message);
    record('validation completed without a fatal error', false, err.message);
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  const allPassed = results.length > 0 && results.every((r) => r.pass);
  console.log(`\n${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} (${results.filter((r) => r.pass).length}/${results.length})`);
  process.exit(allPassed ? 0 : 1);
}

main();
