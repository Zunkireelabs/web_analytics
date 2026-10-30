// Permanently delete one site (project) through the app's own sanctioned path:
// suspend -> soft-delete -> hard-delete (db.js suspendSite / softDeleteSite /
// hardDeleteSite), then remove its workspace if that leaves the workspace empty.
// Every step is audited, the same as deleting from the admin screen.
//
//   node --env-file=.env server/scripts/delete-site.js --site 8865 --by 1                                  # dry run (default)
//   node --env-file=.env server/scripts/delete-site.js --site 8865 --by 1 --apply --confirm-name "zennly"  # do it
//
// --by is the platform admin's user id, recorded as who did it. --confirm-name must be
// the site's exact name, the same re-typing the admin screen asks for.
//
// What it refuses to do (and says why): the company's own site; a site that has data
// under a name you did not confirm; and any case where deleting the site would also
// delete a LOGIN that is used somewhere else. users.site_id cascades, so a login whose
// home is this site goes with it — fine for a login that exists only for this site,
// not for one that is also a member of another workspace or project.
import { pathToFileURL } from 'node:url';

// Pure: whether this deletion may go ahead, and what it will remove. Everything it
// needs is passed in, so every refusal can be tested without a database.
export function planSiteDeletion({ site, companySiteId, homeUsers, elsewhere, workspaceSiteCount }) {
  const problems = [];
  if (!site) return { ok: false, problems: ['There is no such site.'] };
  if (Number(companySiteId) && Number(site.id) === Number(companySiteId)) problems.push('This is the company\'s own site and is never deleted.');

  const logins = homeUsers.map((u) => u.email);
  for (const u of homeUsers) {
    if (u.role === 'platform_admin') problems.push(`${u.email} is a platform admin whose home is this site; deleting it would delete that login.`);
    const other = elsewhere[u.id];
    if (other && (other.workspaces > 0 || other.projects > 0)) {
      problems.push(`${u.email} also belongs to ${other.workspaces} other workspace(s) and ${other.projects} other project(s); deleting this site would delete that login too. Move them first.`);
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    site,
    deletesLogins: logins,
    // The workspace goes too, but only when this was its last project.
    removesWorkspace: Boolean(site.workspace_id) && workspaceSiteCount <= 1,
  };
}

export function describeDeletion(plan) {
  if (!plan.ok) return plan.problems.map((p) => `✗ ${p}`).join('\n');
  return [
    `Permanently delete "${plan.site.name}" (site ${plan.site.id}, status ${plan.site.status}) and everything stored for it.`,
    plan.deletesLogins.length ? `Logins that go with it: ${plan.deletesLogins.join(', ')}` : 'No logins go with it.',
    plan.removesWorkspace ? 'Its workspace is removed too (this was its last project).' : 'Its workspace stays (it holds other projects).',
    'Steps: suspend -> soft-delete -> hard-delete. A failure after soft-delete leaves it soft-deleted, which can be reactivated.',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const siteId = Number(get('--site')), by = Number(get('--by')), confirmName = get('--confirm-name');
  const apply = args.includes('--apply');
  if (!siteId || !by) { console.error('Usage: --site <siteId> --by <platform admin user id> [--apply --confirm-name "<exact name>"]'); process.exit(2); }

  const { pool, suspendSite, softDeleteSite, hardDeleteSite } = await import('../db.js');
  const { recordAuditEvent } = await import('../store/admin/audit-log.js');
  try {
    const one = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
    const site = await one('SELECT id, name, status, workspace_id FROM sites WHERE id = $1', [siteId]);
    const actor = await one('SELECT id, role FROM users WHERE id = $1', [by]);
    if (!actor || actor.role !== 'platform_admin') { console.error(`--by ${by} is not a platform admin.`); process.exit(2); }

    const homeUsers = site ? (await pool.query('SELECT id, email, role FROM users WHERE site_id = $1', [siteId])).rows : [];
    const elsewhere = {};
    for (const u of homeUsers) {
      const w = await one('SELECT count(*)::int AS n FROM workspace_members WHERE user_id = $1 AND workspace_id IS DISTINCT FROM $2', [u.id, site.workspace_id]);
      const p = await one('SELECT count(*)::int AS n FROM project_members WHERE user_id = $1 AND site_id <> $2', [u.id, siteId]);
      elsewhere[u.id] = { workspaces: w.n, projects: p.n };
    }
    const count = site?.workspace_id ? (await one('SELECT count(*)::int AS n FROM sites WHERE workspace_id = $1', [site.workspace_id])).n : 0;

    const plan = planSiteDeletion({ site, companySiteId: process.env.COMPANY_SITE_ID, homeUsers, elsewhere, workspaceSiteCount: count });
    console.log(describeDeletion(plan));
    if (!plan.ok) { process.exitCode = 1; return; }
    if (!apply) { console.log('\nDRY RUN: nothing was changed. Re-run with --apply --confirm-name "<exact name>" to do it.'); return; }
    if (confirmName !== site.name) { console.error(`\nNot deleting: --confirm-name must be exactly "${site.name}".`); process.exit(2); }

    // audit_log.ip_address is an inet column, so there is no IP to give from a script: null, with the
    // script named in the user agent instead.
    const req = { userId: by, siteId: null, ip: null, get: () => 'delete-site script' };
    const audit = (action, extra = {}) => recordAuditEvent(req, { action, targetType: 'site', targetId: String(siteId), tenantSiteId: extra.gone ? null : siteId, tenantName: site.name, success: true });

    if (site.status === 'active') { if (!(await suspendSite(siteId))) throw new Error('Could not suspend (its status changed).'); await audit('tenant.suspended'); }
    if ((await one('SELECT status FROM sites WHERE id = $1', [siteId])).status === 'suspended') { if (!(await softDeleteSite(siteId))) throw new Error('Could not soft-delete (its status changed).'); await audit('tenant.soft_deleted'); }
    await audit('tenant.hard_delete_attempted');
    if (!(await hardDeleteSite(siteId))) throw new Error('Could not hard-delete (its status changed). It is soft-deleted and can be reactivated.');
    await audit('tenant.hard_delete_completed', { gone: true });
    console.log(`\nDeleted "${site.name}".`);

    if (plan.removesWorkspace) {
      const r = await pool.query('DELETE FROM workspaces WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM sites WHERE workspace_id = $1) RETURNING name', [site.workspace_id]);
      if (r.rows[0]) console.log(`Removed the empty workspace "${r.rows[0].name}".`);
    }
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
}
