// Move one project (site) into another workspace WITHOUT locking anyone out.
//
//   node --env-file=.env server/scripts/move-project-to-workspace.js --site 8862 --to 1            # dry run (default)
//   node --env-file=.env server/scripts/move-project-to-workspace.js --site 8862 --to 1 --apply    # do it
//   ... --apply --remove-empty-source    # also remove the old workspace if the move leaves it with no projects
//
// Why this exists: every client used to be its own workspace. Moving Admizz into
// the Zunkiree Labs workspace would, on its own, cut off the Admizz login (it is a
// member of the OLD workspace, not the new one). So the move also gives each member
// of the old workspace access to just that project (owner/admin -> project admin,
// member -> project read-only), which keeps their password login working and shows
// them only their own project, under "Shared with you".
//
// By default nothing is deleted: the old workspace and its memberships stay (the old
// workspace simply has no projects left). With --remove-empty-source the old workspace
// is removed too, but ONLY when it has no projects left (see canRemoveSource), and the
// people in it keep the project access granted above, so nobody is locked out.
// Everything happens in one transaction, so a failure leaves things exactly as they were.
import { pathToFileURL } from 'node:url';

import { planProjectTransfer } from '../store/workspaces.js';

// Pure: what the move will do, so it can be reviewed (and tested) before anything runs.
// Same plan the in-app "Transfer project" uses, always keeping everyone's access.
export const planMove = (args) => planProjectTransfer({ ...args, keepAccess: true });

// Whether the old workspace may be removed after the move. Pure. It refuses unless the
// workspace really is empty afterwards: removing a workspace that still holds another
// project would take that project's people with it.
export function canRemoveSource({ plan, remainingSites }) {
  if (!plan.ok || !plan.source) return { ok: false, reason: 'there is no old workspace' };
  if (plan.source.id === plan.target.id) return { ok: false, reason: 'the old workspace is the target' };
  if (remainingSites > 0) return { ok: false, reason: `it still has ${remainingSites} other project${remainingSites === 1 ? '' : 's'}` };
  return { ok: true };
}

export function describePlan(plan) {
  if (!plan.ok) return plan.problems.map((p) => `✗ ${p}`).join('\n');
  const lines = [
    `Move project "${plan.site.name}" (id ${plan.site.id})`,
    `  from workspace: ${plan.source ? `"${plan.source.name}" (id ${plan.source.id})` : '(none)'}`,
    `  to workspace:   "${plan.target.name}" (id ${plan.target.id})`,
    '',
    'People who keep access (to this project only, shown under "Shared with you"):',
    ...(plan.grants.length ? plan.grants.map((g) => `  + ${g.email}: ${g.workspaceRole} in the old workspace -> project ${g.projectRole}`) : ['  (nobody)']),
  ];
  if (plan.alreadyInTarget.length) lines.push('', 'Already members of the target workspace (no change needed):', ...plan.alreadyInTarget.map((e) => `  = ${e}`));
  lines.push('', plan.removeSource
    ? `The old workspace "${plan.source?.name}" is removed afterwards, but only if it has no other projects. Nobody loses access.`
    : 'Nothing is deleted. The old workspace and its memberships stay as they are.');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : null; };
  const siteId = get('--site'), toId = get('--to'), apply = args.includes('--apply'), removeSource = args.includes('--remove-empty-source');
  if (!siteId || !toId) { console.error('Usage: --site <siteId> --to <workspaceId> [--apply]'); process.exit(2); }

  const { pool } = await import('../db.js');
  try {
    const one = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
    const site = await one('SELECT id, name, workspace_id FROM sites WHERE id = $1', [siteId]);
    const target = await one('SELECT id, name FROM workspaces WHERE id = $1', [toId]);
    const source = site?.workspace_id ? await one('SELECT id, name FROM workspaces WHERE id = $1', [site.workspace_id]) : null;
    const sourceMembers = source ? (await pool.query(
      `SELECT m.user_id, m.role, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.user_id`, [source.id])).rows : [];
    const targetMemberIds = target ? (await pool.query('SELECT user_id FROM workspace_members WHERE workspace_id = $1', [target.id])).rows.map((r) => r.user_id) : [];

    const plan = { ...planMove({ site, source, target, sourceMembers, targetMemberIds }), removeSource };
    console.log(describePlan(plan));
    if (!plan.ok) process.exitCode = 1;
    else if (!apply) console.log('\nDRY RUN: nothing was changed. Re-run with --apply to do it.');
    else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE sites SET workspace_id = $1 WHERE id = $2', [target.id, site.id]);
        for (const g of plan.grants) {
          await client.query(
            `INSERT INTO project_members (site_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (site_id, user_id) DO NOTHING`,
            [site.id, g.userId, g.projectRole]);
        }
        let removed = null;
        if (removeSource) {
          const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM sites WHERE workspace_id = $1', [plan.source.id]);
          const verdict = canRemoveSource({ plan, remainingSites: n });
          if (verdict.ok) {
            // workspace_members rows and any pending workspace invitations go with it
            // (both ON DELETE CASCADE); the people keep the project access granted above.
            // A row that still points at the workspace WITHOUT cascading makes this DELETE
            // fail, which rolls the whole move back rather than leaving it half done.
            await client.query('DELETE FROM workspaces WHERE id = $1', [plan.source.id]);
            removed = plan.source.name;
          } else {
            console.log(`\nOld workspace kept: ${verdict.reason}.`);
          }
        }
        await client.query('COMMIT');
        if (removed) console.log(`\nRemoved the now-empty workspace "${removed}".`);
        console.log(`\nDONE: "${site.name}" is now in "${target.name}"; ${plan.grants.length} ${plan.grants.length === 1 ? 'person keeps' : 'people keep'} access to it.`);
      } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    }
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
}
