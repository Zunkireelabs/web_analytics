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

/** @returns {'off'|'blog'|'normal'} deterministic for a given calendar day (UTC), the same for every project. */
export function blogDayMode({ now = Date.now(), env = process.env } = {}) {
  const n = blogDayEvery(env);
  if (!n) return 'off';
  return Math.floor(now / DAY_MS) % n === 0 ? 'blog' : 'normal';
}

export function applyBlogDay(candidates, mode) {
  if (!Array.isArray(candidates) || mode === 'off' || !mode) return candidates;
  if (mode === 'blog') return candidates.filter((r) => r?.recommendation_type === BLOG || r?.priority === 'high');
  return candidates.filter((r) => r?.recommendation_type !== BLOG);
}
