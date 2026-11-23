import { randomBytes } from 'node:crypto';

// IndexNow (https://www.indexnow.org/documentation): tells Bing, Yandex, Naver and Seznam (and the AI search that reads Bing) that URLs
// changed, the moment they change, instead of waiting for a crawl. Google does not take part.
//
// Two halves. The site must serve a key file at its root, https://<host>/<key>.txt containing the key, to prove the sender controls the
// host (generators/indexnow.js writes that file into the site's repo). Then, after a change goes live, the changed URLs are POSTed here.
// This module is the second half and the shared rules: key format, payload checks, the submit call, and what each response code means.
// Never throws: a failed ping is a result, not an exception (a ping must never break a deploy step).

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/IndexNow';
export const MAX_URLS_PER_REQUEST = 10000;

// The protocol allows 8-128 characters from a-z A-Z 0-9 and "-". 32 hex characters is the usual choice.
export const generateIndexNowKey = () => randomBytes(16).toString('hex');
export const isValidIndexNowKey = (key) => typeof key === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(key);
export const keyFileName = (key) => `${key}.txt`;
export const keyFileContent = (key) => key; // the file holds the key and nothing else

const REASONS = {
  200: 'Accepted.',
  202: 'Accepted. The key is still being validated; the file at the key location must be reachable.',
  400: 'Rejected: the request was malformed.',
  403: 'Rejected: the key is not valid, or the key file could not be found on the site.',
  422: 'Rejected: a URL does not belong to the host, or the key does not match the key file.',
  429: 'Rejected: too many requests. Try again later.',
};

/**
 * Only URLs on the site's own host are allowed in (the protocol rejects the whole request otherwise); duplicates, fragments and
 * unparseable values are dropped; the list is capped at the protocol limit.
 * @returns { urls, dropped } where dropped is how many were removed and why
 */
export function cleanUrlList(host, urls) {
  const want = String(host || '').toLowerCase().replace(/^www\./, '');
  const seen = new Set(); const out = []; const dropped = { otherHost: 0, invalid: 0, duplicate: 0, overLimit: 0 };
  for (const raw of urls || []) {
    let u; try { u = new URL(String(raw).trim()); } catch { dropped.invalid += 1; continue; }
    if (!/^https?:$/.test(u.protocol)) { dropped.invalid += 1; continue; }
    if (u.hostname.toLowerCase().replace(/^www\./, '') !== want) { dropped.otherHost += 1; continue; }
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) { dropped.duplicate += 1; continue; }
    if (out.length >= MAX_URLS_PER_REQUEST) { dropped.overLimit += 1; continue; }
    seen.add(key); out.push(key);
  }
  return { urls: out, dropped };
}

/**
 * @param host        the site's host, e.g. "example.com"
 * @param key         the IndexNow key (its file is served at https://<host>/<key>.txt unless keyLocation says otherwise)
 * @param urls        changed URLs
 * @param keyLocation optional full URL of the key file
 * @returns { ok, status, submitted, reason, dropped }
 */
export async function submitIndexNow({ host, key, urls, keyLocation, fetchImpl = globalThis.fetch, endpoint = INDEXNOW_ENDPOINT, timeoutMs = 10000 } = {}) {
  if (!host) return { ok: false, status: null, submitted: 0, reason: 'No host.' };
  if (!isValidIndexNowKey(key)) return { ok: false, status: null, submitted: 0, reason: 'The IndexNow key is missing or not valid (8-128 letters, digits or dashes).' };
  const { urls: list, dropped } = cleanUrlList(host, urls);
  if (!list.length) return { ok: false, status: null, submitted: 0, reason: 'No URLs on this host to submit.', dropped };
  const body = { host, key, urlList: list, ...(keyLocation ? { keyLocation } : {}) };
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const ok = res.status === 200 || res.status === 202;
    return { ok, status: res.status, submitted: ok ? list.length : 0, reason: REASONS[res.status] || `Unexpected response (${res.status}).`, dropped };
  } catch (err) {
    return { ok: false, status: null, submitted: 0, reason: err?.name === 'TimeoutError' ? 'IndexNow did not answer in time.' : 'Could not reach IndexNow.', dropped };
  }
}
