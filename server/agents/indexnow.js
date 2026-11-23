import { getSiteById } from '../store/read.js';
import { knownDomain } from './lib/site-domain.js';
import { makeFinding, effortFromDifficulty } from './lib/findings.js';
import { indexNowDir } from '../implementers/lib/indexnow-file.js';
import { keyFileName } from '../lib/indexnow.js';
import { followRedirects } from '../free-audit/fetchPage.js';

export const meta = {
  id: 'indexnow',
  name: 'IndexNow Setup',
  description: 'Checks whether the site has the small key file that lets it tell Bing and Yandex the moment a page changes, and recommends adding it when not.',
  category: 'technical',
  requiresCapabilities: ['public-web'],
  version: 1,
};

// A project is only checked once someone has said where its static files live (siteRoot.indexnowDir in url_file_map): without that
// folder there is nowhere to put the file, so there is nothing to recommend. A project that has no key yet is recommended the file; the
// key itself is minted when the draft is made (generators/indexnow.js). Once a key exists the live file is looked for: present means
// done; missing means recommend it again (the draft was never merged, or the file was removed); unreachable means "cannot tell", never a finding.

/** 'live' | 'missing' | 'unreachable' for https://<host>/<key>.txt. Every redirect hop is checked against private addresses. */
export async function checkKeyFile(host, key, { follow = followRedirects } = {}) {
  try {
    const { res } = await follow(new URL(`https://${host}/${keyFileName(key)}`));
    if (res.status === 404 || res.status === 410) return 'missing';
    if (res.status !== 200) return 'unreachable';
    const text = (await res.text()).slice(0, 512);
    return text.trim() === key ? 'live' : 'missing';
  } catch { return 'unreachable'; }
}

export async function run({ siteId, deps = {} }) {
  const d = { getSiteById, checkKeyFile, ...deps };
  const site = await d.getSiteById(siteId);
  const host = knownDomain(site);
  if (indexNowDir(site) === null || !host) {
    return { meta, status: 'insufficient-data', facts: null, narrative: null, message: 'IndexNow is not set up for this project: no folder is recorded for the site\'s static files (siteRoot.indexnowDir).', generatedAt: new Date().toISOString() };
  }
  const key = site.indexnow_key || null;
  const state = key ? await d.checkKeyFile(host, key) : 'no-key';
  const findings = state === 'live' || state === 'unreachable' ? [] : [makeFinding({
    id: 'indexnow:site',
    evidence: { host, keyMinted: Boolean(key), keyFile: key ? keyFileName(key) : null },
    whyItMatters: 'When a page here changes, Bing, Yandex and the AI search that reads Bing only find out the next time they crawl it, which can take days. An IndexNow key file lets the site tell them the moment a change goes live.',
    priority: 'low',
    recommendedAction: { label: 'Add the IndexNow key file', generatorId: 'indexnow', params: { page: `https://${host}/` }, effort: effortFromDifficulty(1) },
    expectedImpact: { label: 'Low', basis: 'computed', value: 0 },
  })];
  return {
    meta, status: 'ok',
    facts: { host, keyMinted: Boolean(key), keyFile: state, findings },
    narrative: findings.length ? 'This site does not yet tell Bing and Yandex when its pages change.' : null,
    generatedAt: new Date().toISOString(),
  };
}
