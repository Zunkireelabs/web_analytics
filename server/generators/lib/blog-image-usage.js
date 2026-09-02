import { getRepoTree, getFileContent, defaultBranchName } from '../../github/client.js';
import { query } from '../../db.js';
import { extractImageUrl, listPostPaths } from './blog-frontmatter.js';
import { pexelsPhotoIdFromUrl } from './pexels-client.js';

// Draft statuses that represent a photo id this site has CLAIMED but not yet
// got onto its default branch. Without these, a batch cannot see its own
// choices: every draft in one run computes its exclusion set from the
// committed branch alone, so draft #1 picks a photo, draft #2 recomputes an
// identical set that still doesn't contain it, and picks the same photo
// again. That is exactly how 39 posts in one Action Center batch landed on
// the same Pexels photo (2599244) — the branch-only check worked as written
// and still could not prevent intra-batch convergence.
//
// 'abandoned' is deliberately absent: an abandoned draft never ships, so its
// photo is free again. 'implemented' is absent for the same reason it isn't
// needed — by then the post is on the branch and the tree scan sees it.
const PENDING_DRAFT_STATUSES = [
  'draft',
  'submitted_for_approval',
  'approved',
  'branch_pushed',
  'pr_opened',
];

// Photo ids claimed by this site's own not-yet-merged blog-image drafts.
// Tenant-scoped by site_id in SQL, never globally: two tenants may legitimately
// use the same stock photo, and one tenant's pending draft must never constrain
// another's image choice.
async function pendingDraftPhotoIds(siteId) {
  if (!siteId) return new Set();
  const { rows } = await query(
    `SELECT content->>'imageUrl' AS image_url
       FROM drafts
      WHERE site_id = $1
        AND action_type = 'blog-image'
        AND status = ANY($2)
        AND content->>'imageUrl' IS NOT NULL`,
    [siteId, PENDING_DRAFT_STATUSES]
  );
  const ids = new Set();
  for (const { image_url: url } of rows) {
    const id = pexelsPhotoIdFromUrl(url);
    if (id) ids.add(id);
  }
  return ids;
}

// Every photo id already used as a featured image somewhere on this site —
// passed to searchImage's excludePhotoIds so a new or repaired post never
// lands on a photo another post already has (see pexels-client.js's
// searchImage top comment for why that convergence happened in the first
// place).
//
// Two sources, because either alone is incomplete: the committed default
// branch (what is live) UNION this site's pending blog-image drafts (what is
// already spoken for). See PENDING_DRAFT_STATUSES above for why the second
// half is what actually stops a batch colliding with itself.
export async function usedPhotoIds(site) {
  const siteId = site?.id ?? null;

  // Each half fails independently: losing the repo scan must not also discard
  // the draft reservations, which are the half that prevents intra-batch
  // duplicates and are far cheaper to obtain.
  let committed = new Set();
  try {
    const target = site?.url_file_map?.newContentTargets?.['blog-outline'];
    if (!target?.dir) {
      // Not an error — a tenant mid-onboarding legitimately has no blog target
      // yet — but it does mean the live-post half of de-duplication is off, so
      // a new post can land on a photo an existing post already uses. Said out
      // loud, because "no two posts share an image" is a guarantee this site
      // silently cannot make until newContentTargets['blog-outline'] is set.
      console.warn(
        `[blog-image-usage] site ${siteId} has no url_file_map.newContentTargets['blog-outline'].dir — ` +
        'cannot scan published posts, so de-duplication covers pending drafts only.'
      );
    } else {
      const ref = defaultBranchName(site);
      const { files } = await getRepoTree(site, ref);
      const paths = listPostPaths(files, target);
      for (const filePath of paths) {
        // eslint-disable-next-line no-await-in-loop
        const file = await getFileContent(site, filePath, ref);
        const raw = typeof file === 'string' ? file : file?.content;
        const url = raw ? extractImageUrl(raw) : null;
        const id = url ? pexelsPhotoIdFromUrl(url) : null;
        if (id) committed.add(id);
      }
    }
  } catch (err) {
    // Still best-effort — a scan failure must not block an otherwise complete
    // draft — but NOT silent. Swallowing this used to disable de-duplication
    // entirely with no signal, so the next batch could converge again and
    // nothing in the logs said why.
    console.error(`[blog-image-usage] repo scan failed for site ${siteId}, de-duplication is degraded:`, err.message);
    committed = new Set();
  }

  let pending = new Set();
  try {
    pending = await pendingDraftPhotoIds(siteId);
  } catch (err) {
    console.error(`[blog-image-usage] pending-draft scan failed for site ${siteId}, de-duplication is degraded:`, err.message);
    pending = new Set();
  }

  return new Set([...committed, ...pending]);
}
