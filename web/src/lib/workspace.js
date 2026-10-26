// Shared vocabulary for the workspace screens: roles, permission wording and the
// plain-language goal picker. Everything a non-technical person reads lives here,
// so the switcher, the guided flow, Add project and the Workspace page never
// describe the same thing in different words.

export const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Read-only', platform: 'Platform admin' };

// Who may change things in a workspace. The server enforces the same rule; this
// only decides which buttons to show.
export const canManageWorkspace = (role) => role === 'owner' || role === 'admin' || role === 'platform';
export const isWorkspaceOwner = (role) => role === 'owner' || role === 'platform';

export const PERMISSIONS = {
  owner: { label: 'Owner', description: 'Full control. Add projects, manage people, hand over the workspace.' },
  admin: { label: 'Admin', description: 'Can add projects, set goals and give or remove access.' },
  member: { label: 'Read-only', description: 'Can open every project and see the results, but cannot change anything.' },
};

// The same permissions when they apply to chosen projects rather than a whole workspace.
export const SCOPED_PERMISSIONS = {
  admin: { label: 'Admin', description: 'Can set the goal, create API tokens and give or remove access to these projects.' },
  member: { label: 'Read-only', description: 'Can open these projects and see the results, but cannot change anything.' },
};

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ───────── goals ─────────
// The keys match the server (server/store/workspaces.js GOAL_KEYS / GOAL_GROWTH / GOAL_MONTHS).
export const GOAL_CHOICES = [
  { key: 'google_visitors', title: 'More visitors from Google', description: 'More people finding your website in search.' },
  { key: 'enquiries', title: 'More enquiries and sales', description: 'More people getting in touch or buying.' },
  { key: 'ai_answers', title: 'Show up in AI answers', description: 'Be recommended by ChatGPT, Perplexity and others.' },
  { key: 'key_rankings', title: 'Rank higher for key searches', description: 'Move up for the searches that matter to you.' },
  // Not everyone's goal is one of the four. A custom goal carries its own
  // sentence and no growth choice (see migration 196) — "how long" still applies.
  { key: 'custom', title: 'Something else', description: 'Write your goal in your own words.' },
];
export const CUSTOM_GOAL = 'custom';
export const GOAL_CUSTOM_MAX = 140; // matches GOAL_CUSTOM_MAX on the server
export const GROWTH_CHOICES = [
  { key: 'steady', title: 'Steady', description: 'About 20% more' },
  { key: 'fast', title: 'Fast', description: 'About 50% more' },
  { key: 'ambitious', title: 'Ambitious', description: 'Double it' },
];
export const MONTH_CHOICES = [3, 6, 12];
// A goal is a list: any number of the cards can be ticked. `goals` is the list in the
// order they were ticked; `goal` (the first) is what older rows and code still carry.
export const DEFAULT_GOAL = { goals: ['google_visitors'], growth: 'fast', months: 6, customText: '' };

// The goals of any goal object, whichever shape it has (rows from before several goals
// existed only have `goal`).
export const goalsOf = (g) => (Array.isArray(g?.goals) && g.goals.length ? g.goals : g?.goal ? [g.goal] : []);

// Whether a goal is complete enough to save: at least one tick, and the words if
// "Something else" is ticked.
export const goalComplete = (g) => {
  const list = goalsOf(g);
  if (!list.length) return false;
  return !list.includes(CUSTOM_GOAL) || Boolean(String(g.customText || '').trim());
};

// What each goal reads as inside a longer sentence.
const GOAL_PHRASE = {
  google_visitors: 'visitors from Google',
  enquiries: 'enquiries and sales',
  ai_answers: 'recommendations in AI answers',
  key_rankings: 'rankings for your key searches',
};
const joinList = (items) => (items.length <= 1 ? items[0] || '' : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// "Grow visitors from Google by about 50% in 6 months."
// With several goals: "Grow visitors from Google and enquiries and sales by about 50% in 6 months."
export function goalSentence(g) {
  const { growth, months, customText } = g || {};
  const list = goalsOf(g);
  const when = `${months} months`;
  const text = String(customText || '').trim();
  const presets = list.filter((k) => k !== CUSTOM_GOAL);
  const hasCustom = list.includes(CUSTOM_GOAL);

  // Your own words, shown back as written, with the timeframe added only when you
  // didn't write one yourself.
  const own = () => {
    if (!text) return '';
    const ended = /[.!?]$/.test(text);
    return /\bmonth|\byear|\bweek/i.test(text) ? `${text}${ended ? '' : '.'}` : `${text}${ended ? '' : ','} in ${when}.`;
  };
  if (!presets.length) return hasCustom ? own() : '';

  const amount = { steady: 'about 20%', fast: 'about 50%', ambitious: null }[growth];
  const double = growth === 'ambitious';
  let sentence;
  if (presets.length === 1) {
    switch (presets[0]) {
      case 'google_visitors': sentence = double ? `Double your visitors from Google in ${when}.` : `Grow visitors from Google by ${amount} in ${when}.`; break;
      case 'enquiries': sentence = double ? `Double your enquiries and sales in ${when}.` : `Get ${amount} more enquiries and sales in ${when}.`; break;
      case 'ai_answers': sentence = double ? `Be recommended in AI answers twice as often in ${when}.` : `Be recommended in AI answers ${amount} more often in ${when}.`; break;
      case 'key_rankings': sentence = double ? `Move up for your key searches, twice as fast, in ${when}.` : `Move up for your key searches, ${amount} better, in ${when}.`; break;
      default: sentence = '';
    }
  } else {
    const things = joinList(presets.map((k) => GOAL_PHRASE[k]));
    sentence = double ? `Double ${things} in ${when}.` : `Grow ${things} by ${amount} in ${when}.`;
  }
  return hasCustom && text ? `${sentence} Also: ${text.replace(/[.!?]$/, '')}.` : sentence;
}

// The same goal for a list row, without the full stop.
export const goalLine = (g) => goalSentence(g).replace(/\.$/, '');
