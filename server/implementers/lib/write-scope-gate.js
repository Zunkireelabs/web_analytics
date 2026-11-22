// Repo write scope: which files in the repository a site's drafts may write.
//
// Two SuperRank sites can share one repo (zennly.io: marketplace pages and the /business section in the same codebase). Each has its
// own url_file_map, so each only MAPS its own pages, but a wrong or broad mapping, a shared layout/sitemap/robots/llms file, or a
// site-root setting could still let one site's draft overwrite files the other owns. This gate is the hard stop, checked in
// pushDraftBranch before anything is written, like the rendering and section-preservation gates beside it.
//
// Configured per site in url_file_map.writeScope = { allow: ['src/business/'], deny: ['src/_includes/layout.njk'] }:
//   allow  repo path prefixes the site may write. Absent or empty = the whole repo (today's behaviour for every site).
//   deny   repo path prefixes it may never write; deny always wins. Put the shared files here (or leave them out of allow) on every
//          site but the one that owns them.
// A prefix matches a whole path segment ('src/business' covers src/business/a.md, never src/business-old/a.md); a prefix naming a
// file matches exactly that file. Pure of any database or network.

const clean = (p) => String(p ?? '').trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
const list = (v) => (Array.isArray(v) ? v : []).map(clean).filter(Boolean);
const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

export function writeScopeOf(site) {
  const ws = site?.url_file_map?.writeScope;
  return { allow: list(ws?.allow), deny: list(ws?.deny) };
}

export function pathWritable(site, repoPath) {
  const { allow, deny } = writeScopeOf(site);
  if (!allow.length && !deny.length) return true;
  const p = clean(repoPath);
  if (!p) return false;
  if (deny.some((d) => under(p, d))) return false;
  return allow.length === 0 || allow.some((a) => under(p, a));
}

export function validateWriteScope(site, files) {
  const blocked = (Array.isArray(files) ? files : []).map((f) => f?.path).filter((p) => !pathWritable(site, p));
  if (!blocked.length) return { ok: true };
  return {
    ok: false, reason: 'outside-write-scope',
    error: `This site is not allowed to write ${blocked.slice(0, 3).join(', ')}${blocked.length > 3 ? ` and ${blocked.length - 3} more` : ''}: ${blocked.length === 1 ? 'it is' : 'they are'} outside its configured write scope (url_file_map.writeScope), usually because the file belongs to another site that shares this repository. Nothing was written. Fix the mapping, or change the write scope if this site should own the file.`,
  };
}
