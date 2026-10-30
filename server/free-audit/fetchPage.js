import tls from 'node:tls';
import dns from 'node:dns/promises';
import { assertPublicUrl } from './urlGuard.js';
import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (compatible; SuperRankAuditBot/1.0; +https://superrank.si)';
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 8000;
const SIBLING_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Refuses private/internal targets before any outbound request. Turns the
// guard's errors into AuditErrors so the API reports them cleanly.
async function guardUrl(url) {
  try {
    await assertPublicUrl(url);
  } catch (err) {
    if (err.code === 'blocked_target') throw new AuditError('invalid_url', err.message);
    if (err.code === 'unresolvable') throw new AuditError('fetch_failed', err.message);
    throw err;
  }
}

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') {
    throw new AuditError('invalid_url', 'A URL is required.');
  }
  let candidate = input.trim();
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new AuditError('invalid_url', 'That does not look like a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AuditError('invalid_url', 'Only http and https URLs are supported.');
  }
  return url;
}

async function followRedirects(startUrl) {
  let current = startUrl;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    await guardUrl(current);
    let res;
    try {
      res = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,*/*',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new AuditError('timeout', 'The site took too long to respond.');
      }
      throw new AuditError('fetch_failed', 'Could not reach that site.');
    }

    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), current);
      if (hops === MAX_REDIRECTS) {
        throw new AuditError('fetch_failed', 'Too many redirects.');
      }
      current = next;
      continue;
    }

    return { res, finalUrl: current, redirectCount: hops };
  }
  throw new AuditError('fetch_failed', 'Too many redirects.');
}

async function fetchMainPage(startUrl) {
  const { res, finalUrl, redirectCount } = await followRedirects(startUrl);

  const contentType = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new AuditError('not_html', 'That URL did not return an HTML page.');
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_BODY_BYTES) {
    throw new AuditError('fetch_failed', 'That page is too large to audit.');
  }

  let html;
  try {
    html = await res.text();
  } catch {
    throw new AuditError('fetch_failed', 'Could not read the page content.');
  }
  if (html.length > MAX_BODY_BYTES) {
    html = html.slice(0, MAX_BODY_BYTES);
  }

  return {
    html,
    statusCode: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    finalUrl,
    redirectCount,
  };
}

async function probeHttpToHttpsRedirect(hostname) {
  try {
    await guardUrl(new URL(`http://${hostname}/`));
    const res = await fetch(`http://${hostname}/`, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(SIBLING_TIMEOUT_MS),
    });
    const location = res.headers.get('location');
    return [301, 302, 307, 308].includes(res.status) && !!location && location.startsWith('https://');
  } catch {
    return null;
  }
}

async function probeHttp2(hostname) {
  try {
    await guardUrl(new URL(`https://${hostname}/`));
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, ALPNProtocols: ['h2', 'http/1.1'], timeout: SIBLING_TIMEOUT_MS },
      () => {
        if (settled) return;
        settled = true;
        const proto = socket.alpnProtocol;
        socket.end();
        resolve(proto === 'h2');
      }
    );
    socket.on('error', () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
    socket.on('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(null);
    });
  });
}

async function fetchSiblingFile(origin, path) {
  try {
    let current = new URL(path, origin);
    let res;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      await guardUrl(current);
      res = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: { 'user-agent': USER_AGENT, 'cache-control': 'no-cache', pragma: 'no-cache' },
        signal: AbortSignal.timeout(SIBLING_TIMEOUT_MS),
      });
      const location = res.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) break;
      if (hops === MAX_REDIRECTS) return { present: null, content: null };
      current = new URL(location, current);
    }
    if (!res.ok) {
      return { present: false, content: null };
    }
    const content = await res.text();
    return { present: true, content: content.slice(0, MAX_BODY_BYTES) };
  } catch {
    return { present: null, content: null };
  }
}

function parseRobotsTxt(robotsTxt) {
  if (!robotsTxt.present || !robotsTxt.content) {
    return { present: robotsTxt.present, blocksAll: false, sitemapUrls: [], content: robotsTxt.content };
  }
  const lines = robotsTxt.content.split(/\r?\n/).map((l) => l.trim());
  const sitemapUrls = lines
    .filter((l) => /^sitemap:/i.test(l))
    .map((l) => l.replace(/^sitemap:\s*/i, '').trim());

  let inWildcardGroup = false;
  let blocksAll = false;
  for (const line of lines) {
    if (/^user-agent:/i.test(line)) {
      inWildcardGroup = line.replace(/^user-agent:\s*/i, '').trim() === '*';
      continue;
    }
    if (inWildcardGroup && /^disallow:\s*\/\s*$/i.test(line)) {
      blocksAll = true;
    }
  }
  return { present: true, blocksAll, sitemapUrls, content: robotsTxt.content };
}

async function resolveTxtSafe(hostname) {
  try {
    const records = await dns.resolveTxt(hostname);
    return { present: true, values: records.map((chunks) => chunks.join('')) };
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      return { present: false, values: [] };
    }
    return { present: null, values: [] };
  }
}

async function fetchDnsRecords(hostname) {
  const [spf, dmarc] = await Promise.all([
    resolveTxtSafe(hostname),
    resolveTxtSafe(`_dmarc.${hostname}`),
  ]);
  const spfRecord = spf.values.find((v) => /^v=spf1/i.test(v)) || null;
  const dmarcRecord = dmarc.values.find((v) => /^v=dmarc1/i.test(v)) || null;
  return {
    spf: spf.present === null ? null : !!spfRecord,
    dmarc: dmarc.present === null ? null : !!dmarcRecord,
    spfRecord,
    dmarcRecord,
  };
}

// `siteCache` (optional Map) lets a multi-page scan fetch the per-site files (robots.txt, sitemap, DNS, TLS probes)
// once and reuse them for every page of the same origin, instead of repeating them for each page.
async function fetchPage(inputUrl, { siteCache } = {}) {
  const startUrl = normalizeUrl(inputUrl);
  const startedAt = Date.now();

  const main = await fetchMainPage(startUrl);
  const origin = main.finalUrl.origin;
  const hostname = main.finalUrl.hostname;

  const loadSiteFiles = () => Promise.all([
    fetchSiblingFile(origin, '/robots.txt'),
    fetchSiblingFile(origin, '/sitemap.xml'),
    fetchSiblingFile(origin, '/llms.txt'),
    fetchSiblingFile(origin, '/.well-known/mcp.json'),
    fetchDnsRecords(hostname),
    probeHttpToHttpsRedirect(hostname),
    main.finalUrl.protocol === 'https:' ? probeHttp2(hostname) : Promise.resolve(false),
  ]);
  let siteFiles;
  if (siteCache) {
    if (!siteCache.has(origin)) siteCache.set(origin, loadSiteFiles());
    siteFiles = siteCache.get(origin);
  } else {
    siteFiles = loadSiteFiles();
  }
  const [robotsRaw, sitemapDirect, llmsTxt, mcpManifest, dnsRecords, httpToHttps, http2] = await siteFiles;

  const robotsTxt = parseRobotsTxt(robotsRaw);
  const sitemap = sitemapDirect.present
    ? { present: true, url: new URL('/sitemap.xml', origin).toString() }
    : robotsTxt.sitemapUrls.length > 0
    ? { present: true, url: robotsTxt.sitemapUrls[0] }
    : { present: sitemapDirect.present === null ? null : false, url: null };

  const $ = cheerio.load(main.html);

  return {
    url: startUrl.toString(),
    finalUrl: main.finalUrl.toString(),
    statusCode: main.statusCode,
    redirectCount: main.redirectCount,
    headers: main.headers,
    html: main.html,
    $,
    robotsTxt,
    sitemap,
    llmsTxt,
    mcpManifest,
    dns: dnsRecords,
    tls: {
      https: main.finalUrl.protocol === 'https:',
      httpToHttpsRedirect: httpToHttps,
      http2,
    },
    durationMs: Date.now() - startedAt,
  };
}

export { fetchPage, fetchMainPage, fetchSiblingFile, normalizeUrl, guardUrl, AuditError };
