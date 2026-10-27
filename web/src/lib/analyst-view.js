// Pure shaping for the Analyst Outlook / Fixes subpages. No fetching. Every sentence and number here is
// built only from fields the API actually returned; a missing field drops its sentence, never a guess.

export const STEPS = ['Predicted', 'Agent fixing', 'Fixed', 'Result checked'];
export const STAGE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'predicted', label: 'Predicted' },
  { value: 'fixing', label: 'Fixing' },
  { value: 'fixed', label: 'Fixed' },
];

const num = (n) => Number(n).toLocaleString('en-US');
const rounded = (n) => Math.round(n);
const pctWord = (p) => `${p > 0 ? 'up' : 'down'} ${Math.abs(Math.round(p))}%`;

// Plain-words summary for the top of Outlook.
export function buildOutlookStory(outlook) {
  if (!outlook || outlook.status !== 'ok') return null;
  const parts = [];
  const f = outlook.forecast;
  if (f?.clicks?.predicted != null) {
    let s = `Next week you should get about ${num(rounded(f.clicks.predicted))} clicks`;
    if (typeof f.clicks.changePct === 'number' && f.clicks.changePct !== 0) s += `, ${pctWord(f.clicks.changePct)}`;
    if (f.impressions?.predicted != null) s += `, and about ${num(rounded(f.impressions.predicted))} impressions`;
    parts.push(`${s}.`);
  }
  const kw = outlook.keywords?.length || 0;
  if (kw) parts.push(`${kw} keyword${kw === 1 ? ' is' : 's are'} close enough to page 1 to grow.`);
  const up = (outlook.shifts || []).find((x) => x.direction === 'up');
  if (up) parts.push(`${up.text}.`.replace(/\.\.$/, '.'));
  return parts.length ? parts.join(' ') : null;
}

// The line on the right of the story card: how many problems are expected and how many are handled.
export function problemSummary(counts) {
  if (!counts || !counts.expected) return null;
  const bits = [];
  if (counts.handled) bits.push(`${counts.handled} handled`);
  if (counts.needsOk) bits.push(`${counts.needsOk} need${counts.needsOk === 1 ? 's' : ''} your OK`);
  return { headline: `${counts.expected} problem${counts.expected === 1 ? '' : 's'} expected`, detail: bits.join(' · ') };
}

// Chart geometry for history (solid) + future band (dashed), in a width x height box.
export function chartGeometry(forecast, { width = 520, height = 150, pad = 8 } = {}) {
  const hist = (forecast?.history || []).map((h) => h.clicks).filter((v) => v != null);
  const fut = (forecast?.future || []).filter((f) => f.clicks?.predicted != null);
  if (hist.length < 2 || !fut.length) return null;
  const last = hist[hist.length - 1];
  const fvals = [last, ...fut.map((f) => f.clicks.predicted)];
  const lo = [last, ...fut.map((f) => f.clicks.low ?? f.clicks.predicted)];
  const hi = [last, ...fut.map((f) => f.clicks.high ?? f.clicks.predicted)];
  const all = [...hist, ...hi, ...lo];
  const max = Math.max(...all), min = Math.min(...all);
  const span = max - min || 1;
  const n = hist.length + fut.length;
  const x = (i) => pad + (i / (n - 1)) * (width - pad * 2);
  const y = (v) => height - 14 - ((v - min) / span) * (height - 28);
  const at = (i, v) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  const base = hist.length - 1;
  return {
    width, height,
    history: hist.map((v, i) => at(i, v)).join(' '),
    future: fvals.map((v, i) => at(base + i, v)).join(' '),
    band: [...hi.map((v, i) => at(base + i, v)), ...lo.map((v, i) => at(base + i, v)).reverse()].join(' '),
    splitX: x(base),
  };
}

export function accuracyLine(accuracy) {
  if (!accuracy || accuracy.withinPct == null || !accuracy.weeksChecked) return null;
  return `Last ${accuracy.weeksChecked} prediction${accuracy.weeksChecked === 1 ? ' was' : 's were'} within ${Math.round(accuracy.withinPct)}% on average`;
}

export const rangeText = (m) => (m && m.low != null && m.high != null ? `likely between ${num(rounded(m.low))} and ${num(rounded(m.high))}` : null);
export const changeText = (m) => (m && typeof m.changePct === 'number' && m.thisWeek != null
  ? `${m.changePct > 0 ? '+' : m.changePct < 0 ? '−' : ''}${Math.abs(Math.round(m.changePct))}% vs this week (${num(rounded(m.thisWeek))})` : null);

export function filterProblems(problems, filter) {
  const list = problems || [];
  if (filter === 'all' || !filter) return list;
  if (filter === 'predicted') return list.filter((p) => p.stage === 'predicted' || p.stage === 'needs-ok');
  return list.filter((p) => p.stage === filter);
}

export function filterCounts(problems) {
  const list = problems || [];
  return { all: list.length, predicted: filterProblems(list, 'predicted').length, fixing: filterProblems(list, 'fixing').length, fixed: filterProblems(list, 'fixed').length };
}

// Stepper cells for one problem: state is done | current | todo, and a needs-ok problem shows its first step as "Needs your OK".
export function stepperFor(problem) {
  const step = Math.min(Math.max(problem?.step ?? 0, 0), STEPS.length - 1);
  const needsOk = problem?.stage === 'needs-ok';
  return STEPS.map((label, i) => ({
    label: needsOk && i === 0 ? 'Needs your OK' : label,
    state: i < step ? 'done' : i === step ? 'current' : 'todo',
    alert: needsOk && i === step,
  }));
}

// The six-cell strip on Fixes. `clicksWonBack` only appears when it is a real number.
export function fixesStrip(counts) {
  if (!counts) return [];
  const c = counts;
  return [
    { label: 'Predicted', value: c.predicted ?? 0, sub: 'likely in the next days', tone: 'bad' },
    { label: 'Agent fixing', value: c.fixing ?? 0, sub: 'ships at 07:00', tone: 'warn' },
    { label: 'Fixed', value: c.fixed ?? 0, sub: 'done by the agent', tone: 'good' },
    { label: 'Waiting for your OK', value: c.needsOk ?? 0, sub: 'changes a page design', tone: 'bad' },
    { label: 'Solved this month', value: c.solvedThisMonth ?? 0, sub: c.clicksWonBack ? `about ${num(rounded(c.clicksWonBack))} clicks won back` : 'results are checked after each fix', tone: 'neutral' },
  ];
}

// Badge for the Fixes tab: problems that still need a person or are still ahead of the agent.
export function fixesBadge(counts) {
  const n = (counts?.needsOk || 0) + (counts?.predicted || 0);
  return n > 0 ? n : null;
}

export function whenLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((now - d) / 864e5);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  return `${Math.floor(days / 7)} weeks ago`;
}
