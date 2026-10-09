// Pure, deterministic generator — no LLM call. The destination was chosen by
// agents/lib/redirect-target.js from the site's own live pages, and the
// implementer (server/implementers/backend.js, via lib/redirect-writer.js)
// writes it into the redirect mechanism the repo already uses. It is NOT in
// risk-tiers.js's safe set: a redirect is always a pull request that a human
// reviews and merges, because a deliberately retired page and an accidentally
// deleted one return the same 404 and only a person knows which this is.

import { validateRedirect } from '../implementers/lib/redirect-writer.js';

export const meta = {
  id: 'redirect-add',
  name: 'Dead URL Redirect Generator',
  description: 'Adds a permanent (301) redirect from a dead indexed URL to the closest live page on the same site.',
  recommendationTags: [],
};

// params: { from: string (absolute URL), to: string (absolute URL, same host) }
export async function generate({ params }) {
  const { from, to } = params || {};
  if (!from || !to) throw Object.assign(new Error('from and to are required'), { status: 400 });
  let fromUrl; let toUrl;
  try { fromUrl = new URL(from); toUrl = new URL(to); } catch {
    throw Object.assign(new Error('from and to must be absolute URLs'), { status: 400 });
  }
  if (fromUrl.hostname.replace(/^www\./, '') !== toUrl.hostname.replace(/^www\./, '')) {
    throw Object.assign(new Error('a redirect must stay on the same host'), { status: 400 });
  }
  const v = validateRedirect(from, to);
  if (!v.ok) throw Object.assign(new Error(v.error), { status: 400 });

  return {
    content: { from, to, fromPath: v.from, toPath: v.to, status: 301 },
    summary: `${v.from} → ${v.to} (301)`,
  };
}
