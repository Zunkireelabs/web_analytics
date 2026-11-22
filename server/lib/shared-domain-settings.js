// Settings for two SuperRank sites that share one domain (and possibly one repo): which URL paths each owns, which repo files each may
// write, which links to the other section are allowed, and whether the agent opens the markers-only setup PR. Pure of any database or
// network: the staff route validates with this and the UI shows what it reads.
//
//   scope_include_paths / scope_exclude_paths   site columns (migration 261)
//   url_file_map.writeScope   { allow, deny }   repo path prefixes (implementers/lib/write-scope-gate.js)
//   url_file_map.crossSiteLinks   [{ url }]     the only links to the other section the agent may add
//   url_file_map.markerSetup   { enabled }      opt in to the markers-only PR after the baseline

import { normalizePrefix, scopeOf } from '../agents/lib/site-scope.js';

const MAX_PATHS = 20;
const MAX_REPO_PATHS = 50;
const MAX_LINKS = 20;

export function readSharedDomain(site) {
  const { include, exclude } = scopeOf(site);
  const map = site?.url_file_map || {};
  const ws = map.writeScope || {};
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    scopeIncludePaths: include,
    scopeExcludePaths: exclude,
    writeAllow: arr(ws.allow),
    writeDeny: arr(ws.deny),
    crossSiteLinks: (Array.isArray(map.crossSiteLinks) ? map.crossSiteLinks : []).map((e) => (typeof e === 'string' ? e : e?.url)).filter(Boolean),
    markerSetupEnabled: map.markerSetup?.enabled === true,
  };
}

// URL paths: '/business', 'business/', ' /Business ' -> '/business' style. Anything with a space, a query, '..' or a host is refused.
function cleanUrlPaths(value, label, errors) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { errors.push(`${label} must be a list.`); return undefined; }
  if (value.length > MAX_PATHS) errors.push(`${label} can hold at most ${MAX_PATHS} paths.`);
  const out = [];
  for (const raw of value) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    if (/\s|[?#]|\.\.|:\/\//.test(text)) { errors.push(`${label}: "${text}" is not a path like /business.`); continue; }
    const p = normalizePrefix(text);
    if (!p) { errors.push(`${label}: "${text}" is the whole site; leave the list empty to mean that.`); continue; }
    out.push(p);
  }
  return [...new Set(out)];
}

// Repo paths: 'src/business/', './src/layout.njk' -> 'src/business', 'src/layout.njk'. No '..', no absolute paths, no wildcards.
function cleanRepoPaths(value, label, errors) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { errors.push(`${label} must be a list.`); return undefined; }
  if (value.length > MAX_REPO_PATHS) errors.push(`${label} can hold at most ${MAX_REPO_PATHS} paths.`);
  const out = [];
  for (const raw of value) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const p = text.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (!p || /\.\.|\s|[*?\\]/.test(p) || /^[a-z]+:/i.test(p)) { errors.push(`${label}: "${text}" is not a repository path like src/business.`); continue; }
    out.push(p);
  }
  return [...new Set(out)];
}

// Cross-site links must be on the site's own domain: the point of the list is "the other section of OUR domain".
function cleanLinks(value, site, errors) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { errors.push('Links to the other section must be a list.'); return undefined; }
  if (value.length > MAX_LINKS) errors.push(`At most ${MAX_LINKS} links to the other section.`);
  const host = String(site?.website_domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
  const out = [];
  for (const raw of value) {
    const text = String(typeof raw === 'string' ? raw : raw?.url ?? '').trim();
    if (!text) continue;
    let u;
    try { u = new URL(text); } catch { errors.push(`"${text}" is not a full link like https://${host || 'example.com'}/business.`); continue; }
    if (!/^https?:$/.test(u.protocol)) { errors.push(`"${text}" must start with http:// or https://.`); continue; }
    if (host && u.hostname.replace(/^www\./, '').toLowerCase() !== host) { errors.push(`"${text}" is not on ${host}. Only links to your own domain are allowed here.`); continue; }
    out.push(u.href);
  }
  return [...new Set(out)];
}

// body: { scopeIncludePaths?, scopeExcludePaths?, writeAllow?, writeDeny?, crossSiteLinks?, markerSetupEnabled? }. Only keys present
// are changed. Returns { ok:true, changes } or { ok:false, errors:[...] }.
export function validateSharedDomain(body, site) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  const changes = {
    scopeIncludePaths: cleanUrlPaths(b.scopeIncludePaths, 'Paths this site owns', errors),
    scopeExcludePaths: cleanUrlPaths(b.scopeExcludePaths, 'Paths this site leaves out', errors),
    writeAllow: cleanRepoPaths(b.writeAllow, 'Files it may write', errors),
    writeDeny: cleanRepoPaths(b.writeDeny, 'Files it may never write', errors),
    crossSiteLinks: cleanLinks(b.crossSiteLinks, site, errors),
    markerSetupEnabled: undefined,
  };
  if (b.markerSetupEnabled !== undefined) {
    if (typeof b.markerSetupEnabled === 'boolean') changes.markerSetupEnabled = b.markerSetupEnabled;
    else errors.push('The marker setup switch must be on or off.');
  }
  const cur = readSharedDomain(site);
  const inc = changes.scopeIncludePaths ?? cur.scopeIncludePaths;
  const exc = changes.scopeExcludePaths ?? cur.scopeExcludePaths;
  const both = inc.filter((p) => exc.includes(p));
  if (both.length) errors.push(`${both.join(', ')} is both owned and left out; pick one.`);
  const allow = changes.writeAllow ?? cur.writeAllow;
  const deny = changes.writeDeny ?? cur.writeDeny;
  const clash = allow.filter((p) => deny.includes(p));
  if (clash.length) errors.push(`${clash.join(', ')} is both allowed and denied; denied always wins, so remove it from one list.`);
  if (changes.markerSetupEnabled === true && !(site?.repo_owner && site?.repo_name)) {
    errors.push('Connect a GitHub repository first; the markers pull request has nowhere to open.');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, changes: Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
}

// The url_file_map after applying validated changes. Other keys are kept as they are. Empty values remove their key, so a cleared
// setting leaves the map exactly as if it had never been set.
export function applyToUrlFileMap(map, changes) {
  const next = { ...(map || {}) };
  if (changes.writeAllow !== undefined || changes.writeDeny !== undefined) {
    const cur = next.writeScope || {};
    const ws = {
      allow: changes.writeAllow ?? (Array.isArray(cur.allow) ? cur.allow : []),
      deny: changes.writeDeny ?? (Array.isArray(cur.deny) ? cur.deny : []),
    };
    if (ws.allow.length || ws.deny.length) next.writeScope = ws; else delete next.writeScope;
  }
  if (changes.crossSiteLinks !== undefined) {
    if (changes.crossSiteLinks.length) next.crossSiteLinks = changes.crossSiteLinks.map((url) => ({ url })); else delete next.crossSiteLinks;
  }
  if (changes.markerSetupEnabled !== undefined) {
    next.markerSetup = { ...(next.markerSetup || {}), enabled: changes.markerSetupEnabled };
  }
  return next;
}
