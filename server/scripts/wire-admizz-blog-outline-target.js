// Wires Admizz's (site 8862) blog-outline recommendations to the repo's
// already-existing local-content rendering path instead of leaving them
// blocked forever waiting on a Sanity write capability that was never
// provisioned. Per the user's explicit product decision (2026-09-15):
// existing Sanity-backed blog content stays protected/read-only; NEW
// SEO-generated posts should be created as static files using the repo's
// own existing template.
//
// Confirmed via direct repo inspection (Zunkireelabs/admizz-web-dev) before
// writing this:
//   - src/components/GeneratedBlogPost.tsx already exists — a generic,
//     non-Sanity post renderer built specifically for agent-authored posts
//     (props: title, sections[], featuredImage?, infoBox?, publishedAt?).
//   - server/implementers/lib/newpage-render.js's renderBlogOutlineBodyTsx
//     already generates a matching src/app/blogs/<slug>/page.tsx that
//     imports GeneratedBlogPost and JSON.stringify's the content as props
//     (safe against title/body text containing quotes/braces/backticks).
//   - frontend.js's blog-outline branch already auto-selects this TSX path
//     the moment newContentTargets["blog-outline"].filename is set — no
//     platform code changes needed, only this config.
//
// NOT yet solved by this: a locally-generated post will NOT appear in
// src/app/blogs/page.tsx's listing (which only queries Sanity) — it's
// reachable by direct URL/internal links/sitemap, not the /blogs index.
// That's a separate, harder piece of work if the user wants it later.
//
// direct-answer/translation are NOT touched here — those use the markdown/
// front-matter renderer (renderDirectAnswerBody/renderTranslationBody),
// which is Eleventy-style and NOT valid in a Next.js App Router .tsx file;
// no TSX variant exists for them yet, unlike blog-outline.
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const { rows } = await pool.query('select url_file_map from sites where id=8862');
  const map = rows[0].url_file_map;
  map.newContentTargets = map.newContentTargets || {};
  if (map.newContentTargets['blog-outline']) {
    console.log('[admizz] blog-outline newContentTarget already configured — skipping.');
    await pool.end();
    return;
  }
  map.newContentTargets['blog-outline'] = {
    dir: 'src/app/blogs',
    extension: '.tsx',
    filename: 'page.tsx',
    urlPattern: '/blogs/{slug}',
  };
  await pool.query('update sites set url_file_map=$1 where id=8862', [JSON.stringify(map)]);
  console.log('[admizz] wired blog-outline -> src/app/blogs/<slug>/page.tsx via GeneratedBlogPost');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
