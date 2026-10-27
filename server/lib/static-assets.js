import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';
import express from 'express';

// The built dashboard, served fast. Without this the browser downloaded the ~780 KB main script
// uncompressed on every visit. Vite names built files by content (web/dist/assets/name-HASH.js), so a
// given URL never changes and can be kept by the browser for a year; the page that points at them
// (index.html) must always be re-checked or a deploy would not show up.
//
// Compression is done once per file and kept in memory (the build is a few MB), so a request costs
// nothing beyond a copy. Brotli is used when the browser accepts it, gzip otherwise.

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};
const YEAR = 60 * 60 * 24 * 365;

export function pickEncoding(acceptEncoding) {
  const a = String(acceptEncoding || '').toLowerCase();
  if (/\bbr\b/.test(a)) return 'br';
  if (/\bgzip\b/.test(a)) return 'gzip';
  return 'identity';
}

export function serveDist(dist) {
  const cache = new Map(); // `${path}:${mtime}` -> { raw, br, gzip, etag, type }

  async function load(file, mtimeMs) {
    const key = `${file}:${mtimeMs}`;
    let hit = cache.get(key);
    if (!hit) {
      const raw = await readFile(file);
      hit = {
        raw, type: TYPES[extname(file)],
        etag: `"${mtimeMs.toString(36)}-${raw.length.toString(36)}"`,
        br: await brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
        gzip: await gz(raw, { level: 9 }),
      };
      cache.set(key, hit);
    }
    return hit;
  }

  const assets = async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const ext = extname(req.path);
    if (!TYPES[ext] || !req.path.startsWith('/assets/')) return next();
    const file = normalize(join(dist, req.path));
    if (!file.startsWith(dist + sep)) return next();
    try {
      const st = await stat(file);
      if (!st.isFile()) return next();
      const body = await load(file, st.mtimeMs);
      const enc = pickEncoding(req.headers['accept-encoding']);
      res.set({
        'Content-Type': body.type,
        'Cache-Control': `public, max-age=${YEAR}, immutable`,
        Vary: 'Accept-Encoding',
        ETag: body.etag,
      });
      if (req.headers['if-none-match'] === body.etag) return res.status(304).end();
      const payload = enc === 'br' ? body.br : enc === 'gzip' ? body.gzip : body.raw;
      if (enc !== 'identity') res.set('Content-Encoding', enc);
      res.set('Content-Length', String(payload.length));
      return res.end(req.method === 'HEAD' ? undefined : payload);
    } catch {
      return next(); // missing file: let the normal static handler answer
    }
  };

  const rest = express.static(dist, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, path) => { if (path.endsWith('.html')) res.set('Cache-Control', 'no-cache'); },
  });

  const page = (req, res) => {
    res.set('Cache-Control', 'no-cache'); // always re-check; it is tiny and names the current script files
    res.sendFile(join(dist, 'index.html'));
  };

  return { assets, rest, page };
}
