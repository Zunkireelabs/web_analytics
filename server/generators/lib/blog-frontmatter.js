// Plain YAML-front-matter helpers shared by the blog-image detector
// (agents/blog-image.js), its generator (generators/blog-image.js), and its
// implementer merge (implementers/lib/blog-image-inject.js) — one real
// parser/writer for the three steps of the same pipeline, rather than each
// re-deriving its own copy (the original single-script version of this
// feature, server/scripts/backfill-blog-images.js, had exactly one copy
// because it was also the only step; splitting into detect/generate/apply
// for the Action Center is what makes this worth sharing now).
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

export function frontMatterKeys(raw) {
  const m = FRONT_MATTER.exec(raw || '');
  if (!m) return new Set();
  return new Set(
    m[1].split('\n')
      .filter((l) => !/^\s/.test(l))
      .map((l) => /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(l)?.[1])
      .filter(Boolean),
  );
}

export function extractTitle(raw) {
  const m = FRONT_MATTER.exec(raw || '');
  if (!m) return null;
  const t = /^title\s*:\s*"?(.*?)"?\s*$/m.exec(m[1]);
  return t ? t[1].trim() : null;
}

// Every key considered a real "this post already has a featured image"
// signal — matches newcontent-contract.js's own alias set, so detection and
// re-verification at generation/apply time can never disagree about what
// counts as "already has one."
export const IMAGE_FIELD_ALIASES = ['featuredImage', 'image', 'heroImage', 'cover', 'thumbnail'];

export function hasImageField(raw) {
  const keys = frontMatterKeys(raw);
  return IMAGE_FIELD_ALIASES.some((k) => keys.has(k));
}

// The real Pexels URL a post's image came from — used to build the "images
// already in use on this site" set (see lib/blog-image-usage.js) so a
// new/repaired post never gets handed a photo another post already has.
//
// `featuredImageSource` is checked FIRST: since the display image field now
// holds a local repo path (blog-image-fetch.js's caller downloads and
// commits the real file instead of hotlinking Pexels), the display field no
// longer carries a Pexels URL to extract an id from at all. featuredImageSource
// is a second, always-literal (never site-aliased — nothing renders it)
// front-matter field written alongside it purely to keep that URL around for
// this dedup check. IMAGE_FIELD_ALIASES stays the fallback so a post written
// before this change (Pexels URL still in the display field, no
// featuredImageSource) keeps being detected correctly during rollout.
export function extractImageUrl(raw) {
  const m = FRONT_MATTER.exec(raw || '');
  if (!m) return null;
  const source = /^featuredImageSource\s*:\s*"?(.*?)"?\s*$/m.exec(m[1]);
  if (source) return source[1].trim();
  for (const key of IMAGE_FIELD_ALIASES) {
    const v = new RegExp(`^${key}\\s*:\\s*"?(.*?)"?\\s*$`, 'm').exec(m[1]);
    if (v) return v[1].trim();
  }
  return null;
}

// Real blog-post file paths under a site's configured blog directory,
// filtered to actual posts (skips directory data files, the directory
// index, and anything with the wrong extension) — shared by
// agents/blog-image.js's detection scan and lib/blog-image-usage.js's
// used-image scan so the two never disagree about what counts as "a post".
export function listPostPaths(files, target) {
  const prefix = target.dir.endsWith('/') ? target.dir : `${target.dir}/`;
  return files.filter((p) => p.startsWith(prefix) && p.endsWith(target.extension || '.md')
    && !p.slice(prefix.length).includes('/') && !p.split('/').pop().startsWith('_') && !/^index\./i.test(p.split('/').pop()));
}

function escapeYaml(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Upserts fields into the front-matter block: a key already present gets its
// value replaced in place (or the line removed, for a null/empty value);
// a key not yet present is appended, skipped entirely for a null/empty
// value. The replace half is what lets blog-image's duplicate-photo repair
// swap an existing featuredImage/Alt/Credit trio for a new one without
// leaving a stale, now-mismatched credit line behind — the original
// insert-only version could only add fields to a post with none at all.
// Never touches anything outside the front-matter block — the body is
// always byte-identical before and after.
export function insertFrontMatterFields(raw, fields) {
  const relevant = fields.filter(([k]) => typeof k === 'string' && k);
  if (!relevant.length) return raw;
  const m = FRONT_MATTER.exec(raw || '');
  if (!m) return raw;
  const lines = m[1].split('\n');
  let changed = false;
  for (const [k, v] of relevant) {
    const idx = lines.findIndex((l) => new RegExp(`^${k}\\s*:`).test(l));
    if (v == null || v === '') {
      if (idx !== -1) { lines.splice(idx, 1); changed = true; }
      continue;
    }
    const valueLine = `${k}: "${escapeYaml(v)}"`;
    if (idx !== -1) {
      if (lines[idx] !== valueLine) { lines[idx] = valueLine; changed = true; }
    } else {
      lines.push(valueLine);
      changed = true;
    }
  }
  if (!changed) return raw;
  const body = lines.join('\n');
  return raw.replace(FRONT_MATTER, () => `---\n${body}\n---`);
}
