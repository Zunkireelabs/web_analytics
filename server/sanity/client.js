// Minimal Sanity HTTP client — query + mutate, nothing else.
//
// Deliberately not the @sanity/client package. This app needs exactly two
// calls, both plain HTTPS with a bearer token, and adding a dependency whose
// job is to wrap them would buy nothing while pulling a transitive tree into
// a server that writes to other people's content. The client repo
// (admizz-web-dev) uses @sanity/client for its own reads; that's its choice
// and unrelated to this.
//
// Everything here takes an explicit {projectId, dataset, apiVersion, token}
// resolved per site by the caller. There is no module-level client and no
// cached credential — a shared instance is how one tenant's token ends up
// writing to another tenant's dataset.

const SANITY_API_HOST = 'api.sanity.io';
const DEFAULT_API_VERSION = '2026-02-10'; // matches the client repo's own default
const REQUEST_TIMEOUT_MS = 20_000;

class SanityError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'SanityError';
    this.status = status;
    this.body = body;
  }
}

function baseUrl({ projectId, apiVersion }) {
  if (!projectId) throw new SanityError('Sanity projectId is required');
  return `https://${projectId}.${SANITY_API_HOST}/v${apiVersion || DEFAULT_API_VERSION}`;
}

async function request(url, { method = 'GET', token, body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      // Sanity puts a useful message in .error.description; fall back to the
      // raw text, truncated — this string can reach a draft's apply_error and
      // from there a UI, so it must not become a wall of HTML.
      const detail = parsed?.error?.description || parsed?.message || text.slice(0, 300);
      throw new SanityError(`Sanity API ${res.status}: ${detail}`, { status: res.status, body: parsed });
    }
    return parsed;
  } catch (err) {
    if (err.name === 'AbortError') throw new SanityError(`Sanity API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// GROQ query. Params are passed as $-prefixed query-string entries, which is
// how the HTTP API takes them — never string-interpolated into the query,
// so a slug containing GROQ syntax can't alter the query's meaning.
export async function sanityQuery(config, groq, params = {}) {
  const url = new URL(`${baseUrl(config)}/data/query/${config.dataset}`);
  url.searchParams.set('query', groq);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`$${key}`, JSON.stringify(value));
  }
  const json = await request(url.toString(), { token: config.token });
  return json?.result ?? null;
}

// Applies mutations. `returnDocuments` asks Sanity to echo the resulting
// documents, but the adapter does NOT treat that echo as proof — it re-reads
// with sanityQuery afterwards, because the value that matters is what a
// subsequent reader sees, not what the writer was told.
export async function sanityMutate(config, mutations, { returnDocuments = false } = {}) {
  const url = new URL(`${baseUrl(config)}/data/mutate/${config.dataset}`);
  url.searchParams.set('returnIds', 'true');
  if (returnDocuments) url.searchParams.set('returnDocuments', 'true');
  return request(url.toString(), { method: 'POST', token: config.token, body: { mutations } });
}

// Sanity's draft convention: a draft of document `abc` is `drafts.abc`.
// Publishing is moving the draft's content onto the published id and deleting
// the draft — there is no separate "publish" endpoint.
export const DRAFT_PREFIX = 'drafts.';
export const draftId = (publishedId) => (publishedId.startsWith(DRAFT_PREFIX) ? publishedId : `${DRAFT_PREFIX}${publishedId}`);
export const publishedId = (anyId) => (anyId.startsWith(DRAFT_PREFIX) ? anyId.slice(DRAFT_PREFIX.length) : anyId);

export { SanityError, DEFAULT_API_VERSION };
