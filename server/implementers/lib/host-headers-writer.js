// Writes response headers (security headers today) into whatever the site's HOST reads, so the fix is not tied to
// nginx. Same contract as redirect-writer.js: pure (no network, no DB); the caller supplies the repo file list and a
// read(path) function; a layout this file does not positively recognise is REFUSED with a reason, never guessed at.
//
// Recognised, tried in this order:
//   vercel.json      Vercel            "headers": [{ source, headers: [{ key, value }] }]
//   netlify.toml     Netlify           [[headers]] for = "/*"
//   _headers         Netlify / Cloudflare Pages (only when the file already exists: its place is the publish folder,
//                    which cannot be guessed)
//   .htaccess        Apache            Header always set
//   next.config.*    Next.js           an existing `async headers() { return [ ... ] }` (refused under output: "export")
// nginx is handled by the marker flow in backend.js (the site's mapped nginxConfig), not here.
//
// A header the file already sets is never overridden: only the missing ones are added.

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
// No quotes, backslashes or newlines: values are written inside quoted config strings.
const SAFE_VALUE = /^[^"\\\r\n]+$/;

export const START = '# SEOAI:SECURITY-HEADERS:START';
export const END = '# SEOAI:SECURITY-HEADERS:END';

export function validateHeaders(headers) {
  const list = Array.isArray(headers) ? headers : [];
  if (!list.length) return { ok: false, reason: 'no-headers', error: 'This draft names no headers to add.' };
  for (const h of list) {
    if (!h || !SAFE_NAME.test(h.name || '') || !SAFE_VALUE.test(h.value || '')) {
      return { ok: false, reason: 'unsafe-header', error: `Header "${h?.name}" has characters that are not safe to write into a config file.` };
    }
  }
  return { ok: true, headers: list };
}

const has = (content, name) => new RegExp(`(^|[^A-Za-z-])${name.replace(/-/g, '\\-')}\\s*[:=,"'\\s]`, 'mi').test(content);

// Replace (or append) the marker-delimited block, so re-running is idempotent and a later run can change the set.
function upsertBlock(content, lines) {
  const block = [START, ...lines, END].join('\n');
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (re.test(content)) return content.replace(re, block);
  return `${content}${content === '' || content.endsWith('\n') ? '' : '\n'}\n${block}\n`;
}

const outsideBlock = (content) => content.replace(new RegExp(`${START}[\\s\\S]*?${END}`), '');

function editVercel(content, headers) {
  let json;
  try { json = JSON.parse(content); } catch { return { ok: false, reason: 'unparseable', error: 'vercel.json is not valid JSON, so it was not edited.' }; }
  if (json.headers !== undefined && !Array.isArray(json.headers)) return { ok: false, reason: 'unexpected-shape', error: 'vercel.json "headers" is not an array.' };
  const existing = Array.isArray(json.headers) ? json.headers : [];
  const set = new Set(existing.flatMap((e) => (Array.isArray(e?.headers) ? e.headers : [])).map((h) => String(h?.key || '').toLowerCase()));
  const missing = headers.filter((h) => !set.has(h.name.toLowerCase()));
  if (!missing.length) return { ok: false, reason: 'already-exists', error: 'vercel.json already sets every one of these headers.' };
  const indent = content.match(/^( +|\t)\S/m)?.[1] || '  ';
  const next = { ...json, headers: [...existing, { source: '/(.*)', headers: missing.map((h) => ({ key: h.name, value: h.value })) }] };
  return { ok: true, newContent: `${JSON.stringify(next, null, indent)}${content.endsWith('\n') ? '\n' : ''}`, added: missing.map((h) => h.name) };
}

function editNetlifyToml(content, headers) {
  const missing = headers.filter((h) => !has(outsideBlock(content), h.name));
  if (!missing.length) return { ok: false, reason: 'already-exists', error: 'netlify.toml already sets every one of these headers.' };
  const lines = ['[[headers]]', '  for = "/*"', '  [headers.values]', ...missing.map((h) => `    ${h.name} = "${h.value}"`)];
  return { ok: true, newContent: upsertBlock(content, lines), added: missing.map((h) => h.name) };
}

function editHeadersFile(content, headers) {
  const missing = headers.filter((h) => !has(outsideBlock(content), h.name));
  if (!missing.length) return { ok: false, reason: 'already-exists', error: 'The _headers file already sets every one of these headers.' };
  return { ok: true, newContent: upsertBlock(content, ['/*', ...missing.map((h) => `  ${h.name}: ${h.value}`)]), added: missing.map((h) => h.name) };
}

function editHtaccess(content, headers) {
  const missing = headers.filter((h) => !has(outsideBlock(content), h.name));
  if (!missing.length) return { ok: false, reason: 'already-exists', error: '.htaccess already sets every one of these headers.' };
  const lines = ['<IfModule mod_headers.c>', ...missing.map((h) => `  Header always set ${h.name} "${h.value}"`), '</IfModule>'];
  return { ok: true, newContent: upsertBlock(content, lines), added: missing.map((h) => h.name) };
}

function editNextConfig(content, headers) {
  if (/output\s*:\s*['"`]export['"`]/.test(content)) {
    return { ok: false, reason: 'static-export', error: 'next.config uses `output: "export"`, where Next.js ignores headers(). The headers have to be set in the web server or host config instead.' };
  }
  const m = content.match(/async\s+headers\s*\(\s*\)\s*\{[\s\S]*?return\s*\[/);
  if (!m) return { ok: false, reason: 'no-anchor', error: 'next.config has no `async headers() { return [ ... ] }` array to add to.' };
  const missing = headers.filter((h) => !has(content, h.name));
  if (!missing.length) return { ok: false, reason: 'already-exists', error: 'next.config already sets every one of these headers.' };
  const at = m.index + m[0].length;
  const before = content.slice(0, at);
  const indent = `${(content.slice(before.lastIndexOf('\n') + 1).match(/^\s*/) || [''])[0]}  `;
  const entry = `\n${indent}{ source: "/(.*)", headers: [${missing.map((h) => `{ key: ${JSON.stringify(h.name)}, value: ${JSON.stringify(h.value)} }`).join(', ')}] },`;
  return { ok: true, newContent: `${before}${entry}${content.slice(at)}`, added: missing.map((h) => h.name) };
}

const EDITORS = { vercel: editVercel, 'netlify-toml': editNetlifyToml, 'headers-file': editHeadersFile, htaccess: editHtaccess, 'next-config': editNextConfig };

export function findHeaderCandidates(files) {
  const set = (Array.isArray(files) ? files : []).filter((f) => !/node_modules/.test(f));
  const out = [];
  if (set.includes('vercel.json')) out.push({ format: 'vercel', path: 'vercel.json' });
  if (set.includes('netlify.toml')) out.push({ format: 'netlify-toml', path: 'netlify.toml' });
  const hf = set.find((f) => /(^|\/)_headers$/.test(f));
  if (hf) out.push({ format: 'headers-file', path: hf });
  const ht = set.find((f) => f === '.htaccess' || f === 'public/.htaccess');
  if (ht) out.push({ format: 'htaccess', path: ht });
  const nx = set.find((f) => /^next\.config\.(js|mjs|cjs|ts)$/.test(f));
  if (nx) out.push({ format: 'next-config', path: nx });
  return out;
}

export async function planSecurityHeaders({ files, read, headers }) {
  const v = validateHeaders(headers);
  if (!v.ok) return v;
  const candidates = findHeaderCandidates(files);
  if (!candidates.length) {
    return { ok: false, reason: 'no-headers-mechanism', error: 'No supported headers file (vercel.json, netlify.toml, _headers, .htaccess, next.config headers()) was found in this repo. The headers have to be set in the host or CDN settings by hand.' };
  }
  const refusals = [];
  for (const c of candidates) {
    const content = await read(c.path);
    if (content == null) continue;
    const edit = EDITORS[c.format](content, v.headers);
    if (edit.ok) return { ok: true, format: c.format, filePath: c.path, oldContent: content, newContent: edit.newContent, added: edit.added };
    if (edit.reason === 'already-exists') return { ...edit, filePath: c.path, format: c.format };
    refusals.push(`${c.path}: ${edit.error}`);
  }
  return { ok: false, reason: 'no-editable-headers-file', error: `Found header-capable files but none could be edited safely. ${refusals.join(' | ')}` };
}
