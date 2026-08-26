import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '../../db.js';
import { recordFixOutcome } from '../../agent-memory.js';
import { problemSignatureFor } from './learned-repair.js';
import { checkoutRepoTarball } from '../../design-agent/repo-checkout.js';
import { createNativeCodeSelfRepairHandler } from '../../design-agent/native-repair-handler.js';
import {
  getBranchSha, createBranch, commitFilesAtomic, openPullRequest, listOpenPullRequestsForBranch,
} from '../../github/client.js';

const execFileAsync = promisify(execFile);

// Platform self-repair for SHARED generator/implementer code bugs — the
// counterpart to learned-repair.js, which reuses/learns CONTENT fixes for a
// client's own site. A bug like js-data-splice.js's missing newline
// escaping does not live in any client's repository; it lives here, in
// this platform's own repo, so it needs its own branch/PR pipeline against
// THIS repo rather than any reuse of implementers/lib/github-ops.js (which
// is hard-wired to a `site`'s own repo/token). Everything client-facing —
// Action Center, learned-repair.js, the category != 'code' wall in
// agent-memory.js's findRelevantMemory/findPortableRepairs — is untouched;
// this module only ever reads/writes category:'code', scope:'repo',
// site_id: NULL rows, which were already structurally excluded from every
// client-facing path before this file existed.
//
// A platform repo descriptor deliberately shaped exactly like a `sites` row
// (repo_owner/repo_name/repo_default_branch) — every GitHub helper this
// module calls (checkoutRepoTarball, getBranchSha, createBranch,
// commitFilesAtomic, openPullRequest, listOpenPullRequestsForBranch) was
// already written generically against that shape for real site rows, so a
// constant descriptor is a drop-in, not a new integration.
export const PLATFORM_REPO = {
  repo_owner: process.env.PLATFORM_REPO_OWNER || 'Zunkireelabs',
  repo_name: process.env.PLATFORM_REPO_NAME || 'web_analytics',
  repo_default_branch: process.env.PLATFORM_REPO_BASE_BRANCH || 'stage',
};

// Off by default — this spends real Docker + LLM execution per escalation,
// unlike ordinary client content remediation, which stays fully unaffected
// by this flag either way (see auto-remediation.js's call site: this is an
// additional, independent hook, never a gate on the existing flow).
export function codeSelfRepairEnabled(env = process.env) {
  return env.ENABLE_CODE_SELF_REPAIR === 'true';
}

// A code bug isn't "the same reason happened on the same day" — it's "this
// keeps happening, on separate days, regardless of which site tripped it."
// Two distinct calendar days is the same bar auto-remediation.js's own
// generator_outcomes-derived signals already treat as "a real pattern, not
// noise" (see generator-learning.js's MIN_SAMPLES reasoning) — here scoped
// to `detail` instead of outcome ratio, since a stable reason/message is the
// actual repeat signal for a code bug.
const DISTINCT_DAY_THRESHOLD = 2;
// Within one escalation call, for a problem with no existing lesson at all
// yet: try investigating up to this many times before giving up and
// flagging it for a human — same "2" the existing recordReuseOutcome
// breaker already uses for a KNOWN lesson's repeat failures, kept identical
// so both paths converge on the same bounded-retry feel.
const MAX_FRESH_INVESTIGATION_ATTEMPTS = 2;

// `reasonKey` is whatever generator_outcomes.detail already holds for this
// (generator_id, outcome) — a short `err.reason` code for a refusal, or the
// existing free-text err.message for a genuine failure (see
// auto-remediation.js). Reusing learned-repair.js's own signature function
// with an empty tag list collapses to exactly `${generatorId}:${reasonKey}`
// — one shared signature convention across the content and code repair
// paths, not two.
export function codeProblemSignature(generatorId, reasonKey) {
  return problemSignatureFor(generatorId, [], reasonKey || 'unknown');
}

export async function countDistinctFailureDays(generatorId, reasonKey, { queryFn = query } = {}) {
  if (!generatorId || !reasonKey) return 0;
  const { rows } = await queryFn(
    `SELECT COUNT(DISTINCT (created_at AT TIME ZONE 'UTC')::date) AS days
     FROM generator_outcomes
     WHERE generator_id = $1 AND detail = $2 AND outcome IN ('failed', 'refused')
       AND created_at > now() - interval '30 days'`,
    [generatorId, reasonKey],
  );
  return Number(rows[0]?.days || 0);
}

// Any status, not just the reusable ones — a 'flagged_for_review' row must
// be found here too, specifically so maybeEscalateToCodeRepair can refuse
// to re-trigger a fresh investigation for it (see that function): once a
// problem has exhausted its bounded attempts, it stays visibly unresolved
// for a human, never silently retried forever.
async function lookupCodeLesson(generatorId, reasonKey, { queryFn = query } = {}) {
  const signature = codeProblemSignature(generatorId, reasonKey);
  const { rows } = await queryFn(
    `SELECT * FROM agent_fix_memory
     WHERE category = 'code' AND scope = 'repo' AND site_id IS NULL
       AND problem_signature = $1
     ORDER BY updated_at DESC LIMIT 1`,
    [signature],
  );
  return rows[0] || null;
}

function slugFor(generatorId, reasonKey) {
  const raw = `${generatorId || 'generator'}-${reasonKey || 'unknown'}`;
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'issue';
}

// Opens (or reuses, if one's already open for this exact branch) a real PR
// against PLATFORM_REPO's own base branch — never auto-merged, same human
// gate every Action Center PR already has, just a different repo/branch.
// Low-level github/client.js primitives directly, not
// implementers/lib/github-ops.js's pushDraftBranch/openPrForBranch: those
// are shaped around a client-content `draft` object (draft.action_type,
// draft.id in the commit message) that has no meaning for a platform code
// fix, and are hard-wired to open the PR into a `site`'s OWN default
// branch — exactly the branch this fix's files were checked out from, which
// here is deliberately `stage`, not `site.repo_default_branch`.
export async function openPlatformRepairPr({
  slug, title, body, files,
  getBranchShaFn = getBranchSha, createBranchFn = createBranch,
  commitFilesAtomicFn = commitFilesAtomic, openPullRequestFn = openPullRequest,
  listOpenPullRequestsForBranchFn = listOpenPullRequestsForBranch,
} = {}) {
  const branchName = `fix/self-repair-${slug}`;
  try {
    const existing = await listOpenPullRequestsForBranchFn(PLATFORM_REPO, branchName).catch(() => []);
    if (existing.length) {
      const pr = existing[0];
      return { ok: true, branchName, prNumber: pr.number, prUrl: pr.html_url, reused: true };
    }
    const baseSha = await getBranchShaFn(PLATFORM_REPO, PLATFORM_REPO.repo_default_branch);
    await createBranchFn(PLATFORM_REPO, branchName, baseSha);
    await commitFilesAtomicFn(PLATFORM_REPO, branchName, files, `Platform self-repair: ${title}`);
    const { number, url } = await openPullRequestFn(PLATFORM_REPO, { branch: branchName, title: `Platform self-repair: ${title}`, body });
    return { ok: true, branchName, prNumber: number, prUrl: url, reused: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function prBodyFor({ generatorId, reasonKey, occurrenceDays, errorMessage, rootCause, summary, testOutput, patch }) {
  return [
    `Automated platform self-repair for a generator/implementer bug that repeated on ${occurrenceDays} separate calendar days.`,
    '',
    `**Generator:** \`${generatorId}\``,
    `**Failure reason:** \`${reasonKey}\``,
    errorMessage ? `**Captured error:** ${errorMessage}` : null,
    summary ? `\n**Summary:** ${summary}` : null,
    rootCause ? `**Root cause:** ${rootCause}` : null,
    '',
    '**Validation:** the narrowest relevant test file was run independently of the repair agent\'s own report and passed.',
    testOutput ? `\n<details><summary>Test output</summary>\n\n\`\`\`\n${String(testOutput).slice(0, 4000)}\n\`\`\`\n</details>` : null,
    patch ? `\n<details><summary>Patch</summary>\n\n\`\`\`diff\n${String(patch).slice(0, 8000)}\n\`\`\`\n</details>` : null,
    '',
    'Never auto-merged — review the diff and merge into `' + PLATFORM_REPO.repo_default_branch + '` to ship the fix. '
      + 'A `agent_fix_memory` code lesson is recorded once this PR is opened, so the next occurrence of this exact '
      + 'failure (for ANY client) reuses this fix instead of triggering a fresh investigation.',
  ].filter(Boolean).join('\n');
}

async function runNodeTest(testFile, cwd, execFileFn = execFileAsync) {
  try {
    const { stdout } = await execFileFn('node', ['--test', testFile], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, output: String(err.stdout || err.message || '').slice(0, 4000) };
  }
}

// Parses the `diff --git a/<path> b/<path>` headers out of a stored unified
// diff to find which files it touches, so their real (post-patch) content
// can be read back off disk for commitFilesAtomic — the stored fix_pattern
// is for human review and for `patch` to apply, not itself the shape
// commitFilesAtomic needs.
function filePathsFromPatch(patchText) {
  const paths = new Set();
  const re = /^diff --git a\/(\S+) b\/(\S+)/gm;
  let m;
  while ((m = re.exec(patchText))) paths.add(m[2]);
  return [...paths];
}

// The KNOWN-ISSUE path (spec §3): a matching agent_fix_memory row already
// exists with a real stored patch. Re-applies it mechanically — no fresh
// LLM investigation — and still runs the same independent test validation
// before ever opening a PR. Falls through to a fresh investigation (returns
// { ok:false, reason:'patch-stale' }) if the stored patch no longer applies
// cleanly, rather than forcing an obsolete edit onto code that has since
// changed.
export async function applyKnownFix(lessonRow, {
  checkoutRepoTarballFn = checkoutRepoTarball, execFileFn = execFileAsync,
  openPlatformRepairPrFn = openPlatformRepairPr,
} = {}) {
  if (!lessonRow.fix_pattern) return { ok: false, reason: 'no-stored-patch' };
  const workspaceDir = await mkdtemp(join(tmpdir(), 'code-self-repair-'));
  try {
    await checkoutRepoTarballFn(PLATFORM_REPO, workspaceDir, { ref: PLATFORM_REPO.repo_default_branch });
    const patchPath = join(workspaceDir, '.self-repair.patch');
    await writeFile(patchPath, lessonRow.fix_pattern, 'utf8');
    try {
      await execFileFn('patch', ['-p1', '--dry-run', '-i', patchPath], { cwd: workspaceDir });
    } catch {
      return { ok: false, reason: 'patch-stale' };
    }
    try {
      await execFileFn('patch', ['-p1', '-i', patchPath], { cwd: workspaceDir });
    } catch (err) {
      return { ok: false, reason: 'patch-apply-failed', detail: String(err.message || '').slice(0, 500) };
    }

    const testFile = lessonRow.validation_rule_id;
    let testOutput = null;
    if (testFile) {
      const testResult = await runNodeTest(testFile, workspaceDir, execFileFn);
      testOutput = testResult.output;
      if (!testResult.ok) return { ok: false, reason: 'tests-failed', detail: testOutput };
    }

    const touchedPaths = filePathsFromPatch(lessonRow.fix_pattern);
    if (!touchedPaths.length) return { ok: false, reason: 'patch-unparseable' };
    const files = [];
    for (const p of touchedPaths) {
      files.push({ path: p, content: await readFile(join(workspaceDir, p), 'utf8') });
    }

    const pr = await openPlatformRepairPrFn({
      slug: slugFor(lessonRow.generator_id, null) + '-known',
      title: lessonRow.symptoms || `known fix for ${lessonRow.problem_signature}`,
      body: prBodyFor({
        generatorId: lessonRow.generator_id, reasonKey: lessonRow.problem_signature,
        occurrenceDays: DISTINCT_DAY_THRESHOLD, errorMessage: null,
        rootCause: lessonRow.root_cause, summary: 'Reapplied a previously learned fix for this exact platform bug.',
        testOutput, patch: lessonRow.fix_pattern,
      }),
      files,
    });
    if (!pr.ok) return { ok: false, reason: 'pr-open-failed', detail: pr.error };
    return { ok: true, prUrl: pr.prUrl, prNumber: pr.prNumber, branchName: pr.branchName };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

// The UNKNOWN-ISSUE path (spec §4): no usable lesson exists, so a real
// agent investigates the platform repo itself. codeSelfRepairHandlerFn
// defaults to the native (no Docker/OpenHands) handler
// (createNativeCodeSelfRepairHandler(), server/design-agent/
// native-repair-handler.js — a tool-use loop against a plain checkout,
// independently re-validated via node --check/--test, same safety
// contract the OpenHands path had) — tests inject a fake one.
export async function investigateAndRepair({ generatorId, reasonKey, errorMessage, occurrenceDays, testFileHint }, {
  codeSelfRepairHandlerFn = createNativeCodeSelfRepairHandler(),
  openPlatformRepairPrFn = openPlatformRepairPr,
} = {}) {
  let handlerResult;
  try {
    handlerResult = await codeSelfRepairHandlerFn({
      id: `${generatorId}:${reasonKey}`,
      repo: PLATFORM_REPO,
      generatorId, reason: reasonKey, errorMessage, occurrenceDays, testFileHint,
    });
  } catch (err) {
    // createOpenHandsHandler throws (never returns a value) on any failure
    // — sandbox crash, timeout, or the independent validation gate inside
    // design_task.py rejecting the agent's own claim of success. All of
    // these are the same thing from here: this attempt did not produce a
    // validated fix.
    return { ok: false, reason: 'investigation-failed', detail: err.message };
  }
  if (!handlerResult.testsPassed || !handlerResult.filesChanged?.length) {
    return { ok: false, reason: 'validation-failed', detail: handlerResult.detail };
  }

  const pr = await openPlatformRepairPrFn({
    slug: slugFor(generatorId, reasonKey),
    title: handlerResult.summary || `fix for ${generatorId}:${reasonKey}`,
    body: prBodyFor({
      generatorId, reasonKey, occurrenceDays, errorMessage,
      rootCause: handlerResult.rootCause, summary: handlerResult.summary,
      testOutput: handlerResult.testOutput, patch: handlerResult.patch,
    }),
    files: handlerResult.filesChanged.map((f) => ({ path: f.path, content: f.newContent })),
  });
  if (!pr.ok) return { ok: false, reason: 'pr-open-failed', detail: pr.error };

  return {
    ok: true, prUrl: pr.prUrl, prNumber: pr.prNumber, branchName: pr.branchName,
    patch: handlerResult.patch, rootCause: handlerResult.rootCause, summary: handlerResult.summary,
    testOutput: handlerResult.testOutput, filesChanged: handlerResult.filesChanged.map((f) => f.path),
  };
}

// A terminal state for a fresh problem that could not be safely fixed after
// MAX_FRESH_INVESTIGATION_ATTEMPTS — recordFixOutcome has no path to create
// a flagged_for_review row directly (a bare failure with no memoryRefId is
// deliberately a no-op there, "nothing to learn from a bare failure"), so
// this is the one place that writes directly, and only for this one
// terminal case. Never touched again automatically: lookupCodeLesson finds
// it by signature regardless of status, and maybeEscalateToCodeRepair below
// refuses to re-trigger investigation once it sees 'flagged_for_review'.
async function flagUnresolved({ generatorId, reasonKey, errorMessage, attempts }, { queryFn = query } = {}) {
  const signature = codeProblemSignature(generatorId, reasonKey);
  const symptoms = `"${generatorId}" repeatedly fails/refuses with reason "${reasonKey}".`;
  const rootCause = `Automated investigation ran ${attempts} time(s) and could not produce a validated fix. Last detail: ${String(errorMessage || '').slice(0, 500)}`;
  await queryFn(
    `INSERT INTO agent_fix_memory
       (category, scope, execution_permission, status, site_id, generator_id,
        problem_signature, symptoms, root_cause, affected_pattern, fix_strategy,
        source_type, occurrence_count)
     VALUES ('code', 'repo', 'informational', 'flagged_for_review', NULL, $1, $2, $3, $4, $5, $6, 'runtime-auto', $7)`,
    [generatorId, signature, symptoms, rootCause, symptoms, 'Needs a human engineer — automated repair could not validate a fix.', attempts],
  );
}

// The single entry point auto-remediation.js calls (fire-and-forget) after
// recording every failed/refused outcome. Fails open in every branch except
// the ones that decide "no, don't escalate" on purpose — a bug in THIS
// module must never be why an ordinary client draft attempt looks broken.
export async function maybeEscalateToCodeRepair({ generatorId, reason: reasonKey, errorMessage, siteId = null }, deps = {}) {
  const {
    env = process.env, queryFn = query, recordFixOutcomeFn = recordFixOutcome,
    applyKnownFixFn = applyKnownFix, investigateAndRepairFn = investigateAndRepair,
    maxFreshAttempts = MAX_FRESH_INVESTIGATION_ATTEMPTS,
  } = deps;

  if (!codeSelfRepairEnabled(env)) return { escalated: false, reason: 'disabled' };
  if (!generatorId || !reasonKey) return { escalated: false, reason: 'no-reason' };

  const days = await countDistinctFailureDays(generatorId, reasonKey, { queryFn });
  if (days < DISTINCT_DAY_THRESHOLD) return { escalated: false, reason: 'insufficient-evidence', days };

  const lessonRow = await lookupCodeLesson(generatorId, reasonKey, { queryFn });

  if (lessonRow?.status === 'flagged_for_review' || lessonRow?.status === 'deprecated') {
    return { escalated: false, reason: 'already-flagged-for-human-review' };
  }

  if (lessonRow?.fix_pattern) {
    const applied = await applyKnownFixFn(lessonRow, deps);
    if (applied.ok) {
      await recordFixOutcomeFn({ memoryRefId: lessonRow.id, outcome: 'success', generatorId, siteId, agentId: 'code-self-repair', sourceRef: applied.prUrl }).catch(() => {});
      return { escalated: true, path: 'known-issue', ok: true, prUrl: applied.prUrl };
    }
    if (applied.reason === 'patch-stale') {
      // Explicitly falls through to a fresh investigation rather than
      // forcing an obsolete patch — the code has moved on since this lesson
      // was learned.
    } else {
      await recordFixOutcomeFn({ memoryRefId: lessonRow.id, outcome: 'failure', generatorId, siteId, agentId: 'code-self-repair' }).catch(() => {});
      return { escalated: true, path: 'known-issue', ok: false, reason: applied.reason };
    }
  }

  let lastDetail = errorMessage;
  for (let attempt = 1; attempt <= maxFreshAttempts; attempt++) {
    const result = await investigateAndRepairFn({ generatorId, reasonKey, errorMessage, occurrenceDays: days, testFileHint: null }, deps);
    if (result.ok) {
      await recordFixOutcomeFn({
        memoryRefId: null, category: 'code', scope: 'repo', siteId: null, generatorId,
        problemSignature: codeProblemSignature(generatorId, reasonKey),
        symptoms: `"${generatorId}" repeatedly failed/refused with reason "${reasonKey}".`,
        rootCause: result.rootCause || null,
        affectedPattern: result.filesChanged?.join(', ') || generatorId,
        fixStrategy: result.summary || 'Automated platform code repair.',
        fixPattern: result.patch || null,
        outcome: 'success', agentId: 'code-self-repair', sourceType: 'runtime-auto', sourceRef: result.prUrl,
      }).catch(() => {});
      return { escalated: true, path: 'unknown-issue', ok: true, prUrl: result.prUrl, attempts: attempt };
    }
    lastDetail = result.detail || lastDetail;
    if (attempt === maxFreshAttempts) {
      await flagUnresolved({ generatorId, reasonKey, errorMessage: lastDetail, attempts: attempt }, { queryFn });
      return { escalated: true, path: 'unknown-issue', ok: false, reason: 'flagged_for_review', attempts: attempt };
    }
  }
  // Unreachable (the loop above always returns), kept only so a future edit
  // to the loop can't silently fall through without a return value.
  return { escalated: true, path: 'unknown-issue', ok: false, reason: 'exhausted' };
}
