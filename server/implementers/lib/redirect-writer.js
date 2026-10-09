// Adds ONE permanent redirect (from-path -> to-path) to whatever redirect
// mechanism a site's repo already uses. Pure: no network, no DB. The caller
// (implementers/backend.js) supplies the repo's file list and a `read(path)`
// function, so every rule below is unit-testable.
//
// Same exact-or-refuse contract as href-rewrite-inject.js: a repo layout this
// file does not positively recognise is REFUSED with a reason, never guessed
// at. A refusal leaves the finding open for a human; a wrong guess ships a
// broken config to production. Merging is always a human on GitHub, so even a
// recognised format is reviewed before it goes live.
//
// Supported, in the order they are tried:
//   _redirects     Netlify / Cloudflare Pages          /from /to 301
//   vercel.json    Vercel                              "redirects": [...]
//   nginx *.conf   self-hosted static / reverse proxy  location = /from { return 301 /to; }
//   .htaccess      Apache                              Redirect 301 /from /to
//   next.config.*  Next.js `async redirects()` — refused under `output: "export"`,
//                  where Next ignores redirects() entirely.
// Anything else (a CMS redirect plugin, a host dashboard, a proxy config that
// lives outside the repo) is not an edit this app can make, and says so.

// Conservative on purpose: these strings are written into config files that
// can take a site down, and they come from Search Console rows. Only plain
// URL path characters are accepted — no spaces, quotes, braces, semicolons,
// regex metacharacters or newlines, so nothing here can break out of the
// directive it is spliced into.
const SAFE_PATH = /^\/[A-Za-z0-9\-._~/%]*$/;

export function toPath(urlOrPath) {
  let path;
  try { path = new URL(urlOrPath).pathname; } catch { path = String(urlOrPath || ''); }
  path = path.split('?')[0].split('#')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function validateRedirect(from, to) {
  const f = toPath(from);
  const t = toPath(to);
  if (!SAFE_PATH.test(f)) return { ok: false, reason: 'unsafe-path', error: `"${from}" contains characters that are not safe to write into a redirect config.` };
  if (!SAFE_PATH.test(t)) return { ok: false, reason: 'unsafe-path', error: `"${to}" contains characters that are not safe to write into a redirect config.` };
  if (f === '/' ) return { ok: false, reason: 'refuse-root', error: 'Redirecting the site root is never automatic.' };
  if (f === t) return { ok: false, reason: 'self-redirect', error: `"${f}" would redirect to itself.` };
  return { ok: true, from: f, to: t };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lineIndent(line) {
  return (line.match(/^\s*/) || [''])[0];
}

// ── per-format editors: (content, from, to) -> {ok, newContent} | refusal ──

function editNetlify(content, from, to) {
  if (new RegExp(`^\\s*${escapeRe(from)}\\s+`, 'm').test(content)) {
    return { ok: false, reason: 'already-exists', error: `A rule for ${from} already exists in the redirects file.` };
  }
  // Netlify uses the first matching rule, so a specific rule must sit above
  // any catch-all. Putting it at the very top is always correct.
  return { ok: true, newContent: `${from} ${to} 301\n${content}` };
}

function editVercel(content, from, to) {
  let json;
  try { json = JSON.parse(content); } catch {
    return { ok: false, reason: 'unparseable', error: 'vercel.json is not valid JSON, so it was not edited.' };
  }
  const redirects = Array.isArray(json.redirects) ? json.redirects : [];
  if (json.redirects !== undefined && !Array.isArray(json.redirects)) {
    return { ok: false, reason: 'unexpected-shape', error: 'vercel.json "redirects" is not an array.' };
  }
  if (redirects.some((r) => toPath(r?.source) === from)) {
    return { ok: false, reason: 'already-exists', error: `vercel.json already redirects ${from}.` };
  }
  const indentMatch = content.match(/^( +|\t)\S/m);
  const indent = indentMatch ? indentMatch[1] : '  ';
  const next = { ...json, redirects: [{ source: from, destination: to, permanent: true }, ...redirects] };
  return { ok: true, newContent: `${JSON.stringify(next, null, indent)}${content.endsWith('\n') ? '\n' : ''}` };
}

function editNginx(content, from, to) {
  if (new RegExp(`location\\s+(=\\s+)?${escapeRe(from)}\\s*\\{`).test(content)) {
    return { ok: false, reason: 'already-exists', error: `An nginx location for ${from} already exists.` };
  }
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => /^\s*location\b/.test(l));
  if (idx === -1) {
    return { ok: false, reason: 'no-anchor', error: 'No existing nginx `location` block to anchor the new redirect beside.' };
  }
  const indent = lineIndent(lines[idx]);
  const block = [
    `${indent}# Redirect added by Zunkiree Analytics (Search Console: dead indexed URL)`,
    `${indent}location = ${from} {`,
    `${indent}    return 301 ${to};`,
    `${indent}}`,
    '',
  ];
  lines.splice(idx, 0, ...block);
  return { ok: true, newContent: lines.join('\n') };
}

function editHtaccess(content, from, to) {
  if (new RegExp(`^\\s*Redirect(Match)?\\s+(301\\s+)?${escapeRe(from)}\\s`, 'mi').test(content)) {
    return { ok: false, reason: 'already-exists', error: `.htaccess already redirects ${from}.` };
  }
  return { ok: true, newContent: `Redirect 301 ${from} ${to}\n${content}` };
}

function editNextConfig(content, from, to) {
  if (/output\s*:\s*['"`]export['"`]/.test(content)) {
    return { ok: false, reason: 'static-export', error: 'next.config uses `output: "export"`, where Next.js ignores redirects(). The redirect has to live in the web server config instead.' };
  }
  if (new RegExp(`source\\s*:\\s*['"\`]${escapeRe(from)}['"\`]`).test(content)) {
    return { ok: false, reason: 'already-exists', error: `next.config already has a redirect for ${from}.` };
  }
  // Only the plain shape `async redirects() { return [ ... ]; }` is edited.
  const m = content.match(/async\s+redirects\s*\(\s*\)\s*\{[\s\S]*?return\s*\[/);
  if (!m) {
    return { ok: false, reason: 'no-anchor', error: 'next.config has no `async redirects() { return [ ... ] }` array to add to.' };
  }
  const at = m.index + m[0].length;
  const before = content.slice(0, at);
  const lineStart = before.lastIndexOf('\n') + 1;
  const indent = `${lineIndent(content.slice(lineStart))}  `;
  const entry = `\n${indent}{ source: ${JSON.stringify(from)}, destination: ${JSON.stringify(to)}, permanent: true },`;
  return { ok: true, newContent: `${before}${entry}${content.slice(at)}` };
}

const EDITORS = {
  netlify: editNetlify,
  vercel: editVercel,
  nginx: editNginx,
  htaccess: editHtaccess,
  'next-config': editNextConfig,
};

// Picks the first supported file that actually exists. Order matters: a repo
// with vercel.json AND a next.config is a Vercel site, and a repo with an
// nginx conf next to a static-export next.config is served by nginx.
export function findRedirectCandidates(files) {
  const set = Array.isArray(files) ? files : [];
  const out = [];
  const netlify = set.find((f) => /(^|\/)_redirects$/.test(f) && !/node_modules/.test(f));
  if (netlify) out.push({ format: 'netlify', path: netlify });
  const vercel = set.find((f) => f === 'vercel.json');
  if (vercel) out.push({ format: 'vercel', path: vercel });
  for (const f of set.filter((p) => /\.conf$/.test(p) && /nginx/i.test(p) && !/node_modules/.test(p))) {
    out.push({ format: 'nginx', path: f });
  }
  const ht = set.find((f) => f === '.htaccess' || f === 'public/.htaccess');
  if (ht) out.push({ format: 'htaccess', path: ht });
  const next = set.find((f) => /^next\.config\.(js|mjs|cjs|ts)$/.test(f));
  if (next) out.push({ format: 'next-config', path: next });
  return out;
}

// files: string[] of repo paths. read: async (path) => string | null.
export async function planRedirect({ files, read, from, to }) {
  const v = validateRedirect(from, to);
  if (!v.ok) return v;

  const candidates = findRedirectCandidates(files);
  if (!candidates.length) {
    return {
      ok: false, reason: 'no-redirect-mechanism',
      error: 'No supported redirect file (_redirects, vercel.json, nginx conf, .htaccess, next.config redirects()) was found in this repo. The redirect has to be added in the host or CMS by hand.',
    };
  }

  const refusals = [];
  for (const c of candidates) {
    const content = await read(c.path);
    if (content == null) continue;
    const edit = EDITORS[c.format](content, v.from, v.to);
    if (edit.ok) {
      return { ok: true, format: c.format, filePath: c.path, oldContent: content, newContent: edit.newContent, from: v.from, to: v.to };
    }
    // An existing rule is final, not something another file should paper over.
    if (edit.reason === 'already-exists') return { ...edit, filePath: c.path, format: c.format };
    refusals.push(`${c.path}: ${edit.error}`);
  }
  return {
    ok: false, reason: 'no-editable-redirect-file',
    error: `Found redirect-capable files but none could be edited safely. ${refusals.join(' | ')}`,
  };
}
