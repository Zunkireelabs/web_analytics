// Does the client's REPOSITORY already install Google Analytics / Google Tag Manager?
//
// WHY THE LIVE PAGE IS NOT ENOUGH. The tracker check reads static HTML. Two real projects showed what that misses (2026-11-22):
//   - SuperRank loads GA4 (G-7V8PXXZF3G) from src/scripts/cookie-consent.js, bundled by Astro, and only after the visitor accepts
//     cookies. Its HTML carries no gtag at all, so every static check said "GA4 missing", and installing a direct tag would have
//     double-counted visits AND bypassed the visitor's consent choice.
//   - Zennly's repo already has G-6LYQRZY03B in its only layout; the page that "lacked" it (the homepage) is served by a different app.
// So before a tracking install is drafted, the repo itself is read at the branch the change would be made against.
//
// One request per ref: the repository tarball (getRepoTarball), scanned in memory. Read-only. Nothing is written anywhere.
import { gunzipSync } from 'node:zlib';
import { getRepoTarball } from '../github/client.js';

const TEXT_EXT = /\.(astro|njk|liquid|html?|hbs|handlebars|ejs|pug|php|jsx?|tsx?|mjs|cjs|vue|svelte|md|mdx|json|ya?ml|toml|env\.example|txt)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|_site|\.next|\.astro|coverage|vendor)\//;
const MAX_FILE_BYTES = 1024 * 1024;

const GA4_ID_RE = /\bG-[A-Z0-9]{6,12}\b/g;
const GTM_ID_RE = /\bGTM-[A-Z0-9]{4,10}\b/g;
const GTAG_RE = /googletagmanager\.com\/gtag\/js|gtag\(\s*['"]config['"]/;

// Minimal ustar reader: yields { path, content } for regular files. Handles the GNU long-name ('L') and pax ('x') records GitHub
// tarballs use for long paths. Never throws on an odd entry: it skips it.
export function* readTar(buf) {
  let off = 0; let longName = null;
  const str = (a, b) => buf.toString('utf8', a, b).replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(off + 345, off + 500);
    let name = str(off, off + 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') { const m = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8')); if (m) longName = m[1]; continue; }
    if (type === 'g') continue;
    const path = (longName || name).replace(/^[^/]+\//, ''); // GitHub prefixes every entry with "<owner>-<repo>-<sha>/"
    longName = null;
    if (type === '0' || type === '\0') yield { path, data };
  }
}

/** Pure: scan a tarball's bytes (gzipped). */
export function scanTarballForTracking(gz) {
  const hits = [];
  for (const { path, data } of readTar(gunzipSync(gz))) {
    if (!TEXT_EXT.test(path) || SKIP_DIR.test(`${path}`) || data.length > MAX_FILE_BYTES) continue;
    if (/\.test\.|\.spec\.|__tests__\//.test(path)) continue; // a test fixture is not an installation
    const text = data.toString('utf8');
    const ga4 = [...new Set(text.match(GA4_ID_RE) || [])];
    const gtm = [...new Set(text.match(GTM_ID_RE) || [])];
    const gtag = GTAG_RE.test(text);
    if (gtag || gtm.length || (ga4.length && /gtag|dataLayer|analytics|GA_ID|measurement/i.test(text))) hits.push({ path, ga4, gtm, gtag });
  }
  return hits;
}

/**
 * @returns {{ ok: true, refs: object[] } | { ok: false, error: string }}
 *   refs: [{ ref, hits: [{ path, ga4: string[], gtm: string[], gtag: boolean }] }]
 */
export async function scanRepoForTracking(site, refs, { fetchTarball = getRepoTarball } = {}) {
  const out = [];
  for (const ref of [...new Set(refs.filter(Boolean))]) {
    let gz;
    try { gz = await fetchTarball(site, ref); } catch { return { ok: false, error: `the repository could not be read at ${ref}` }; }
    try { out.push({ ref, hits: scanTarballForTracking(gz) }); } catch { return { ok: false, error: `the repository archive for ${ref} could not be read` }; }
  }
  return { ok: true, refs: out };
}
