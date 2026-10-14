// A page that earns clicks or ranks near the top is the one place an
// unattended change can only lose. A title rewrite, a canonical swap, a
// redirect or a new body section on such a page can move its ranking either
// way, and the cost of being wrong is the traffic the site already has — so
// those changes need a human, however "safe" the generator's own tier is.
// (A page's tier says the FIX is mechanically safe; this says the PAGE is
// worth more than a mechanical guarantee.)
//
// One rule, asked from every unattended entry point: the coordinator (so the
// Action Center shows the right tier), auto-remediation.js's loop and
// listOpenSafeRecommendations' callers (so nothing slips past a writer that
// set its own tier). A human clicking Generate/Approve is unaffected.

// Generators whose change can alter how an already-ranking page performs.
// Additive, invisible or mechanical fixes (alt text, schema, breadcrumbs,
// llms.txt, internal links, broken-link removal) are deliberately NOT here.
export const PROTECTED_CHANGE_GENERATORS = new Set([
  'meta-title', 'canonical', 'redirect-fix', 'redirect-chain-nginx',
  'url-variant-duplicate', 'templated-duplicate-family', 'sitemap-frontmatter-exclude',
  'expand-content', 'refresh-content', 'content-integrity-repair', 'translation',
]);

// Thresholds over the page's last 28 data-complete days. Clicks are the
// primary signal; the position rule catches a page that ranks well but has not
// yet earned clicks (the next title/content change there is the riskiest).
export const PROTECTED_MIN_CLICKS = Number(process.env.PROTECTED_PAGE_MIN_CLICKS || 5);
export const PROTECTED_MIN_IMPRESSIONS_FOR_POSITION = Number(process.env.PROTECTED_PAGE_MIN_IMPRESSIONS || 50);
export const PROTECTED_MAX_POSITION = Number(process.env.PROTECTED_PAGE_MAX_POSITION || 5);

// Recommendation page keys carry suffixes (`url::focus`, `url::typography-
// drift::1`); the protected set holds plain page URLs. www/apex and a trailing
// slash are one page.
export function normalizePageKey(page) {
  if (!page) return '';
  const url = String(page).split('::')[0];
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch { return url.toLowerCase().replace(/\/+$/, ''); }
}

// rows: [{ page, clicks, impressions, positionSum }] over the window, where
// positionSum is SUM(position * impressions) so the average is impression-
// weighted. Pure, so the thresholds are testable without a database.
export function computeProtectedPages(rows, {
  minClicks = PROTECTED_MIN_CLICKS, minImpressions = PROTECTED_MIN_IMPRESSIONS_FOR_POSITION, maxPosition = PROTECTED_MAX_POSITION,
} = {}) {
  const pages = new Set();
  for (const r of rows || []) {
    const impressions = Number(r.impressions) || 0;
    const avgPos = impressions > 0 ? Number(r.positionSum) / impressions : null;
    if (Number(r.clicks) >= minClicks || (impressions >= minImpressions && avgPos != null && avgPos <= maxPosition)) {
      pages.add(normalizePageKey(r.page));
    }
  }
  return pages;
}

// rec: a recommendations row ({ recommendation_type, page, params }) or a
// grounded item ({ generatorId, params }). True when this is a change type
// that can alter a ranking page AND the page is protected (or unknown).
export function isProtectedChange(rec, protectedSet) {
  if (!rec || !protectedSet) return false;
  const generatorId = rec.recommendation_type || rec.generatorId;
  if (!PROTECTED_CHANGE_GENERATORS.has(generatorId)) return false;
  if (protectedSet.unknown) return true;
  const page = rec.params?.page || rec.page;
  return !!page && protectedSet.pages.has(normalizePageKey(page));
}

export const PROTECTED_PAGE_REASON =
  'This page earns clicks or ranks near the top of search, so a title, canonical, redirect or content change here needs a person to approve it — an automatic change can only lose traffic the page already has.';

// ---- The shared shipping queue's lanes ------------------------------------
// learned-repair and the file-edits producers (content-repair, template-
// capability-repair) ship through shipping_queue and never see
// classifyRecommendation, so the same rule is applied where they are drained.
// (The analyst and design-agent lanes write ordinary recommendations through
// the coordinator, which already applies it.)

// learned-repair items are generator drafts: judged exactly like a
// recommendation. Rows carry snake_case `generator_id`.
export function splitProtectedQueueItems(items, protectedPages) {
  const kept = []; const held = [];
  for (const it of items || []) {
    const protectedItem = isProtectedChange({ generatorId: it.generator_id || it.generatorId, params: it.params }, protectedPages);
    (protectedItem ? held : kept).push(it);
  }
  return { kept, held };
}

// Files that more than one page renders from — templates, layouts, dynamic
// routes. Read from the site's own url_file_map, so it needs no inventory:
//   - a pattern whose file has no $N capture maps every matching page to ONE
//     file (e.g. `^/([^/]+)/?$` -> src/app/[slug]/page.tsx);
//   - a Next/Astro-style dynamic segment ([slug], [...rest]) is one file for
//     many URLs even when a capture is present;
//   - two or more distinct `pages` entries naming the same file.
// Such a file is a template, not a page's own file: an edit to it is not "a
// change to one ranking page", and holding it would freeze every other page
// that renders from it.
export function sharedMappedFiles(site) {
  const map = site?.url_file_map || {};
  const shared = new Set();
  for (const pat of map.patterns || []) {
    if (!pat?.file) continue;
    if (!/\$\d+/.test(pat.file) || /\[[^\]]+\]/.test(pat.file)) shared.add(pat.file);
  }
  const owners = new Map(); // file -> Set(normalized page path)
  for (const [path, entry] of Object.entries(map.pages || {})) {
    if (!entry?.file) continue;
    if (!owners.has(entry.file)) owners.set(entry.file, new Set());
    owners.get(entry.file).add(path.replace(/\/+$/, '') || '/');
  }
  for (const [file, paths] of owners) if (paths.size > 1) shared.add(file);
  return shared;
}

// The repo files that belong to protected pages — each page's OWN file only
// (see sharedMappedFiles). `resolveFile(site, pageUrl)` is url-file-map.js's;
// each protected key is tried with and without the trailing slash.
export function protectedFilePaths(site, protectedPages, resolveFile) {
  const shared = sharedMappedFiles(site);
  const files = new Set();
  for (const key of protectedPages?.pages || []) {
    for (const url of [`https://${key}/`, `https://${key}`]) {
      let f = null;
      try { f = resolveFile(site, url); } catch { f = null; }
      if (f && !shared.has(f)) files.add(f);
    }
  }
  return files;
}

// file-edits items bundle many independent whole-file edits. A protected
// page's own file is taken OUT of the bundle and the rest ships, so one
// protected page never blocks a whole-site repair. The commit message lists
// every file, so the held ones are removed from it and the omission is stated.
// When the lookup is unknown the whole bundle waits for the next run: without
// the set there is no way to tell which files are a ranking page's own.
export function splitProtectedFileEdits(items, protectedFiles, { unknown = false } = {}) {
  if (unknown) return { items: [], held: (items || []).map((it) => ({ itemId: it.id, paths: ['(protected-page lookup unavailable — waiting for the next run)'] })) };
  const out = []; const held = [];
  for (const it of items || []) {
    const edits = it.params?.edits || [];
    const heldEdits = edits.filter((e) => protectedFiles.has(e.path));
    if (!heldEdits.length) { out.push(it); continue; }
    held.push({ itemId: it.id, paths: heldEdits.map((e) => e.path) });
    const keptEdits = edits.filter((e) => !protectedFiles.has(e.path));
    if (!keptEdits.length) continue; // nothing left to ship; the producer recomputes next run
    const heldSet = new Set(heldEdits.map((e) => e.path));
    const msg = String(it.params?.commitMessage || '')
      .split('\n').filter((line) => ![...heldSet].some((p) => line.trim() === `- ${p}`)).join('\n');
    out.push({ ...it, params: { ...it.params, edits: keptEdits, commitMessage: `${msg}\n\nHeld for review (ranking pages): ${[...heldSet].join(', ')}`.trim() } });
  }
  return { items: out, held };
}
