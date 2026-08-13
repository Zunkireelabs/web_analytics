// Manual, one-off, STRICTLY READ-ONLY validation script for the new
// componentTemplates integration (real repo checkout -> real OpenHands/
// Docker analysis -> proposal -> validation). Run BY HAND, once, on a host
// with a working Docker daemon (this dev machine doesn't — see
// server/scripts/verify-design-agent-docker.js's own header for that same
// constraint). Targets site #1 (Zunkiree Labs / Zunkireelabs/zunkireelabs-web)
// — the only site in this DB with a real repo connected — with explicit
// safety rails:
//
//   - design_agent_enabled is flipped on ONLY for the duration of this
//     script (a single, narrowly-scoped `UPDATE sites SET
//     design_agent_enabled = ...` — no other column, no updateSiteRepoConfig
//     call, nothing else about the site's config is ever touched) and
//     restored to its exact original value in `finally`, whether this script
//     succeeds or throws.
//   - This script NEVER imports or calls confirmComponentTemplate-equivalent
//     code (updateSiteRepoConfig for componentTemplates), backend.js/
//     frontend.js's apply(), mergeToStage(), or anything in
//     server/implementers/lib/github-ops.js — structurally, not just by
//     convention: none of those modules are even imported here. Nothing
//     this script does can create a branch, a commit, or a PR.
//   - The real repo checkout (repo-checkout.js/getRepoTarball) is a read-only
//     GitHub API download (no write scope needed beyond what the existing
//     PAT already has for the read-only Contents/tarball endpoints this app
//     already uses elsewhere).
//   - The only DB write beyond the design_agent_enabled toggle is creating
//     (and, in `finally`, deleting) ONE execution_jobs row for this run —
//     never a blanket delete scoped by site_id (site #1 has real, unrelated
//     rows this script must never touch).
//
// Usage: node server/scripts/verify-component-templates-real-repo.js

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query, pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { createComponentTemplateJob } from '../store/execution-jobs.js';
import { processOneJob } from '../design-agent/worker.js';
import { createDesignAgentHandler } from '../design-agent/openhands-handler.js';
import { validatePlaceholders, checkTemplateFreshness } from '../implementers/lib/design-drift.js';

const execFileAsync = promisify(execFile);

const SITE_ID = 1; // Zunkiree Labs / Zunkireelabs/zunkireelabs-web — the only real-repo-connected site in this DB
const COMPONENT_KEYS = ['faq', 'expand-content', 'internal-links'];
const LIVE_PAGE_URL = 'https://zunkireelabs.com/';
const DOCKER_IMAGE = process.env.DESIGN_AGENT_DOCKER_IMAGE || 'ghcr.io/openhands/agent-server:latest-python';

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}

async function checkDockerAndImage() {
  await execFileAsync('docker', ['version']);
  record('docker daemon reachable', true);
  try {
    await execFileAsync('docker', ['image', 'inspect', DOCKER_IMAGE]);
    record('OpenHands agent-server image present locally', true, DOCKER_IMAGE);
  } catch {
    console.log(`Image not cached locally — pulling ${DOCKER_IMAGE} (can take a while)...`);
    await new Promise((resolve, reject) => {
      const child = execFile('docker', ['pull', DOCKER_IMAGE], { maxBuffer: 50 * 1024 * 1024 });
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker pull exited ${code}`))));
    });
    record('OpenHands agent-server image pulled', true, DOCKER_IMAGE);
  }
}

async function main() {
  console.log(`componentTemplates real-repo validation — ${new Date().toISOString()}`);
  console.log(`Target: site #${SITE_ID}, componentKeys=${JSON.stringify(COMPONENT_KEYS)}`);
  console.log('This run is READ-ONLY: no url_file_map write, no branch/commit/PR — see this file\'s header.\n');

  const siteBefore = await getSiteById(SITE_ID);
  if (!siteBefore) throw new Error(`Site #${SITE_ID} not found.`);
  if (!siteBefore.repo_owner || !siteBefore.repo_name) throw new Error(`Site #${SITE_ID} has no repo_owner/repo_name configured.`);
  const originalDesignAgentEnabled = siteBefore.design_agent_enabled;
  console.log(`Site: ${siteBefore.name} (${siteBefore.repo_owner}/${siteBefore.repo_name}) — design_agent_enabled currently ${originalDesignAgentEnabled}`);

  let jobId = null;
  try {
    await checkDockerAndImage();

    // The ONLY site-config write this script makes, and the ONLY column it
    // touches — restored in `finally` below no matter what happens next.
    await query('UPDATE sites SET design_agent_enabled = true WHERE id = $1', [SITE_ID]);
    record('design_agent_enabled temporarily set to true', true);

    const job = await createComponentTemplateJob(SITE_ID, COMPONENT_KEYS, { requestedBy: null, pageUrl: LIVE_PAGE_URL });
    jobId = job.id;
    console.log(`Created disposable design_generate job ${job.id} (status: ${job.status})`);

    const outcome = await processOneJob({ handler: createDesignAgentHandler({ timeoutMs: 15 * 60 * 1000 }) });
    record('processOneJob claimed and settled the job', outcome?.jobId === job.id, JSON.stringify({ status: outcome?.status }));

    const { rows } = await query('SELECT status, params, result, duration_ms FROM execution_jobs WHERE id = $1', [job.id]);
    const finalRow = rows[0];
    record('job reached status = completed', finalRow?.status === 'completed', finalRow?.status);
    console.log(`duration_ms: ${finalRow?.duration_ms}`);

    const componentTemplates = finalRow?.result?.componentTemplates || {};
    record('agent reported at least one componentTemplates entry', Object.keys(componentTemplates).length > 0, JSON.stringify(Object.keys(componentTemplates)));

    // Same two checks resolveOrCreateComponentTemplate itself applies in
    // production (design-drift.js) — validatePlaceholders is the hard
    // reject, checkTemplateFreshness against the real live page is
    // informational only here (missingClasses reported, never blocks),
    // matching that function's own fail-open discipline on freshness.
    for (const actionType of COMPONENT_KEYS) {
      const template = componentTemplates[actionType];
      if (!template) { record(`proposal for "${actionType}"`, false, 'not reported by the agent'); continue; }

      const placeholderCheck = validatePlaceholders(actionType, template);
      if (!placeholderCheck.ok) { record(`proposal for "${actionType}" passes validation (placeholders + real-class check)`, false, placeholderCheck.error); continue; }

      const freshness = await checkTemplateFreshness({ pageUrl: LIVE_PAGE_URL, templateEntry: template });
      const missingClasses = freshness.ok ? freshness.missingClasses || [] : [];
      record(`proposal for "${actionType}" passes validation (placeholders + real-class check)`, true, `missingClasses=${JSON.stringify(missingClasses)}`);
      console.log(`\n--- proposed "${actionType}" template ---`);
      console.log(JSON.stringify(template, null, 2));
    }
  } finally {
    if (jobId) {
      await query('DELETE FROM execution_jobs WHERE id = $1', [jobId]);
      record('disposable job row deleted', true, `id=${jobId}`);
    }
    await query('UPDATE sites SET design_agent_enabled = $1 WHERE id = $2', [originalDesignAgentEnabled, SITE_ID]);
    const { rows } = await query('SELECT design_agent_enabled FROM sites WHERE id = $1', [SITE_ID]);
    record('design_agent_enabled restored to its original value', rows[0]?.design_agent_enabled === originalDesignAgentEnabled, `now ${rows[0]?.design_agent_enabled}`);
    await pool.end();
  }
}

main()
  .then(() => {
    console.log('\n=== SUMMARY ===');
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
    const allPassed = results.length > 0 && results.every((r) => r.pass);
    console.log(`\n${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} (${results.filter((r) => r.pass).length}/${results.length})`);
    process.exit(allPassed ? 0 : 1);
  })
  .catch((err) => {
    console.error('\nFATAL — validation aborted:', err.message);
    console.log('\n=== SUMMARY ===');
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
    process.exit(1);
  });
