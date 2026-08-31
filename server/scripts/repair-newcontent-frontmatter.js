#!/usr/bin/env node
// Repairs the front matter of net-new pages already written into a tenant repo
// so they match the contract the target directory's own files use.
//
// WHY THIS EXISTS
//
// newcontent-contract.js makes future pages derive their layout and field
// names from their target directory's existing files. It cannot fix the pages
// already committed. On this platform's first client, 27 generated blog posts
// each declare `layout: "base.njk"`, which OVERRIDES the `blog-post.njk` that
// src/blog/blog.json sets for that whole directory — so every one of them
// renders in the bare site shell instead of the blog template, losing the
// breadcrumb, category, read-time, author byline, hero image and Article
// schema. And each writes its image under `image:` when the template reads
// `featuredImage`, so the Pexels image that was genuinely fetched never
// appears.
//
// The contract is READ from the directory, never assumed: the script looks at
// the sibling files a human wrote and does what they do. If they declare no
// layout, the generated ones shouldn't either. If they call the hero image
// `featuredImage`, that is its name.
//
// Only the front-matter block is touched. Body content is never modified.
//
//   node server/scripts/repair-newcontent-frontmatter.js --repo <path> --dir src/blog
//   node server/scripts/repair-newcontent-frontmatter.js --repo <path> --dir src/blog --write

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function keysOf(raw) {
  const m = FRONT_MATTER.exec(raw);
  if (!m) return [];
  return m[1].split('\n')
    .filter((l) => !/^\s/.test(l))
    .map((l) => /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(l))
    .filter(Boolean)
    .map((m2) => m2[1]);
}

function declaredLayout(raw) {
  const m = FRONT_MATTER.exec(raw);
  if (!m) return null;
  const l = /^layout\s*:\s*"?([^"\n]*)"?\s*$/m.exec(m[1]);
  return l ? l[1].trim() : null;
}

// Returns the body with its outermost contentWrapper <div> removed, or null
// when the body is not wrapped in one. Deliberately conservative: it must be
// the FIRST thing in the body and the LAST, and it must be a container-ish
// wrapper, or we are looking at real content and leave it alone.
function stripContentWrapper(body) {
  const trimmed = body.trim();
  const open = /^<div class="([^"]*)">\s*/.exec(trimmed);
  if (!open) return null;
  if (!/\b(container|max-w|prose)/.test(open[1])) return null;
  if (!trimmed.endsWith('</div>')) return null;
  return `\n${trimmed.slice(open[0].length, -'</div>'.length).trim()}\n`;
}

/**
 * @param {string} repoDir a real directory containing the repo's `src/`
 * @param {string} dir     target directory relative to repoDir, e.g. "src/blog"
 * @param {{write?: boolean}} [opts]
 * @returns {{ok: boolean, reason?: string, contract?: object, changedFiles: string[]}}
 */
export async function repairNewContentFrontmatter(repoDir, dir, { write = false } = {}) {
  const full = path.join(repoDir, dir);
  let entries;
  try {
    entries = (await readdir(full)).filter((f) => /\.(md|njk|html)$/.test(f) && !/^index\./i.test(f) && !f.startsWith('_'));
  } catch {
    return { ok: false, reason: 'directory-not-found', changedFiles: [] };
  }

  // Split the directory into the files a human wrote (no agent marker) and the
  // ones the agent generated. The former define the contract.
  const files = [];
  for (const name of entries) {
    const p = path.join(full, name);
    const raw = await readFile(p, 'utf8');
    files.push({ name, p, raw, generated: /^\s*templateEngineOverride\s*:/m.test((FRONT_MATTER.exec(raw) || ['', ''])[1]) });
  }

  const human = files.filter((f) => !f.generated);
  if (!human.length) return { ok: false, reason: 'no-human-sibling', changedFiles: [] };

  const humanLayouts = human.map((f) => declaredLayout(f.raw));
  const layoutIsDeclared = humanLayouts.filter(Boolean).length > humanLayouts.length / 2;
  const humanKeys = new Set(human.flatMap((f) => keysOf(f.raw)));

  const IMAGE_ALIASES = ['featuredImage', 'image', 'heroImage', 'cover', 'thumbnail'];
  const ALT_ALIASES = ['featuredImageAlt', 'imageAlt', 'image_alt', 'coverAlt'];
  const imageKey = IMAGE_ALIASES.find((k) => humanKeys.has(k));
  const altKey = ALT_ALIASES.find((k) => humanKeys.has(k));

  const changedFiles = [];
  for (const f of files.filter((x) => x.generated)) {
    const m = FRONT_MATTER.exec(f.raw);
    if (!m) continue;
    let block = m[1];
    const before = block;
    let layoutRemoved = false;

    if (!layoutIsDeclared && /^layout\s*:/m.test(block)) {
      block = block.split('\n').filter((l) => !/^layout\s*:/.test(l)).join('\n');
      layoutRemoved = true;
    }
    if (imageKey && imageKey !== 'image' && /^image\s*:/m.test(block)) {
      block = block.replace(/^image\s*:/m, `${imageKey}:`);
    }
    if (altKey && altKey !== 'image_alt' && /^image_alt\s*:/m.test(block)) {
      block = block.replace(/^image_alt\s*:/m, `${altKey}:`);
    }

    // The generated body is wrapped in the site's contentWrapper — a container
    // plus section padding. That wrapper exists for a page with no layout doing
    // the job. The moment we hand the file back to the directory's real layout,
    // that layout supplies the container AND the prose typography, and the
    // generated one becomes a second container nested inside it: doubled
    // padding, and a max-width inside a grid column that already has one.
    //
    // Only stripped when the layout was removed — i.e. only when we know a
    // layout is now doing the wrapping. A page that genuinely declares its own
    // layout keeps its wrapper, because nothing else would style it.
    let body = f.raw.slice(m[0].length);
    if (layoutRemoved) {
      const unwrapped = stripContentWrapper(body);
      if (unwrapped !== null) body = unwrapped;
    }

    if (block === before && body === f.raw.slice(m[0].length)) continue;
    changedFiles.push(f.name);
    if (write) await writeFile(f.p, `---\n${block}\n---\n${body}`);
  }

  return {
    ok: true,
    contract: { layout: layoutIsDeclared ? humanLayouts.find(Boolean) : null, imageKey, altKey },
    changedFiles,
  };
}

// CLI entrypoint only — importing this module must never parse argv or exit.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
  };
  const repo = arg('repo');
  const dir = arg('dir');
  const write = process.argv.includes('--write');
  if (!repo || !dir) {
    console.error('Usage: repair-newcontent-frontmatter.js --repo <path> --dir <src/blog> [--write]');
    process.exit(1);
  }

  const result = await repairNewContentFrontmatter(repo, dir, { write });
  if (!result.ok) {
    console.error(result.reason === 'no-human-sibling'
      ? `No hand-written sibling in ${dir} to read the contract from — refusing to guess.`
      : `Could not read ${dir}.`);
    process.exit(1);
  }
  console.log(`Contract read from ${dir}:`);
  console.log(`  layout      : ${result.contract.layout || 'NOT declared (the directory supplies it)'}`);
  console.log(`  image key   : ${result.contract.imageKey || '(none observed)'}`);
  console.log(`  image alt   : ${result.contract.altKey || '(none observed)'}\n`);
  for (const f of result.changedFiles) console.log(`  ${f}`);
  console.log(`\n${result.changedFiles.length} file(s) ${write ? 'updated' : 'would be updated'}.`);
  if (!write) console.log('Dry run — re-run with --write to apply.');
}
