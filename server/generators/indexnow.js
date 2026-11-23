import { getSiteById } from '../store/read.js';
import { ensureIndexNowKey } from '../store/indexnow.js';
import { knownDomain } from '../agents/lib/site-domain.js';
import { indexNowTargetPath, indexNowDir } from '../implementers/lib/indexnow-file.js';
import { keyFileContent, keyFileName } from '../lib/indexnow.js';

export const meta = {
  id: 'indexnow',
  name: 'IndexNow Key File',
  description: 'Adds the small key file that lets this site tell Bing, Yandex and other search engines the moment a page changes, instead of waiting for them to crawl it.',
  recommendationTags: [],
};

// No model: the draft is the file name and its contents, which are the same thing (the key). The key is minted ONCE per project and saved
// (store/indexnow.js), because the file that ends up published at the site's root is named after it and must never change.
// params: none. Needs siteRoot.indexnowDir in the site's url_file_map (the repo folder served at the site root).
export async function generate({ siteId }) {
  const site = await getSiteById(siteId);
  if (!site) throw Object.assign(new Error('Site not found.'), { status: 404 });
  if (indexNowDir(site) === null) {
    throw Object.assign(new Error('This site has no folder set for its IndexNow key file. Set siteRoot.indexnowDir (the repo folder served at the site root) first.'), { status: 400, userFacing: true });
  }
  const host = knownDomain(site);
  const key = await ensureIndexNowKey(siteId);
  const path = indexNowTargetPath(site, key);
  if (!key || !path) throw Object.assign(new Error('Could not prepare the IndexNow key file.'), { status: 500 });
  const fileName = keyFileName(key);
  return {
    content: { key, fileName, path, fileContent: keyFileContent(key), host: host || null, keyLocation: host ? `https://${host}/${fileName}` : null },
    summary: `IndexNow key file ${fileName}`,
  };
}
