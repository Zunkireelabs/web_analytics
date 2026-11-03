// View logic for the staff card "Get-started sign-ups" (Account settings -> Platform). The server sends the facts
// (server/routes/signup-progress.js); everything here only turns them into the words and numbers the card shows.

export const STEP_NAMES = ['Email', 'Code', 'Website', 'Brand', 'Company country', 'Run location', 'Brand profile', 'Goals', 'Markets', 'Topics', 'Prompts'];
export const STEP_COUNT = STEP_NAMES.length;

const DAY = 24 * 60 * 60 * 1000;
const dayCount = (ms) => Math.round(ms / DAY);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// Rows whose sign-up is over (they finished, whatever came next). The rest are the unfinished people.
const FINISHED = new Set(['waiting', 'trial', 'ended', 'client']);
export const isFinished = (row) => FINISHED.has(row.status);

// One bar per step for "how many reach each step". `hot` marks the step with the biggest drop from the one before.
export function funnelBars(funnel, maxPx = 56) {
  const top = Math.max(1, ...funnel.map((f) => f.reached));
  let hot = -1;
  let worst = 0;
  funnel.forEach((f, i) => {
    const drop = i === 0 ? 0 : funnel[i - 1].reached - f.reached;
    if (drop > worst) { worst = drop; hot = i; }
  });
  return funnel.map((f, i) => ({ step: f.step, name: f.name, reached: f.reached, px: Math.max(6, Math.round((f.reached / top) * maxPx)), hot: i === hot }));
}

// The five numbers above the list. `started`, `reminded` and `cameBack` are the server's counts for the window; the other two
// are read from the rows the list is made of.
export function summaryCounts(data) {
  const rows = data?.rows || [];
  const c = data?.counts || {};
  const live = rows.filter((r) => !isFinished(r));
  return {
    started: c.started ?? rows.length,
    due: live.filter((r) => r.status !== 'unconfirmed' && r.reminder?.state === 'due').length,
    reminded: c.reminded ?? 0,
    unconfirmed: rows.filter((r) => r.status === 'unconfirmed').length,
    cameBack: c.cameBack ?? 0,
  };
}

const REMINDED = new Set(['sent', 'expired', 'back']);
const GOALS_STEP = 8;
// Every pill is a test on one row. "All" is everyone the server returned, finished people included; the others are people still in progress.
const TESTS = {
  due: (r) => !isFinished(r) && r.status !== 'unconfirmed' && r.reminder?.state === 'due',
  scheduled: (r) => !isFinished(r) && r.reminder?.state === 'scheduled',
  reminded: (r) => REMINDED.has(r.reminder?.state),
  goals: (r) => !isFinished(r) && (r.step || 1) >= GOALS_STEP,
  unconfirmed: (r) => r.status === 'unconfirmed',
  all: () => true,
};
export const FILTERS = [
  { key: 'due', label: 'Reminder due' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'reminded', label: 'Reminded' },
  { key: 'goals', label: 'Got to Goals or later' },
  { key: 'unconfirmed', label: 'Not confirmed' },
  { key: 'all', label: 'All' },
];
export const SORTS = [
  { key: 'quiet', label: 'Longest quiet first' },
  { key: 'recent', label: 'Most recent first' },
  { key: 'furthest', label: 'Furthest along first' },
];

export function filterCounts(rows) {
  return Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter(TESTS[f.key]).length]));
}

// The pill the list opens on: reminders that are due if there are any, otherwise everyone.
export const defaultFilter = (rows) => (rows.some(TESTS.due) ? 'due' : 'all');

const time = (iso) => (iso ? new Date(iso).getTime() : 0);
export function filterRows(rows, filter, query = '', sort = 'quiet') {
  const q = query.trim().toLowerCase();
  const test = TESTS[filter] || TESTS.all;
  const out = rows.filter((r) => test(r) && (!q || [r.email, r.brand, r.website].some((v) => (v || '').toLowerCase().includes(q))));
  const by = {
    quiet: (a, b) => time(a.lastActiveAt) - time(b.lastActiveAt),
    recent: (a, b) => time(b.lastActiveAt) - time(a.lastActiveAt),
    furthest: (a, b) => (b.step || 0) - (a.step || 0) || time(a.lastActiveAt) - time(b.lastActiveAt),
  };
  return out.sort(by[sort] || by.quiet);
}

// Who can be ticked and reminded: confirmed people still in progress, not stopped, not real clients (and with an id to send to).
export const canRemind = (row) => !isFinished(row) && row.status !== 'unconfirmed' && row.userId != null && !['muted', 'client'].includes(row.reminder?.state);
// Why someone cannot be reminded, in words for the result note.
export const whyNot = (row) => (row.status === 'client' ? 'already a client' : row.status === 'unconfirmed' || row.userId == null ? 'email not confirmed' : row.reminder?.state === 'muted' ? 'reminders stopped' : 'finished');

// "4 reminders sent, 1 could not be sent: a@b.co (why). 2 skipped: ..."
export function bulkRemindNote({ sent = 0, failed = [], skipped = [] }) {
  const parts = [];
  if (sent || (!failed.length && !skipped.length)) parts.push(`${plural(sent, 'reminder', 'reminders')} sent`);
  if (failed.length) parts.push(`${failed.length} could not be sent: ${failed.map((f) => `${f.email}${f.reason ? ` (${f.reason})` : ''}`).join(', ')}`);
  if (skipped.length) parts.push(`${skipped.length} skipped: ${skipped.map((s) => `${s.email} (${s.reason})`).join(', ')}`);
  return parts.join(', ');
}

// "Reached": the step name and how far along, plus one flag per step for the progress dots.
export function reached(row) {
  const step = Math.min(Math.max(row.step || 1, 1), STEP_COUNT);
  return { name: row.stepName || STEP_NAMES[step - 1], of: `${step}/${STEP_COUNT}`, dots: STEP_NAMES.map((_, i) => i < step) };
}

export const initial = (row) => ((row.brand || row.email || '?')[0] || '?').toUpperCase();

// "What they told us" as one short line, e.g. "United Kingdom · Smart lighting +1 · 2 competitors".
export function gotLine(a) {
  if (!a) return '';
  const parts = [];
  if (a.entityCountry) parts.push(a.entityCountry);
  const products = a.profile?.products || [];
  if (products.length) parts.push(products.length > 1 ? `${products[0]} +${products.length - 1}` : products[0]);
  const comps = a.profile?.competitors || [];
  if (comps.length) parts.push(plural(comps.length, 'competitor', 'competitors'));
  if (a.goals?.length) parts.push(plural(a.goals.length, 'goal picked', 'goals picked'));
  if (a.markets?.length) parts.push(plural(a.markets.length, 'market', 'markets'));
  if (a.topics?.length) parts.push(plural(a.topics.length, 'topic', 'topics'));
  if (!parts.length && a.brand) parts.push(a.brand);
  return parts.slice(0, 3).join(' · ');
}

// "Last active": whole days since they last answered.
export function lastActive(iso, now = Date.now()) {
  if (!iso) return '';
  const d = dayCount(now - new Date(iso).getTime());
  if (d < 1) return 'Today';
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

// When a reminder goes out: "Sends today", "Sends tomorrow", "In 5 days".
export function dueWording(dueAt, now = Date.now()) {
  if (!dueAt) return '';
  const d = Math.ceil((new Date(dueAt).getTime() - now) / DAY);
  if (d <= 0) return 'Sends today';
  return d === 1 ? 'Sends tomorrow' : `In ${d} days`;
}

// The reminder column: a dot colour (`tone`) and the words next to it.
export function reminderStatus(row, now = Date.now()) {
  const r = row.reminder || { state: 'none' };
  if (row.status === 'unconfirmed') return { tone: 'none', text: 'Email not confirmed' };
  switch (r.state) {
    case 'scheduled': return { tone: 'soon', text: dueWording(r.dueAt, now) };
    case 'due': return { tone: 'due', text: dueWording(r.dueAt, now).replace('Sends today', 'Due today') };
    case 'sent': {
      const open = r.linkExpiresAt && new Date(r.linkExpiresAt).getTime() > now;
      return { tone: 'sent', text: `Sent ${fmtDay(r.sentAt)} · ${open ? 'link open' : 'link expired'}` };
    }
    case 'expired': return { tone: 'sent', text: 'Link expired' };
    case 'back': return { tone: 'back', text: 'Came back' };
    case 'muted': return { tone: 'none', text: 'Reminders stopped' };
    case 'client': return { tone: 'none', text: 'No reminders' };
    default: return { tone: 'none', text: 'No reminder yet' };
  }
}

// The sentence at the top of the side panel.
export function summaryLine(row, linkDays, now = Date.now()) {
  const r = row.reminder || { state: 'none' };
  const head = `Started ${fmtDay(row.startedAt)}, last active ${lastActive(row.lastActiveAt, now).toLowerCase()}.`;
  const link = `its link works for ${plural(linkDays, 'day', 'days')}`;
  switch (r.state) {
    case 'scheduled':
    case 'due': return `${head} The reminder ${dueWording(r.dueAt, now).replace(/^Sends /, 'goes out ').replace(/^In /, 'goes out in ')} and ${link}.`;
    case 'sent': return `${head} We emailed a reminder on ${fmtDay(r.sentAt)}; ${r.linkExpiresAt && new Date(r.linkExpiresAt).getTime() > now ? `the link works until ${fmtDay(r.linkExpiresAt)}` : 'the link has expired, so they sign in with a code'}.`;
    case 'back': return `${head} They came back after the reminder.`;
    case 'muted': return `${head} Reminders are stopped for this person.`;
    case 'client': return `${head} This is a real client, so they never get these reminders.`;
    default: return row.status === 'unconfirmed'
      ? `${head} They never confirmed their email, so nothing is sent automatically. You can still send a reminder by hand.`
      : `${head} No reminder is scheduled.`;
  }
}

const humanize = (k) => { const s = String(k).replace(/[_-]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

// The side panel's step list: one entry per step with its state (done | now | todo) and what they answered.
export function stepList(row) {
  const a = row.answers || {};
  const step = Math.min(Math.max(row.step || 1, 1), STEP_COUNT);
  const done = isFinished(row);
  const chips = (list, draft = false) => (list || []).map((text) => ({ text, draft }));
  const run = a.run ? [a.run.country, a.run.language, a.run.city].filter(Boolean).join(' · ') : '';
  const detail = [
    { text: row.email },
    { text: row.verified ? 'Confirmed' : 'Not confirmed yet' },
    { text: a.website },
    { text: a.brand },
    { text: a.entityCountry },
    { text: run },
    { chips: [...chips(a.profile?.products), ...chips(a.profile?.personas)], text: (a.profile?.competitors || []).length ? `Competitors: ${a.profile.competitors.join(', ')}` : '' },
    { chips: (a.goals || []).map((g) => ({ text: humanize(g.key), draft: !g.confirmed })), text: (a.goals || []).some((g) => !g.confirmed) ? 'Picked but not confirmed' : '' },
    { chips: chips(a.markets) },
    { chips: chips(a.topics) },
    { text: a.promptCount ? plural(a.promptCount, 'prompt', 'prompts') : '' },
  ];
  return STEP_NAMES.map((name, i) => {
    const n = i + 1;
    const state = done || n < step ? 'done' : n === step ? 'now' : 'todo';
    return { n, name, state, label: state === 'now' ? `${name} · stopped here` : name, ...detail[i], chips: state === 'todo' ? [] : detail[i].chips || [], text: state === 'todo' ? '' : detail[i].text || '' };
  });
}

// Reminders only concern unfinished people who are not real clients. A muted person can have them switched back on.
export const actions = (row) => ({ canAct: !isFinished(row), muted: row.reminder?.state === 'muted' });
