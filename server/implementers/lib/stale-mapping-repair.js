import { getRepoTree, getFileContent } from '../../github/client.js';
import { baseBranch } from './github-ops.js';
import { resolveFile, resolveHostScope } from './url-file-map.js';
import { normalizedPath, sharedTargetVeto, TEMPLATE_EXTENSIONS } from './discover-file-mapping.js';
import { updateSiteRepoConfig } from '../../db.js';
import { getSiteById } from '../../store/read.js';
import { ownDomains, hostnameOf } from '../../agents/lib/site-domain.js';
import { recordCapabilityRepair } from '../../store/capability-repairs.js';

// STALE MAPPING REPAIR. The site's url_file_map points a LIVE page at a file that no longer exists in the repo (zunkireelabs-web
// deleted src/pages/index.njk on 2 Oct 2026 and moved the homepage to src/pages/homepage-v2.njk; the map kept pointing at the
// deleted file). This finds the file that now serves the page, from the one piece of evidence the framework itself uses to decide
// where a template renders: a literal `permalink:` equal to the page's path.
//
// It never guesses:
//   exactly one file declares the permalink, it passes the shared-target veto -> the mapping is repaired;
//   no file declares it                                                        -> 'no-match'    (manual re-mapping);
//   several files declare it                                                   -> 'ambiguous'   (candidates shown to a human);
//   the only candidate is a shared target                                      -> 'refused';
//   any read failed, timed out, or the tree is truncated                       -> 'unverifiable' (retried on the next pass).
// A partial scan is never trusted: one unread template could be the real match or a second candidate, so any failed read makes the
// whole result unverifiable instead of "no match" or "unique".
//
// Nothing is written unless the repair is unique and verified, and the write is compare-and-set: the site row is re-read and the
// page must STILL resolve to the same stale file, so a mapping someone fixed (or changed) in the meantime is never overwritten.
// Every attempt is recorded in capability_repairs with the old mapping, the new one (if any) and the evidence.

export const STALE_REPAIR_OUTCOMES = Object.freeze(['repaired', 'no-match', 'ambiguous', 'refused', 'unverifiable', 'skipped']);

// capability_repairs.outcome values (its CHECK constraint). 'unverifiable' needs proposed migration
// E_capability_repairs_unverifiable.sql; until it is applied that one audit insert fails and is only logged (recordCapabilityRepair
// is never fatal), and the blocked reason on the recommendation still says what happened.
const AUDIT_OUTCOME = { repaired: 'repaired', 'no-match': 'not-found', ambiguous: 'ambiguous', refused: 'ambiguous', unverifiable: 'unverifiable' };

class Unverifiable extends Error {}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Unverifiable(`timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// The pages[] key that currently holds this page's entry (the lookup accepts the path with or without its trailing slash), or null
// when the page resolves through a pattern instead.
function pageEntryKey(pages, pageUrl) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl); }
  const normalized = normalizedPath(pageUrl);
  if (pages?.[path]) return path;
  if (pages?.[normalized]) return normalized;
  return null;
}

// Strict permalink scan: every template file is read; ANY failed read throws Unverifiable. Returns the files whose literal
// `permalink:` (template expressions excluded, as in buildPermalinkIndex) equals the page's path, plus how many were scanned.
async function filesDeclaringPermalink(site, tree, pagePath, { fetchFile, branch }) {
  const templates = tree.files.filter((f) => TEMPLATE_EXTENSIONS.some((ext) => f.endsWith(`.${ext}`)));
  const matches = [];
  const failures = [];
  await Promise.all(templates.map(async (file) => {
    let content;
    try {
      const got = await fetchFile(site, file, branch);
      content = got?.content ?? null;
    } catch (err) {
      console.warn(`[stale-mapping] could not read ${file}: ${err.message}`);
      failures.push(`${file}: could not be read`);
      return;
    }
    // null = a real 404 for a file the tree just listed: the repo moved under us mid-scan, so the scan is not a consistent picture.
    if (content == null) { failures.push(`${file}: listed in the tree but not readable`); return; }
    const m = content.match(/^permalink:\s*(.+)$/m);
    if (!m) return;
    const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (/[{}]/.test(raw)) return;
    if (normalizedPath(raw) === pagePath) matches.push(file);
  }));
  if (failures.length) throw new Unverifiable(`${failures.length} template file(s) could not be read (${failures.slice(0, 3).join('; ')})`);
  return { matches: matches.sort(), scanned: templates.length };
}

export async function repairStaleFileMapping(site, pageUrl, staleFile, {
  fetchTree = getRepoTree,
  fetchFile = getFileContent,
  loadSite = getSiteById,
  persist = updateSiteRepoConfig,
  record = recordCapabilityRepair,
  routes,
  timeoutMs = 60000,
  log = console,
} = {}) {
  const pagePath = normalizedPath(pageUrl);
  // Returns whether the audit row was saved. Callers that change data refuse to proceed without it; callers that only block report it.
  const audit = async (outcome, detail, evidenceTier = null) => {
    const saved = await record(site.id, {
      capabilityType: 'url-file-map-page', target: pageUrl, outcome: AUDIT_OUTCOME[outcome], evidenceTier,
      detail: { kind: 'stale-mapping', result: outcome, repo: `${site.repo_owner}/${site.repo_name}`, oldFile: staleFile, ...detail },
    }).catch(() => false);
    if (saved !== true) log.warn?.(`[stale-mapping] site #${site.id}: AUDIT NOT RECORDED for ${pageUrl} (${outcome})`);
    return saved === true;
  };
  const done = (outcome, extra = {}) => ({ outcome, oldFile: staleFile, ...extra });
  // `audited` is false when the attempt's audit row could not be saved; the blocked text then says so.
  const blocked = async (outcome, detail, extra, evidenceTier) => done(outcome, { ...extra, auditFailed: !(await audit(outcome, detail, evidenceTier)) });

  if (!site?.id || !site.repo_owner || !site.repo_name) return done('skipped', { reason: 'the site has no connected repository' });

  // The page must belong to THIS project: its own registered primary domain. A foreign or non-primary hostname is never repaired from
  // this repo's evidence (the same rule autoHealFileMapping applies).
  const domains = ownDomains(site);
  const host = hostnameOf(pageUrl);
  if (domains && (!host || !domains.includes(host))) {
    const reason = `${pageUrl} is not on this project's own domain (${domains.join(', ')})`;
    return blocked('refused', { reason }, { reason });
  }
  if (resolveHostScope(site, pageUrl).scope === 'host') {
    const reason = `${pageUrl} is on a non-primary hostname; it can only be mapped by an explicit url_file_map.hosts entry`;
    return blocked('refused', { reason }, { reason });
  }
  // Only a mapping that really points at `staleFile` is treated as stale; anything else was changed already and is left alone.
  if (resolveFile(site, pageUrl) !== staleFile) return done('skipped', { reason: 'the page no longer resolves to the stale file' });

  const branch = baseBranch(site);
  try {
    return await withTimeout((async () => {
      let tree;
      try { tree = await fetchTree(site, branch); } catch (err) { log.warn?.(`[stale-mapping] site #${site.id}: tree read failed: ${err.message}`); throw new Unverifiable('could not read the repository tree'); }
      if (!tree || !Array.isArray(tree.files)) throw new Unverifiable('the repository tree came back empty');
      if (tree.truncated) throw new Unverifiable('the repository tree is truncated, so the scan would be incomplete');
      // Conflicting evidence: the gate saw the file as missing but the tree lists it. Never "repair" a mapping that may be valid.
      if (tree.files.includes(staleFile)) throw new Unverifiable(`${staleFile} is still listed in ${site.repo_owner}/${site.repo_name}@${branch}; the mapping may not be stale`);

      const { matches, scanned } = await filesDeclaringPermalink(site, tree, pagePath, { fetchFile, branch });
      const evidence = { method: 'permalink-frontmatter', permalink: pagePath, branch, templatesScanned: scanned };

      if (matches.length === 0) {
        return blocked('no-match', { evidence }, { candidates: [], evidence });
      }
      if (matches.length > 1) {
        return blocked('ambiguous', { candidates: matches, evidence }, { candidates: matches, evidence });
      }
      const newFile = matches[0];
      // The candidate came from THIS site's own tree, read with THIS site's credentials; it still has to be the page's own file and
      // not a shared one (pagination generator, layout/include, or a file already mapped to another URL).
      const veto = await sharedTargetVeto(site, pageUrl, newFile, { routes, fetchFile, branch });
      if (veto) {
        return blocked('refused', { candidates: [newFile], reason: veto, evidence }, { candidates: [newFile], reason: veto, evidence });
      }

      // Compare-and-set against the row as it is NOW.
      let current;
      try { current = await loadSite(site.id); } catch (err) { log.warn?.(`[stale-mapping] site #${site.id}: site re-read failed: ${err.message}`); throw new Unverifiable('could not re-read the site before writing'); }
      if (!current || current.id !== site.id || current.repo_owner !== site.repo_owner || current.repo_name !== site.repo_name) {
        throw new Unverifiable('the site row changed project or repository during the repair');
      }
      if (resolveFile(current, pageUrl) !== staleFile) {
        return blocked('refused', { candidates: [newFile], reason: 'the mapping changed while the repair ran', evidence },
          { candidates: [newFile], reason: 'the mapping changed while the repair ran; left as it is now', evidence });
      }

      const cfg = JSON.parse(JSON.stringify(current.url_file_map || {}));
      cfg.pages = cfg.pages || {};
      const key = pageEntryKey(cfg.pages, pageUrl) || pagePath;
      const oldEntry = cfg.pages[key] || null;
      cfg.pages[key] = { ...(oldEntry || {}), file: newFile };
      // The audit row comes FIRST: a mapping is never changed without a record of the old one, the new one and the evidence.
      if (!(await audit('repaired', { newFile, oldEntry, newEntry: cfg.pages[key], evidence }, 'permalink-frontmatter'))) {
        throw new Unverifiable('the audit record could not be saved, so the mapping was NOT changed');
      }
      const updated = await persist({ siteId: site.id, urlFileMap: cfg });
      log.log?.(`[stale-mapping] site #${site.id}: ${pagePath} re-mapped ${staleFile} -> ${newFile} (only file declaring permalink ${pagePath})`);
      return done('repaired', { newFile, site: updated, evidence });
    })(), timeoutMs);
  } catch (err) {
    if (!(err instanceof Unverifiable)) throw err;
    log.warn?.(`[stale-mapping] site #${site.id}: could not verify a replacement for ${staleFile} (${pageUrl}): ${err.message}`);
    return blocked('unverifiable', { reason: err.message }, { reason: err.message });
  }
}

// The Action Center text for every outcome that leaves the finding blocked.
export function staleMappingBlockedReason(page, repair) {
  const text = staleReasonText(page, repair);
  return repair.auditFailed ? `${text} (Note: the audit record of this attempt could not be saved.)` : text;
}

function staleReasonText(page, repair) {
  const head = `The site's url_file_map resolves ${page} to ${repair.oldFile}, but that file no longer exists in the repo while the page itself is live: the mapping is stale.`;
  switch (repair.outcome) {
    case 'no-match':
      return `${head} No file in the repo declares permalink ${normalizedPath(page)}, so it could not be re-mapped automatically. Manual re-mapping is required.`;
    case 'ambiguous':
      return `${head} More than one file declares permalink ${normalizedPath(page)}: ${repair.candidates.join(', ')}. A person must choose the right file; nothing was changed.`;
    case 'refused':
      return `${head} The only candidate${repair.candidates?.length ? ` (${repair.candidates.join(', ')})` : ''} was not used: ${repair.reason}. Manual re-mapping is required.`;
    case 'unverifiable':
      return `${head} The replacement could not be verified this time (${repair.reason}); nothing was changed and it will be retried on the next pass.`;
    default:
      return `${head} Re-map the page so this fix can be applied.`;
  }
}
