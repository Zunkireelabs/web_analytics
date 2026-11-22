import { query as dbQuery } from '../db.js';
import { getRepoTree } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { deliverToAllChannels } from '../notifications/channels/index.js';

// Nightly, read-only check of every client's url_file_map against the client's REAL repository tree. It catches the kind of drift that makes
// the agent generate, fail and retry (or write to the wrong place) BEFORE any draft is made: a mapped file that no longer exists, a page mapped to a
// shared dynamic-route template, a content directory or manifest that is gone, a site-root file that moved. Nothing here assumes a framework or a
// client: it only compares configured paths with the paths that exist. It never writes to a database row of the client, to GitHub, or to the config;
// a finding is reported once a week per client to the dashboard bell (never email) so a person corrects the mapping.

const DYNAMIC_ROUTE = /(^|\/)\[[^\]/]+\](\/|\.|$)/;
const ROOT_FILE_KEYS = ['llmsTxt', 'sitemap', 'robotsTxt', 'nginxConfig', 'layoutTemplate'];

export function analyzeSiteConfig(site, files) {
  const tree = files instanceof Set ? files : new Set(files);
  const map = site?.url_file_map || {};
  const findings = [];
  for (const [url, entry] of Object.entries(map.pages || {})) {
    if (!entry?.file) continue;
    if (!tree.has(entry.file)) findings.push({ code: 'stale-page-file', url, file: entry.file, detail: `${url} is mapped to ${entry.file}, which does not exist on the default branch.` });
    else if (DYNAMIC_ROUTE.test(entry.file) && !entry.adapters) findings.push({ code: 'shared-template-page', url, file: entry.file, detail: `${url} is mapped to ${entry.file}, a template shared by many pages, with no adapter: a page-specific fix would apply to all of them.` });
  }
  for (const [type, t] of Object.entries(map.newContentTargets || {})) {
    if (t?.dir && ![...tree].some((f) => f.startsWith(`${t.dir}/`))) findings.push({ code: 'missing-content-dir', actionType: type, file: t.dir, detail: `New "${type}" content is written under ${t.dir}, which has no files on the default branch.` });
    if (t?.manifestFile && !tree.has(t.manifestFile)) findings.push({ code: 'missing-manifest', actionType: type, file: t.manifestFile, detail: `The "${type}" manifest ${t.manifestFile} does not exist on the default branch.` });
  }
  for (const key of ROOT_FILE_KEYS) {
    const f = map.siteRoot?.[key];
    if (typeof f === 'string' && f && !tree.has(f)) findings.push({ code: 'missing-site-root-file', key, file: f, detail: `siteRoot.${key} points at ${f}, which does not exist on the default branch.` });
  }
  return findings;
}

export function buildAuditEvent(siteId, findings) {
  if (!findings.length) return null;
  const byCode = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] || 0) + 1;
  const summary = Object.entries(byCode).map(([c, n]) => `${n} ${c.replace(/-/g, ' ')}`).join(', ');
  return {
    type: 'config-audit', severity: 'medium', channels: ['in-app'],
    title: `Setup check: ${findings.length} mapping ${findings.length === 1 ? 'problem' : 'problems'} found`,
    body: `${summary}. Example: ${findings[0].detail} Until corrected, fixes for these pages wait instead of being written.`,
    insightId: `config-audit:${siteId}`, // stable identity, so the alert gate's cooldown applies even though the text changes
  };
}

export async function runConfigAuditForAllSites({ query = dbQuery, loadTree = (site) => getRepoTree(site, baseBranch(site)), deliver = deliverToAllChannels } = {}) {
  const { rows } = await query(`SELECT * FROM sites WHERE status = 'active' AND deleted_at IS NULL AND repo_owner IS NOT NULL AND repo_name IS NOT NULL ORDER BY id`);
  const totals = { sites: rows.length, flagged: 0, unreadable: 0, clean: 0 };
  for (const site of rows) {
    try {
      const { files, truncated } = await loadTree(site);
      if (truncated) { totals.unreadable += 1; continue; } // a partial tree would produce false "missing" findings: report nothing instead
      const event = buildAuditEvent(site.id, analyzeSiteConfig(site, files));
      if (!event) { totals.clean += 1; continue; }
      await deliver(site.id, [event]);
      totals.flagged += 1;
    } catch (err) {
      totals.unreadable += 1; // GitHub unreachable or a bad token: no finding is invented
      console.error(`[config-audit] site ${site.id}:`, err.message);
    }
  }
  return totals;
}
