import { getRepoTree, getFileContent, defaultBranchName } from '../../github/client.js';
import { extractImageUrl, listPostPaths } from './blog-frontmatter.js';
import { pexelsPhotoIdFromUrl } from './pexels-client.js';

// Every photo id already used as a featured image somewhere on this site —
// passed to searchImage's excludePhotoIds so a new or repaired post never
// lands on a photo another post already has (see pexels-client.js's
// searchImage top comment for why that convergence happened in the first
// place). Best-effort, same discipline as the image search itself: a scan
// failure returns an empty set rather than blocking the draft.
export async function usedPhotoIds(site) {
  try {
    const target = site?.url_file_map?.newContentTargets?.['blog-outline'];
    if (!target?.dir) return new Set();
    const ref = defaultBranchName(site);
    const { files } = await getRepoTree(site, ref);
    const paths = listPostPaths(files, target);

    const ids = new Set();
    for (const filePath of paths) {
      // eslint-disable-next-line no-await-in-loop
      const file = await getFileContent(site, filePath, ref);
      const raw = typeof file === 'string' ? file : file?.content;
      const url = raw ? extractImageUrl(raw) : null;
      const id = url ? pexelsPhotoIdFromUrl(url) : null;
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}
