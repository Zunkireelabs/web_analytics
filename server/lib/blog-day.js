// Blog days. Every Nth day is a shared blog day for all projects: that day's queue holds the blog drafts plus any high-priority fixes, nothing else,
// so the day's AI writing is the blogs. The other days hold no blog and run the normal fixes. That keeps blog writing (the heaviest requests) to one day in three and
// the other days lighter. Off unless BLOG_DAY_EVERY_N_DAYS is set to 2 or more (the plan is 3): with it unset, 0 or 1 a blog is queued daily exactly as before, so
// deploying this code changes nothing by itself.
const DAY_MS = 86_400_000;
const BLOG = 'blog-outline';

export function blogDayEvery(env = process.env) {
  const n = Number(env.BLOG_DAY_EVERY_N_DAYS ?? 0);
  return Number.isInteger(n) && n > 1 ? n : 0;
}

// BLOG_DAY_START (YYYY-MM-DD, UTC) makes that date the first blog day, then every Nth day after it. Unset: the days are counted from 1970-01-01, which is arbitrary
// but the same for every project. The owner starts the rule on a chosen day (2026-11-25), so it is set in the deploy.
const startDay = (env) => {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(env.BLOG_DAY_START || '')) ? Date.parse(`${env.BLOG_DAY_START}T00:00:00Z`) : NaN;
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) : 0;
};

/** @returns {'off'|'blog'|'normal'} deterministic for a given calendar day (UTC), the same for every project. */
export function blogDayMode({ now = Date.now(), env = process.env } = {}) {
  const n = blogDayEvery(env);
  if (!n) return 'off';
  const since = Math.floor(now / DAY_MS) - startDay(env);
  return ((since % n) + n) % n === 0 ? 'blog' : 'normal';
}

// How many blogs one project ships on a blog day (owner's rule, 2026-11-24: 5 to 6). BLOG_DAY_MAX_BLOGS, default 6, at most 12.
export function blogDayMax(env = process.env) {
  const n = Number(env.BLOG_DAY_MAX_BLOGS ?? 6);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 12) : 6;
}

export function applyBlogDay(candidates, mode) {
  if (!Array.isArray(candidates) || mode === 'off' || !mode) return candidates;
  if (mode === 'blog') return candidates.filter((r) => r?.recommendation_type === BLOG || r?.priority === 'high');
  return candidates.filter((r) => r?.recommendation_type !== BLOG);
}
