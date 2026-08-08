import { getBranchSha, createBranch, commitFilesAtomic, openPullRequest, listOpenPullRequestsForBranch } from '../../github/client.js';
import { baseBranch } from './github-ops.js';
import { detectInsertionPoint, isJsxFile } from './structural-detect.js';
import { hasMarker } from './marker-merge.js';
import { safeMessage } from '../../lib/errors.js';

// Closes the one real gap marker-merge.js's NO_EOF_INSERT_FIELDS leaves on
// purpose: a component-based template (React/Next.js/Astro/...) has no safe
// EOF fallback, so today a missing body-content marker there fails honestly
// and waits for a human to hand-place one (see that module's comment). This
// module is the automated first attempt BEFORE that human step — real
// structural detection (structural-detect.js), not a guess, proposed as an
// ordinary PR a human still merges once per template.
//
// Deliberately NOT a direct, unreviewed commit to the site's default branch:
// a structurally-plausible-but-wrong container is still possible (an AST/DOM
// match is real evidence, not proof of correct semantic intent), and this is
// a client's production repo. A bootstrap PR keeps the "no manual marker
// insertion" promise (nothing to hand-edit, just a merge click) while
// keeping a real human in the loop before anything ships — same review
// discipline as every other PR this app opens, never weakened for this path.

// Deterministic per-(site, file, marker) branch name so repeat calls for the
// same still-unmerged bootstrap reuse the same branch/PR instead of opening
// a new one every time a queued recommendation retries.
function bootstrapBranchName(site, filePath, markerName) {
  const safePath = filePath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `action-center/bootstrap-marker-${site.id}-${safePath}-${markerName.toLowerCase()}`;
}

function insertMarkerText(fileContent, filePath, markerName, offset) {
  const marker = isJsxFile(filePath)
    ? `{/* SEOAI:${markerName}:START */}{/* SEOAI:${markerName}:END */}`
    : `<!-- SEOAI:${markerName}:START --><!-- SEOAI:${markerName}:END -->`;
  return fileContent.slice(0, offset) + `\n${marker}\n` + fileContent.slice(offset);
}

// Attempts to structurally detect a real insertion point for `markerName` in
// `filePath` and open (or reuse) a one-file bootstrap PR adding it, empty,
// at that point. Never touches `fileContent` itself as a return value beyond
// what's proposed in the PR — the CALLER's in-flight draft still fails
// honestly this round (the marker doesn't exist on the live branch yet); the
// point is that a human merging this PR once means the NEXT attempt (retry,
// or the nightly re-scan) succeeds with zero further manual steps.
//
// Returns:
//   {ok: true, opened: true,  prUrl, prNumber, containerDescription} — new PR opened
//   {ok: true, opened: false, prUrl, prNumber}                       — an equivalent PR was already open, reused
//   {ok: false, reason: 'no-confident-container', error, detectReason} — detection found nothing safe; caller falls back to today's manual-marker message
//   {ok: false, reason: 'already-has-marker'}                        — nothing to bootstrap, the marker's already there (caller should re-check spliceMarkers instead)
//   {ok: false, reason: 'github-error', error}                       — real infra failure
export async function detectAndOpenBootstrapPr(site, filePath, fileContent, markerName) {
  if (hasMarker(fileContent, markerName)) return { ok: false, reason: 'already-has-marker' };

  const detection = detectInsertionPoint(fileContent, filePath);
  if (!detection.ok) {
    return { ok: false, reason: 'no-confident-container', error: detection.error, detectReason: detection.reason };
  }

  const branchName = bootstrapBranchName(site, filePath, markerName);

  try {
    const existing = await listOpenPullRequestsForBranch(site, branchName);
    if (existing.length > 0) {
      const pr = existing[0];
      return { ok: true, opened: false, prUrl: pr.html_url, prNumber: pr.number, containerDescription: detection.containerDescription };
    }

    const baseSha = await getBranchSha(site, baseBranch(site));
    await createBranch(site, branchName, baseSha);

    const newContent = insertMarkerText(fileContent, filePath, markerName, detection.insertBeforeOffset);
    await commitFilesAtomic(
      site, branchName, [{ path: filePath, content: newContent }],
      `Action Center: bootstrap SEOAI:${markerName} marker in ${filePath}`
    );

    const { number, url } = await openPullRequest(site, {
      branch: branchName,
      title: `Action Center: add insertion point for ${filePath}`,
      body: `Adds an empty \`SEOAI:${markerName}\` marker to \`${filePath}\`, structurally placed inside ` +
        `${detection.containerDescription} — detected automatically (${detection.fileKind === 'jsx' ? 'JSX AST' : 'parsed DOM'} analysis, ` +
        `not a text-position guess). This PR changes nothing visible on its own (the marker is empty); merging it ` +
        `is a one-time step that lets AI Growth Platform recommendations for this page apply automatically going forward.\n\n` +
        `Review that the marker landed in the right visible spot, then merge into \`${baseBranch(site)}\`.`,
    });
    return { ok: true, opened: true, prUrl: url, prNumber: number, containerDescription: detection.containerDescription };
  } catch (err) {
    const { message } = safeMessage('marker-bootstrap.detectAndOpenBootstrapPr', err, 'This bootstrap pull request could not be opened right now — our team has been notified.');
    return { ok: false, reason: 'github-error', error: message };
  }
}
