import 'dotenv/config';
import { requireWriteAllowed, announceDatabase } from '../lib/script-guard.js';
import { getProjectMemory, snapshotProjectMemory, MEMORY_SECTIONS } from '../lib/project-memory.js';
import { listMemoryVersions } from '../store/project-memory-log.js';
import { getExecutionLifecycle, getBehaviourLearning } from '../lib/behaviour-learning.js';

// Shows what the platform knows about ONE project: each memory section's status, where it came from, how fresh it is,
// and the headline facts. Read-only unless --snapshot is given, which records a new version for every section whose
// content changed (the same thing onboarding does).
//
//   node server/scripts/project-memory.js --site-id 8862
//   node server/scripts/project-memory.js --site-id 8862 --versions        # the version log
//   node server/scripts/project-memory.js --site-id 8862 --snapshot        # record changed sections
//   node server/scripts/project-memory.js --site-id 8862 --json            # full machine-readable output
//   node server/scripts/project-memory.js --site-id 8862 --lifecycle       # where each piece of work stands, stage by stage
//   node server/scripts/project-memory.js --site-id 8862 --experience      # what the history says about each generator
//
// It prints counts, status and a few headline values, never a whole design profile or any secret.

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

const ICON = { ok: 'ok   ', empty: 'empty', error: 'ERROR' };

function headline(section, data) {
  if (!data) return '';
  switch (section) {
    case 'business': return `industries: ${data.industries.join(', ') || '-'} | markets: ${data.markets.join(', ') || '-'} | goals: ${data.goals.length}`;
    case 'technical': return `repo connected: ${data.repoConnected} | finding groups: ${data.categories.length} | technology: ${data.technology.map((t) => t.subject).join(', ') || '-'}`;
    case 'design': return `profile: ${data.profilePresent ? (data.usable ? 'usable' : 'present but NOT usable') : 'none'} | v${data.profileVersion ?? '-'} | gaps: ${data.captureGaps.length} | templates: ${data.componentTemplates.join(', ') || '-'}`;
    case 'search': return `baseline: ${data.baselineCapturedAt ? 'yes' : 'no'} | competitors: ${data.competitorDomains.length} | geo score: ${data.geoScore ?? '-'} | keyword backlog: ${JSON.stringify(data.keywordBacklog)}`;
    case 'history': return `drafts: ${data.drafts?.total ?? 0} (implemented ${data.drafts?.implemented ?? 0}) | recent deployments: ${data.recentDeployments.length} | generators with history: ${data.behaviour?.generators.length ?? 'n/a'}`;
    default: return '';
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  announceDatabase();
  const siteId = Number(flags['site-id']);
  if (!siteId) {
    console.error('Usage: node server/scripts/project-memory.js --site-id <id> [--versions] [--snapshot] [--json]');
    process.exit(1);
  }

  if (flags.versions) {
    const rows = await listMemoryVersions(siteId, { limit: 50 });
    if (!rows.length) console.log(`Site ${siteId}: no memory versions recorded yet.`);
    for (const r of rows) console.log(`${new Date(r.created_at).toISOString()}  ${r.section.padEnd(9)} v${String(r.version).padEnd(3)} ${r.reason.padEnd(10)} ${r.content_hash.slice(0, 10)}  ${JSON.stringify(r.digest)}`);
    return;
  }

  if (flags.lifecycle) {
    const { stages, summary } = await getExecutionLifecycle(siteId, { limit: 30 });
    if (flags.json) { console.log(JSON.stringify({ summary, stages }, null, 2)); return; }
    const i = summary.impact;
    console.log(`Project ${siteId}: ${summary.total} most recent drafts, each stage counted on its own\n`);
    console.log(`  checks passed ${summary.validationPassed} | PR opened ${summary.prOpened} | merged ${summary.merged} | deployment verified ${summary.deploymentVerified}`);
    console.log(`  (merged but deployment not detected ${summary.deploymentNotDetected}, still pending ${summary.deploymentPending}, not tracked ${summary.mergedButUntracked})`);
    console.log(`  impact measured: ${i.positive} better, ${i.negative} worse, ${i.inconclusive} inconclusive, ${i.legacy} before verdicts existed | waiting ${i.pending} | insufficient data ${i.insufficientData} | not measurable ${i.unmeasurable}`);
    console.log(`  abandoned ${summary.abandoned}\n`);
    for (const s of stages) console.log(`  #${String(s.draftId).padEnd(5)} ${String(s.actionType).padEnd(16)} checks:${s.validated.padEnd(12)} pr:${s.prOpened ? 'y' : '-'} merged:${s.merged ? 'y' : '-'} deploy:${String(s.deployment ?? '-').padEnd(12)} impact:${String(s.impact ?? '-').padEnd(17)} -> ${s.abandoned ? 'abandoned' : s.furthest}`);
    return;
  }

  if (flags.experience) {
    const b = await getBehaviourLearning(siteId);
    if (flags.json) { console.log(JSON.stringify(b, null, 2)); return; }
    if (!b.generators.length) console.log(`Project ${siteId}: no recorded generator history yet. Nothing is assumed.`);
    for (const g of b.generators) console.log(`[${g.technicalEvidence}/${g.impactEvidence}]${g.demoted ? ' HELD' : ''}  ${g.text}\n`);
    return;
  }

  if (flags.snapshot) {
    requireWriteAllowed(flags);
    const r = await snapshotProjectMemory(siteId, { reason: 'manual' });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const memory = await getProjectMemory(siteId);
  if (!memory) { console.error(`Site ${siteId} not found.`); process.exit(1); }
  if (flags.json) { console.log(JSON.stringify(memory, null, 2)); return; }

  console.log(`Project ${memory.siteId} (workspace ${memory.workspaceId ?? '-'}), loaded ${memory.loadedAt}\n`);
  for (const section of MEMORY_SECTIONS) {
    const s = memory.sections[section];
    const when = s.provenance.asOf ? `as of ${s.provenance.asOf.slice(0, 10)}` : 'no date';
    console.log(`${ICON[s.status]}  ${section.padEnd(9)} ${s.provenance.freshness.padEnd(7)} ${when}`);
    if (s.status === 'ok') console.log(`           ${headline(section, s.data)}`);
    if (s.status === 'error') console.log(`           ${s.reason}`);
    if (s.status === 'ok') console.log(`           from: ${s.provenance.sources.join(', ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pool } = await import('../db.js');
  main().then(() => pool.end()).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
