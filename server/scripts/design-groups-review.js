#!/usr/bin/env node
// Human review of PROVISIONAL design captures — the only way a site's saved layout-group map
// is changed (design-agent/lib/design-review-store.js). Dry run by default: nothing is written
// without --commit, matching this repo's other repair scripts.
//
//   list      --site 8864                          pending proposals + current map revision
//   show      --site 8864 --id p1abc               one proposal in full (what it would change)
//   approve   --site 8864 --id p1abc --by "Name" --revision 3 [--note "..."] [--commit]
//   reject    --site 8864 --id p1abc --by "Name" [--note "..."] [--commit]
//   rollback  --site 8864 --by "Name" --revision 4 [--note "..."] [--commit]
//   evidence  --site 8864 [--limit 50]             recent validation / integrity decisions
//
// --revision is the layoutGroups.revision you reviewed (shown by `list`). If the map has changed
// since, the command refuses: review again against the new state.
import { createReviewStore, reviewStateOf, listPending, currentRevision, approveProposal, rejectProposal, rollbackLast, ReviewConflict } from '../design-agent/lib/design-review-store.js';
import { getSiteById } from '../store/read.js';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const commit = args.includes('--commit');
const siteId = Number(opt('site'));

function usage(msg) { if (msg) console.error(msg); console.error('Usage: design-groups-review.js <list|show|approve|reject|rollback|evidence> --site <id> ...'); process.exit(2); }
if (!cmd || !siteId) usage();

const site = await getSiteById(siteId);
if (!site) usage(`No site ${siteId}.`);
const siteRoot = site.url_file_map?.siteRoot || {};
const state = reviewStateOf(siteRoot);

try {
  if (cmd === 'list') {
    console.log(`Site ${siteId} "${site.name}" — group map revision ${currentRevision(siteRoot)}`);
    const pending = listPending(state);
    if (!pending.length) console.log('No pending proposals.');
    for (const p of pending) console.log(`  ${p.id}  ${p.kind.padEnd(14)} ${p.pagePath}  group=${p.groupId || '-'}  seen=${p.seen || 1}  since ${p.createdAt}\n      ${p.reason || ''}`);
  } else if (cmd === 'show') {
    console.log(JSON.stringify({ ...state.provisional?.[opt('id')], entry: state.provisional?.[opt('id')]?.entry ? `(${state.provisional[opt('id')].entry.sections?.length} captured sections)` : null }, null, 2));
  } else if (cmd === 'evidence') {
    for (const e of (state.evidence || []).slice(-Number(opt('limit') || 50))) console.log(JSON.stringify(e));
  } else if (['approve', 'reject', 'rollback'].includes(cmd)) {
    const by = opt('by'); const note = opt('note') || null; const id = opt('id');
    if (!by) usage('--by "<your name>" is required: every change is attributed.');
    const revision = Number(opt('revision'));
    if (cmd !== 'reject' && !Number.isInteger(revision)) usage('--revision <n> is required (the group map revision you reviewed).');
    // Dry run: compute on the fresh row without writing.
    const preview = cmd === 'approve' ? approveProposal(siteRoot, id, { by, note, expectedRevision: revision })
      : cmd === 'reject' ? rejectProposal(siteRoot, id, { by, note })
        : rollbackLast(siteRoot, { by, note, expectedRevision: revision });
    const after = preview.designProfile?.layoutGroups;
    console.log(`${cmd} ${id || ''}: would produce group map revision ${after?.revision ?? currentRevision(siteRoot)} with ${after?.groups?.length ?? '(unchanged)'} group(s).`);
    if (!commit) { console.log('Dry run — re-run with --commit to write.'); process.exit(0); }
    const store = createReviewStore();
    if (cmd === 'approve') await store.approve(siteId, id, { by, note, expectedRevision: revision });
    else if (cmd === 'reject') await store.reject(siteId, id, { by, note });
    else await store.rollbackLast(siteId, { by, note, expectedRevision: revision });
    console.log('Written.');
  } else usage(`Unknown command ${cmd}`);
  process.exit(0);
} catch (err) {
  if (err instanceof ReviewConflict) { console.error(`Refused (${err.code}): ${err.message}`); process.exit(1); }
  throw err;
}
