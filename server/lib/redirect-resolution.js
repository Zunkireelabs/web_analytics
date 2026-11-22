// Has this page MOVED? A recommendation names a URL; if that URL now permanently redirects to a different page, every check run against
// it is a check of the wrong thing (found on Zennly: six blog URLs 308 to /businesses/blog/..., and six "no internal links" recommendations
// went on describing pages that no longer exist at those addresses).
//
// Read-only: plain GETs (redirect:'manual'), same-site hops only, at most MAX_HOPS, never to a private address. A hop to another site is
// reported as `leftSite` and is never followed.
import { isPrivateOrLocalHost } from '../agents/lib/page-content.js';

const MAX_HOPS = 5;
const TIMEOUT_MS = 10000;
const PERMANENT = new Set([301, 308]);

const stripWww = (h) => String(h || '').replace(/^www\./i, '').toLowerCase();

// Same page in every way that does not matter: scheme, www, a trailing slash, letter case of the path.
export function samePage(a, b) {
  try {
    const x = new URL(a); const y = new URL(b);
    const path = (u) => (u.pathname.replace(/\/+$/, '') || '/').toLowerCase();
    return stripWww(x.hostname) === stripWww(y.hostname) && path(x) === path(y) && x.search === y.search;
  } catch { return false; }
}

/**
 * @returns {Promise<{ ok: boolean, moved: boolean, finalUrl: string, status: number|null, permanent: boolean, hops: {from:string,to:string,status:number}[], leftSite?: boolean, error?: string }>}
 *   moved is true only when the final page is genuinely a different page (see samePage). ok:false means the chain could not be read, which is
 *   never evidence that the page moved.
 */
export async function resolvePageMove(url, { fetchImpl = fetch } = {}) {
  const hops = [];
  let current = url;
  let status = null;
  for (let i = 0; i <= MAX_HOPS; i++) {
    let host;
    try { host = new URL(current).hostname; } catch { return { ok: false, moved: false, finalUrl: url, status, permanent: false, hops, error: 'invalid-url' }; }
    if (isPrivateOrLocalHost(host)) return { ok: false, moved: false, finalUrl: url, status, permanent: false, hops, error: 'private-address' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(current, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +opportunity-agent)' } });
    } catch { return { ok: false, moved: false, finalUrl: url, status, permanent: false, hops, error: 'unreachable' }; } finally { clearTimeout(timer); }
    status = res.status;
    if (status >= 300 && status < 400) {
      const loc = res.headers?.get?.('location');
      if (!loc) return { ok: false, moved: false, finalUrl: url, status, permanent: false, hops, error: 'redirect-without-location' };
      let next;
      try { next = new URL(loc, current).href; } catch { return { ok: false, moved: false, finalUrl: url, status, permanent: false, hops, error: 'bad-location' }; }
      hops.push({ from: current, to: next, status });
      if (stripWww(new URL(next).hostname) !== stripWww(new URL(url).hostname)) {
        return { ok: true, moved: false, leftSite: true, finalUrl: next, status, permanent: PERMANENT.has(status), hops };
      }
      current = next;
      continue;
    }
    const permanent = hops.length > 0 && hops.every((h) => PERMANENT.has(h.status));
    return { ok: true, moved: !samePage(url, current), finalUrl: current, status, permanent, hops };
  }
  return { ok: false, moved: false, finalUrl: url, status, permanent: false, hops, error: 'too-many-redirects' };
}
