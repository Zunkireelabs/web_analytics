// How many blogs one project may ship in one blog-day cycle. FIVE IS A CEILING, NEVER A QUOTA: the evidence gate decides how many topics are fit
// to ship, this only caps it. BLOG_CYCLE_MAX (default 5, at most 12); BLOG_DAY_MAX_BLOGS, when set lower, still wins.
import { blogDayMax } from '../blog-day.js';

export function blogCycleCeiling(env = process.env) {
  const own = Number(env.BLOG_CYCLE_MAX ?? 5);
  const cap = Number.isInteger(own) && own >= 1 ? Math.min(own, 12) : 5;
  return Math.min(cap, blogDayMax(env));
}

/** off | log | enforce. 'log' (the default) decides and records everything but never filters, so deploying changes nothing by itself. */
export const blogGateMode = (env = process.env) => {
  const v = String(env.BLOG_EVIDENCE_GATE || 'log').toLowerCase();
  return ['off', 'log', 'enforce'].includes(v) ? v : 'log';
};
export const blogArticleGateMode = (env = process.env) => {
  const v = String(env.BLOG_ARTICLE_GATE || 'log').toLowerCase();
  return ['off', 'log', 'enforce'].includes(v) ? v : 'log';
};
