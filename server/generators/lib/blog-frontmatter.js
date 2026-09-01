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

// The real image URL already on a post, under whichever alias it was written
// with — used to build the "images already in use on this site" set (see
// lib/blog-image-usage.js) so a new/repaired post never gets handed a photo
// another post already has.
export function extractImageUrl(raw) {
  const m = FRONT_MATTER.exec(raw || '');
  if (!m) return null;
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

// Inserts fields right after the closing `title`/`description` block if
// present, else right before the closing `---` — position doesn't matter to
// any parser here, but keeping new fields near the top instead of always
// last keeps the diff readable next to how newpage-render.js already orders
// them. Never touches anything outside the front-matter block — the body is
// always byte-identical before and after.
export function insertFrontMatterFields(raw, fields) {
  const lines = fields
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: "${escapeYaml(v)}"`);
  if (!lines.length) return raw;
  return raw.replace(FRONT_MATTER, (whole, body) => `---\n${body}\n${lines.join('\n')}\n---`);
}
