// THE ACCEPTANCE RUNNER: each acceptance scenario of the autonomous delivery system, mapped to the specific tests that prove it, run one by one, with a
// verdict table. A scenario FAILS if any of its tests fails OR if its pattern matches no test at all (a renamed test must not turn into a silent pass).
//
//   DB_SSL=off DATABASE_URL=postgres://postgres:<local password>@localhost:55432/srtest node server/scripts/run-acceptance.js [--write docs/acceptance/<file>.md]
//
// It refuses to run against any database but the throwaway local one, because some scenarios use real SQL. Everything runs locally: fake GitHub, stubbed AI calls.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1):55432\/srtest/.test(url)) {
  console.error('Refusing to run: DATABASE_URL must point at the throwaway local database (localhost:55432/srtest). Never a real one.');
  process.exit(2);
}

// [id, what it proves, [[test file, name pattern (regex source, no apostrophes) or null for the whole file], ...]]
export const SCENARIOS = [
  ['G1', 'Multiple agents on one client never conflict: a changed file is rebuilt, a held path is blocked', [['server/lib/content-index/content-index.test.js', 'file that changed after the read is REBUILT|path another in-flight item holds is BLOCKED']]],
  ['G2', 'Up to five validated blogs are consolidated into ONE delivery per client (ceiling, never a quota)', [['server/lib/blog-cycle/blog-cycle.test.js', 'five articles, one bad and one throwing|ceiling stops at five VALIDATED'], ['server/lib/delivery-consolidation.test.js', 'pushed work whose PR opens on this attempt ends as delivered']]],
  ['G3', 'Existing published blogs, drafts, open PRs and merged content are never duplicated', [['server/lib/content-index/content-index.test.js', 'each of the five states is caught|URL-pattern approach would find zero'], ['server/lib/blog-cycle/six-clients.db.test.js', null]]],
  ['G4', 'A design-sensitive change passes REAL design validation (real browser, template baseline, both widths)', [['server/lib/design-protection/design-protection.browser.test.js', 'two agreeing pages give a ready baseline|correct FAQ in the site'], ['server/lib/design-protection/decide-compare-repair.test.js', null], ['server/lib/design-protection/design-protection.browser.test.js', 'a good FAQ passes end to end']]],
  ['G5', 'A failed fix is repaired within limits or safely blocked with its content kept', [['server/lib/design-protection/design-protection.browser.test.js', 'wide table is repaired|restyles the nav is quarantined|second H1 is repaired'], ['server/lib/blog-cycle/blog-cycle.test.js', 'failing article is repaired with the feedback|repairs are bounded']]],
  ['G6', 'A GitHub rate limit loses nothing: the work is preserved and conditional reads cost no quota', [['server/lib/delivery-consolidation.test.js', 'GitHub rate limit while opening the PR'], ['server/github/client.test.js', 'conditional GETs']]],
  ['G7', 'A worker restart or a server deploy keeps progress; a finished answer is never lost', [['server/store/llm-requests.recovery.test.js', null], ['server/lib/claude-code-worker.deploy.test.js', null], ['server/lib/claude-code-worker.test.js', 'finished answer survives']]],
  ['G8', 'Every client gets an independent delivery record; one failing never stops the others', [['server/lib/delivery-cycle.test.js', 'every project gets a closed record'], ['server/lib/delivery-consolidation.test.js', 'one project failing does not stop the other five'], ['server/lib/blog-cycle/six-clients.db.test.js', null]]],
  ['G9', 'A blocked PR produces a preserved delivery: branch, items, exact error, recovery command', [['server/lib/delivery-consolidation.test.js', 'PRESERVED with branch|preserved delivery reads as a plain|preserved work is recorded with the exact error']]],
  ['G10', 'Finishing the approved backlog triggers new research; an empty backlog never stops it', [['server/lib/topic-research/topic-research.test.js', 'EMPTY BACKLOG|ALL clients independently']]],
  ['G11', 'No quota filling: fewer eligible ships fewer, none ships none, nothing is manufactured', [['server/lib/blog-cycle/blog-cycle.test.js', 'fewer eligible than the ceiling ships fewer'], ['server/lib/topic-research/topic-research.test.js', 'no quota']]],
  ['G12', 'Cannibalisation is rejected, naming the page', [['server/lib/blog-cycle/blog-cycle.test.js', 'cannibalisation: a page already ranking']]],
  ['G13', 'A fabricated claim is blocked and quarantined; sibling articles still ship', [['server/lib/blog-cycle/blog-cycle.test.js', 'statistics with no verified source are a BLOCKING fabrication'], ['server/lib/blog-cycle/six-clients.db.test.js', 'failed article is quarantined with its content kept while its siblings ship']]],
  ['G14', 'Abandoned drafts keep their content and never block a new topic', [['server/lib/content-index/content-index.test.js', 'an abandoned draft does not block its topic'], ['server/lib/topic-research/topic-research.db.test.js', 'quarantine keeps the failed article']]],
  ['R1', 'Business relevance decides, not keyword volume alone (low volume + high fit passes; high volume + off-business fails)', [['server/lib/blog-cycle/blog-cycle.test.js', 'LOW-volume topic that fits the business is accepted|HIGH-volume topic that does not fit the business is rejected|volume cannot rescue']]],
  ['R2', 'A missing design baseline is captured first; it is never assumed to pass', [['server/lib/design-protection/protect.test.js', 'NO baseline: capture is requested and the change WAITS|page type with no captured template yet waits']]],
  ['R3', 'pr_opened, human_merged and production_verified are separate, recorded facts (real database)', [['server/lib/delivery-states.test.js', null]]],
  ['R4', 'A project with zero eligible work still gets a completed daily record', [['server/lib/delivery-cycle.test.js', 'nothing eligible, nothing blocked: no-work|every project gets a closed record']]],
  ['R5', 'Database failure: the process survives, nothing recorded is lost, recording resumes', [['server/lib/db-fault.test.js', null]]],
  ['R6', 'Git safety: an agent can never merge; merges by an app account are alerted', [['server/store/drafts-agent-cannot-merge.test.js', null], ['server/lib/delivery-states.test.js', 'merge by an app account is CRITICAL']]],
  ['R7', 'Per-client isolation: design baselines, content index, research and decisions never cross clients', [['server/lib/design-protection/protect.test.js', 'per-tenant'], ['server/lib/blog-cycle/six-clients.db.test.js', null]]],
  ['R8', 'The window, the cron lines and the deadline steps cannot drift apart', [['server/lib/worker-session.test.js', 'the cron line follows the window'], ['server/lib/delivery-consolidation.test.js', 'deadline steps follow the window']]],
];

function runOne(file, pattern) {
  const args = ['--experimental-test-module-mocks', '--test'];
  if (pattern) args.push(`--test-name-pattern=${pattern}`);
  args.push(file);
  const r = spawnSync(process.execPath, args, { env: { ...process.env, DB_SSL: 'off' }, encoding: 'utf8', timeout: 240_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const num = (label) => Number((out.match(new RegExp(`ℹ ${label} (\\d+)`)) || [])[1] || 0);
  return { code: r.status, tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), tail: out.split('\n').filter((l) => /✖|Error/.test(l)).slice(0, 4).join(' | ') };
}

const results = [];
for (const [id, claim, runs] of SCENARIOS) {
  const parts = runs.map(([file, pattern]) => ({ file, pattern, ...runOne(file, pattern) }));
  const totalPass = parts.reduce((n, p) => n + p.pass, 0);
  const bad = parts.filter((p) => p.code !== 0 || p.fail > 0);
  const empty = parts.filter((p) => p.pass === 0);
  const ok = bad.length === 0 && empty.length === 0;
  results.push({ id, claim, ok, totalPass, parts, why: bad.length ? `failing: ${bad.map((p) => p.file).join(', ')}` : empty.length ? `matched no passing test: ${empty.map((p) => `${p.file} /${p.pattern}/`).join(', ')}` : '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${String(totalPass).padStart(3)} test(s)  ${claim}${ok ? '' : `\n        ${results.at(-1).why}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios pass`);

const wi = process.argv.indexOf('--write');
if (wi > 0 && process.argv[wi + 1]) {
  const md = ['# Acceptance evidence', '', `Generated ${new Date().toISOString()} against the throwaway local database. ${results.length - failed.length}/${results.length} scenarios pass.`, '',
    '| Scenario | Result | Tests | What it proves |', '|---|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.totalPass} | ${r.claim} |`), '',
    '## Tests behind each scenario', '', ...results.flatMap((r) => [`### ${r.id}: ${r.claim}`, ...r.parts.map((p) => `- \`${p.file}\`${p.pattern ? ` matching \`${p.pattern}\`` : ' (whole file)'}: ${p.pass} passed${p.skipped ? `, ${p.skipped} skipped` : ''}`), ''])].join('\n');
  mkdirSync(dirname(process.argv[wi + 1]), { recursive: true }); writeFileSync(process.argv[wi + 1], md);
  console.log(`written: ${process.argv[wi + 1]}`);
}
process.exit(failed.length ? 1 : 0);
