import { getSiteById } from '../store/read.js';
import { query } from '../db.js';
import { knownDomain } from '../agents/lib/site-domain.js';
import { submitIndexNow } from './indexnow.js';
import { recordIndexNowPing } from '../store/indexnow.js';
import { indexNowDir } from '../implementers/lib/indexnow-file.js';

// Tells IndexNow which pages changed, once a deployment is confirmed live (agents/lib/fix-verification.js). The pages are the ones the
// deployment's own drafts changed. Skipped for a project that has no key or no folder for the key file (it never opted in). NEVER throws and
// never blocks the verification that triggered it: a failed ping is recorded on the deployment's evidence and that is all.
export async function pingIndexNowForDeployment(siteId, deployment, deps = {}) {
  const d = { getSiteById, query, submit: submitIndexNow, record: recordIndexNowPing, ...deps };
  try {
    const site = await d.getSiteById(siteId);
    const key = site?.indexnow_key;
    const host = knownDomain(site);
    if (!key || !host || indexNowDir(site) === null) return { skipped: 'not set up' };
    const origin = `https://${host}`;
    const { rows } = deployment?.pr_number != null
      ? await d.query(`SELECT DISTINCT input->>'page' AS page FROM drafts WHERE site_id = $1 AND pr_number = $2 AND input->>'page' IS NOT NULL LIMIT 500`, [siteId, deployment.pr_number])
      : { rows: [] };
    const urls = [];
    for (const r of rows) { try { urls.push(new URL(r.page, origin).href); } catch { /* not a page address */ } }
    if (!urls.length) return { skipped: 'no changed pages recorded' };
    const result = await d.submit({ host, key, urls, keyLocation: `${origin}/${key}.txt` });
    if (deployment?.id != null) await d.record(deployment.id, result).catch(() => {});
    return result;
  } catch (err) {
    console.warn(`[indexnow] ping for site ${siteId} failed:`, err?.message || err);
    return { ok: false, reason: 'ping failed' };
  }
}
