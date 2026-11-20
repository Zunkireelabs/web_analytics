import { reviewLists, historyByMonth } from './content-history.js';

// The kinds of content the toggle at the top of the Content page filters by. It filters all three steps (Ideas, Drafted, History)
// together. `all` shows everything. Drafts of kinds without their own button (content updates, blog images) show under All.
export const CONTENT_TYPES = [
  { key: 'all', label: 'All', generatorId: null },
  { key: 'landing', label: 'Landing pages', generatorId: 'landing-page' },
  { key: 'translation', label: 'Translations', generatorId: 'translation' },
  { key: 'blog', label: 'Blog posts', generatorId: 'blog-outline' },
];
export const typeFromParam = (v) => (CONTENT_TYPES.some((t) => t.key === v) ? v : 'all');
export const generatorOfType = (key) => CONTENT_TYPES.find((t) => t.key === key)?.generatorId || null;

// Drafts (already limited to content) of one kind, or all of them.
export const draftsOfType = (drafts, key) => {
  const g = generatorOfType(key);
  return g ? (drafts || []).filter((d) => d.action_type === g) : (drafts || []);
};

// The numbers on the stage strip and the toggle, for one kind: ideas waiting for a pick (passed in, they come from recommendations),
// drafts (waiting for you plus on their way), and what went live.
export function stageCounts(drafts, key, ideasWaiting = 0, now = Date.now()) {
  const list = draftsOfType(drafts, key);
  const r = reviewLists(list, now);
  return { ideas: ideasWaiting, drafted: r.waiting.length + r.onItsWay.length, waiting: r.waiting.length, history: historyByMonth(list, now).total };
}
