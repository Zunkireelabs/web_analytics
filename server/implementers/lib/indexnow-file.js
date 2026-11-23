import { isValidIndexNowKey, keyFileName } from '../../lib/indexnow.js';

// Where the IndexNow key file goes in a client's repo: <siteRoot.indexnowDir>/<key>.txt. `indexnowDir` is the repo folder the site serves
// at its root (public/, static/, src/ with a passthrough...), set per site like siteRoot.robotsTxt is. The key is validated to letters,
// digits and dashes, so no key can add a slash or ".." to the path, and the directory is trusted configuration, not draft content.
export function indexNowDir(site) {
  const dir = site?.url_file_map?.siteRoot?.indexnowDir;
  return typeof dir === 'string' && dir.trim() ? dir.trim().replace(/^\/+|\/+$/g, '') : null;
}

/** @returns the repo path, or null when the folder is not configured or the key is not a valid IndexNow key */
export function indexNowTargetPath(site, key) {
  const dir = indexNowDir(site);
  if (!isValidIndexNowKey(key)) return null;
  return dir === null ? null : (dir ? `${dir}/${keyFileName(key)}` : keyFileName(key));
}
