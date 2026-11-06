import 'dotenv/config';
import { requireWriteAllowed, announceDatabase } from '../lib/script-guard.js';
import { getGovernanceReport, getKnowledgeHistory, reviewKnowledge } from '../lib/learning-governance.js';

// What the platform learned across projects, why, and a way to hold back anything that looks wrong.
// Shared knowledge only (counts, no tenant data). For ONE project's own memory / history use project-memory.js.
//
//   node server/scripts/learning-governance.js --report                       # all shared knowledge + quality summary
//   node server/scripts/learning-governance.js --history [--id N] [--subject S] [--industry I]
//   node server/scripts/learning-governance.js --quarantine --id N --by "name" --reason "why"   # hide while checking
//   node server/scripts/learning-governance.js --reject     --id N --by "name" --reason "why"   # judged invalid
//   node server/scripts/learning-governance.js --approve    --id N --by "name" --reason "why"   # restore / confirm
//
// Review actions WRITE to the shared tables of whatever DATABASE_URL points at. Never point it at the live database
// without the owner's OK.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

async function main() {
  const f = parseArgs(process.argv.slice(2));
  announceDatabase();
  const action = ['quarantine', 'reject', 'approve'].find((a) => f[a]);
  if (action) {
    requireWriteAllowed(f);
    const state = { quarantine: 'quarantined', reject: 'rejected', approve: 'approved' }[action];
    const row = await reviewKnowledge({ id: f.id, state, by: f.by, reason: f.reason });
    console.log(`#${row.id} ${row.industry}/${row.subject} is now ${row.review_state} (by ${row.reviewed_by}: ${row.review_reason})`);
    return;
  }
  if (f.history) {
    const rows = await getKnowledgeHistory({ id: f.id ? Number(f.id) : null, industry: f.industry || null, subject: f.subject || null });
    if (!rows.length) { console.log('No history recorded yet.'); return; }
    for (const r of rows.reverse()) {
      const change = r.event === 'reviewed' ? `review -> ${r.review_state}` : `${r.from_status ?? '-'} -> ${r.to_status ?? '-'}`;
      console.log(`${day(r.created_at)}  #${r.knowledge_id ?? '?'} ${r.industry}${r.sub_industry ? `/${r.sub_industry}` : ''} ${r.subject}  ${r.event}: ${change}  [${r.actor}]${r.reason ? `  ${r.reason}` : ''}`);
    }
    return;
  }
  if (f.report || true) {
    const { current, recent, quality } = await getGovernanceReport();
    console.log('LEARNING QUALITY');
    console.log(`  patterns ${quality.patterns}, validated now ${quality.validatedNow}, ever validated ${quality.everValidated}, held up ${quality.heldUp}, reversed ${quality.reversed}, reversal rate ${quality.reversalRate ?? 'n/a (nothing validated yet)'}`);
    console.log(`  contradicted ${quality.contradicted}, held back by a person ${quality.heldBack}, outcomes set aside as confounded ${quality.setAsideOutcomes}`);
    console.log(`\nSHARED KNOWLEDGE (${current.length})`);
    for (const r of current) {
      console.log(`  #${r.id} [${r.status}/${r.confidence}${r.review_state !== 'auto' ? `, ${r.review_state}` : ''}] ${r.industry}${r.sub_industry ? `/${r.sub_industry}` : ''} ${r.subject}  seen ${day(r.last_evaluated_at)}${r.expires_at ? `, valid until ${day(r.expires_at)}` : ''}`);
    }
    console.log(`\nRECENT CHANGES (${recent.length})`);
    for (const r of recent) console.log(`  ${day(r.created_at)} #${r.knowledge_id ?? '?'} ${r.subject} ${r.event} ${r.from_status ?? '-'} -> ${r.to_status ?? '-'} [${r.actor}]`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pool } = await import('../db.js');
  main().then(() => pool.end()).then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
}
