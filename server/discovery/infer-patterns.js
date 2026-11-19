// Infers page -> template-file mappings from the repository itself, for pages the platform has no file for yet. Stack-agnostic: it tries the places
// the common stacks keep a page or a collection entry (Eleventy `src/blog/<slug>/index.njk`, Astro content collections `src/content/blog/<slug>.md`,
// Next/Hugo `content/blog/<slug>.mdx`, plain `src/pages/...`), and trusts a candidate ONLY when the file really exists in the repository tree.
//
//   - A URL section (`/blog/<slug>`) becomes ONE pattern when EVERY page in the section resolves to a real file under the same template. One page
//     with no file means no pattern for that section; the pages that do have files become exact entries and the rest are reported.
//   - A page outside any section becomes an exact entry when exactly ONE candidate file exists. None, or several, is reported with the reason.
// Pure. discovery/url-pattern.js still validates what this proposes before anything is saved.

export const EXTENSIONS = ['njk', 'md', 'mdx', 'html', 'liquid', 'hbs', 'ejs', 'astro', 'vue', 'svelte', 'tsx', 'jsx'];
const ROOTS = ['src', 'src/pages', 'src/content', 'content', 'pages', 'docs', ''];
const join = (...parts) => parts.filter((p) => p !== '').join('/');

const pathOf = (page) => { let p; try { p = new URL(page).pathname; } catch { p = String(page); } return p.length > 1 ? p.replace(/\/+$/, '') : p; };

// Every file a slug under `parent` could live in, in the order the stacks use them.
function templatesFor(parent) {
  const out = [];
  for (const root of ROOTS) for (const ext of EXTENSIONS) {
    out.push({ file: join(root, parent, '$1', `index.${ext}`) });
    out.push({ file: join(root, parent, `$1.${ext}`) });
  }
  return out;
}
const fill = (template, slug) => template.replace('$1', slug);
const regexFor = (parent) => `^/${parent.split('/').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}/([^/]+)/?$`;

function exactCandidates(path, files) {
  const out = [];
  const base = path === '/' ? '' : path.replace(/^\//, '');
  for (const root of ROOTS) for (const ext of EXTENSIONS) {
    const names = base === '' ? [join(root, `index.${ext}`)] : [join(root, `${base}.${ext}`), join(root, base, `index.${ext}`)];
    for (const n of names) if (files.has(n)) out.push(n);
  }
  return [...new Set(out)];
}

export function inferMappings({ unmappedPages = [], repoFiles = [] }) {
  const files = new Set(repoFiles.map((f) => (typeof f === 'string' ? f : f.path)));
  const paths = unmappedPages.map((p) => ({ page: p, path: pathOf(p) }));

  // 1. sections: pages sharing a parent path, two or more
  const byParent = new Map();
  for (const x of paths) {
    const segs = x.path.split('/').filter(Boolean);
    if (segs.length < 2) continue;
    const parent = segs.slice(0, -1).join('/');
    byParent.set(parent, [...(byParent.get(parent) || []), { ...x, slug: segs[segs.length - 1] }]);
  }
  const patterns = []; const pages = []; const gaps = []; const handled = new Set();
  for (const [parent, members] of byParent) {
    if (members.length < 2) continue;
    const scored = templatesFor(parent).map((t) => ({ t, hits: members.filter((m) => files.has(fill(t.file, m.slug))) })).filter((s) => s.hits.length);
    scored.sort((a, b) => b.hits.length - a.hits.length);
    const best = scored[0];
    if (best && best.hits.length === members.length) {
      patterns.push({ match: regexFor(parent), file: best.t.file, covers: members.length });
      members.forEach((m) => handled.add(m.page));
      continue;
    }
    // Not a clean section: whatever has its own file becomes an exact entry; the rest are reported with the best partial result.
    for (const m of members) {
      const found = best && best.hits.includes(m) ? fill(best.t.file, m.slug) : null;
      if (found) { pages.push({ path: m.path, file: found }); handled.add(m.page); }
      else gaps.push({ page: m.page, reason: best ? `no-template-file (the section's template exists for ${best.hits.length} of ${members.length} pages)` : 'no-template-file-in-the-repository' });
      handled.add(m.page);
    }
  }

  // 2. everything else: exact, when exactly one candidate file exists
  for (const x of paths) {
    if (handled.has(x.page)) continue;
    const c = exactCandidates(x.path, files);
    if (c.length === 1) pages.push({ path: x.path, file: c[0] });
    else gaps.push({ page: x.page, reason: c.length ? `ambiguous (${c.length} candidate files)` : 'no-template-file-in-the-repository', candidates: c.slice(0, 3) });
  }
  return { patterns, pages, gaps };
}
