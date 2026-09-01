// Downloads a blog post's chosen featured image so it can be committed into
// the client's own repo (see frontend.js's apply() / blog-image-inject.js's
// pushBlogImageBranch) instead of the post's live page hotlinking Pexels'
// CDN forever — the failure mode this exists to close is Pexels
// deleting/moving/blocking a photo years after the post shipped, with no
// local copy to fall back to and nothing in this app that would notice.
//
// Same discipline as pexels-client.js's own searchImage: best-effort, never
// throws. A failed/invalid download must not block or corrupt an otherwise
// complete blog post — the caller falls back to shipping the post with no
// image at all, which is a worse-looking post but a working one, rather
// than a post whose frontmatter points at a file that was never committed.

const FETCH_TIMEOUT_MS = 8000; // matches pexels-client.js's own search timeout
const MAX_BYTES = 10 * 1024 * 1024; // a stock photo is a few hundred KB; 10MB is already generous
const MIN_BYTES = 100; // rules out an empty body or a tiny error-page response that still returned 200

// Real image file signatures, sniffed from the bytes themselves rather than
// trusted from the Content-Type header — a misconfigured CDN or an error
// page served with an image content-type is exactly the case a magic-byte
// check catches and a header check doesn't.
const SIGNATURES = [
  { ext: '.jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: '.png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: '.gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

function matchesSignature(buffer, sig) {
  if (buffer.length < sig.bytes.length) return false;
  return sig.bytes.every((byte, i) => buffer[i] === byte);
}

// WEBP is RIFF????WEBP — the 4 bytes at offset 8 identify it, unlike the
// other formats above which are a fixed leading byte sequence.
function isWebp(buffer) {
  return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

// Real detected format from the bytes, or null if this isn't a recognized
// image at all — the actual validation gate. The URL's own extension
// (pexels-client.js's imageExtensionFromUrl) decides the file's NAME ahead
// of the download; this decides whether what came back is safe to commit.
function sniffImage(buffer) {
  if (isWebp(buffer)) return '.webp';
  const hit = SIGNATURES.find((sig) => matchesSignature(buffer, sig));
  return hit ? hit.ext : null;
}

// The one place frontend.js's apply() (blog-outline drafts) and
// blog-image-inject.js's pushBlogImageBranch (blog-image repair drafts)
// both decide what, if anything, to commit as this post's image file —
// shared so the two can't diverge on the retry/dedup or failure behavior.
//
// `repoImagePath` (url-file-map.js's resolveBlogImagePath) is already fixed
// — deterministic, same slug every retry uses — so this never needs to
// invent a new filename to avoid colliding with a previous attempt.
// Retry/rerun de-duplication IS that determinism: if a prior run already
// committed a real file at this exact path (checked against whatever branch
// this draft is about to be pushed onto), there is nothing to download —
// re-fetching Pexels again would just recreate a byte-for-byte identical
// blob for no reason. Only a path that's genuinely empty triggers a real
// download.
//
// Returns `{ file, imageFailed }`:
//   - already present, or nothing to place at all -> `{ file: null, imageFailed: false }`
//   - freshly downloaded and validated -> `{ file: {path, contentBuffer}, imageFailed: false }`
//   - download/validation failed -> `{ file: null, imageFailed: true }` — the
//     caller strips the image front-matter fields it already rendered rather
//     than ship a post pointing at a file that was never committed (same
//     "wrong/missing image must never block the post" rule as
//     pexels-client.js's searchImage).
export async function resolveBlogImageCommit(site, branch, repoImagePath, sourceUrl, readFile) {
  if (!repoImagePath || !sourceUrl) return { file: null, imageFailed: false };

  const existing = await readFile(site, repoImagePath, branch);
  if (existing) return { file: null, imageFailed: false };

  const asset = await fetchImageAsset(sourceUrl);
  if (!asset) return { file: null, imageFailed: true };
  return { file: { path: repoImagePath, contentBuffer: asset.buffer }, imageFailed: false };
}

// Downloads `url` and returns `{ buffer, ext }` (ext is the format actually
// sniffed from the bytes, not necessarily the URL's own extension) or `null`
// if the fetch failed, timed out, exceeded the size cap, or the bytes don't
// look like a real image.
export async function fetchImageAsset(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < MIN_BYTES || buffer.length > MAX_BYTES) return null;

    const ext = sniffImage(buffer);
    if (!ext) return null;

    return { buffer, ext };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
