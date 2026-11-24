import { resolveFile, getMatchingPattern } from './url-file-map.js';
import { discoverTemplateDataStores, discoverPostBodyStore } from './template-data-stores.js';
import { normalizedPath } from './discover-file-mapping.js';
import { updateSiteRepoConfig } from '../../db.js';
import { recordCapabilityRepair } from '../../store/capability-repairs.js';

// SELF-HEAL FOR A PAGE WHOSE CONTENT LIVES IN A DATA STORE, NOT IN ITS TEMPLATE.
//
// A page that resolves to a shared template (src/app/[slug]/page.tsx) used to be stopped with "a change written there would apply to every page". The change
// does not belong in the template: the template reads this page's FAQ and search title from keyed data files (template-data-stores.js finds them from the
// template's own imports). When it finds the store for THIS action, the adapter that writes into it is saved for THIS page (never the whole pattern: the same
// pattern also matches pages that have files of their own) and the recommendation goes ahead. When it cannot find exactly one store, nothing is saved and the page
// stays honestly blocked with the reason.
//
// Same posture as autoHealFileMapping: opportunistic, an audit row for every outcome, never throws into the caller's pass.

// Which adapter writes which action's content into a keyed record. Another action type has no store adapter yet, so it is not healed here.
export const STORE_ACTIONS = Object.freeze(['faq', 'qa-content', 'meta-title', 'expand-content', 'refresh-content']);
// Which KIND of store takes each action. A Q&A is question headings in the post BODY (not the FAQ box), so it goes where body sections go, as do a
// refreshed and an expanded section; the FAQ section has its own store.
const STORE_KIND = Object.freeze({ faq: 'faq', 'qa-content': 'body', 'meta-title': 'meta-title', 'expand-content': 'body', 'refresh-content': 'body' });
const DYNAMIC_SEGMENT = /(^|\/)\[[^\]/]+\](\/|\.|$)/;

export async function autoHealTemplateDataStore(site, pageUrl, actionType, {
  fetchTree, fetchFile, branch, persist = updateSiteRepoConfig, record = recordCapabilityRepair,
} = {}) {
  if (!STORE_ACTIONS.includes(actionType) || !site?.id) return null;
  const file = resolveFile(site, pageUrl);
  if (!file || !DYNAMIC_SEGMENT.test(file)) return null; // only a shared template; a page with its own file is not this case

  const path = normalizedPath(pageUrl);
  if (site.url_file_map?.pages?.[path]?.adapters?.[actionType]) return null; // already configured: never overwritten
  const pattern = getMatchingPattern(site, pageUrl);
  const urlPattern = pattern?.match;
  if (!urlPattern) return null;
  let groups;
  try { groups = new RegExp(urlPattern).exec(path)?.length - 1; } catch { return null; }
  if (groups !== 1) return null; // the key must be capture group 1 and the only group, or the key would be a guess

  const [tree, templateSource] = await Promise.all([fetchTree(site, branch), fetchFile(site, file, branch)]);
  const source = typeof templateSource === 'string' ? templateSource : templateSource?.content;
  if (!source || !tree?.files) return null;
  const readFile = async (p) => { const f = await fetchFile(site, p, branch); return typeof f === 'string' ? f : f?.content ?? null; };
  const { stores, skipped } = await discoverTemplateDataStores({ templateFile: file, templateSource: source, repoFiles: tree.files, readFile });
  const kind = STORE_KIND[actionType];
  let store = kind === 'body' ? null : stores.find((s) => s.actionType === kind);
  if (!store && kind === 'body') {
    // A post's BODY is not a keyed record like its FAQ or title: it is the post's own JSON file. The proof that new keys name real posts, found for the
    // keyed stores the template reads, also tells where those post files are.
    const keyEvidence = stores.map((s) => s.evidence?.keyEvidence).find(Boolean);
    const body = await discoverPostBodyStore({ templateFile: file, templateSource: source, repoFiles: tree.files, readFile, keyEvidence });
    if (body) store = { actionType, adapter: body.adapter, evidence: body.evidence };
  }
  if (!store) {
    await record(site.id, { capabilityType: 'url-file-map-adapter', target: pageUrl, outcome: 'ambiguous', detail: { actionType, templateFile: file, skipped } });
    return null;
  }

  const cfg = JSON.parse(JSON.stringify(site.url_file_map || {}));
  cfg.pages = cfg.pages || {};
  cfg.pages[path] = { ...(cfg.pages[path] || {}), adapters: { ...(cfg.pages[path]?.adapters || {}), [actionType]: { ...store.adapter, urlPattern } } };
  await record(site.id, {
    capabilityType: 'url-file-map-adapter', target: pageUrl, outcome: 'repaired', evidenceTier: 'template-imports',
    detail: { actionType, templateFile: file, adapter: cfg.pages[path].adapters[actionType], evidence: store.evidence },
  });
  return persist({ siteId: site.id, urlFileMap: cfg });
}
