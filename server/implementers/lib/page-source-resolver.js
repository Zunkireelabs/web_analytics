// A per-run page-source verifier bound to a site: reads the repo tree ONCE (one GitHub tree call) and each data file at most once, so verifying
// a whole queue costs a handful of GitHub calls, not one per recommendation. Read-only.
import { getRepoTree, getFileContent } from '../../github/client.js';
import { baseBranch } from './github-ops.js';
import { resolvePageSource } from './page-source.js';

export function makePageSourceResolver(site, { fetchTree = getRepoTree, fetchFile = getFileContent } = {}) {
  if (!site?.repo_owner || !site?.repo_name) return null;
  const branch = baseBranch(site);
  let treePromise = null;
  const fileCache = new Map();
  const readFile = (path) => {
    if (!fileCache.has(path)) fileCache.set(path, fetchFile(site, path, branch).then((f) => f?.content ?? null).catch(() => null));
    return fileCache.get(path);
  };
  return async (pageUrl) => {
    treePromise ||= fetchTree(site, branch);
    const tree = await treePromise;
    return resolvePageSource({ site, pageUrl, files: tree.files, readFile });
  };
}
