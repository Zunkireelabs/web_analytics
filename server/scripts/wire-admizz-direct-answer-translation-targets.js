// Wires Admizz's (site 8862) direct-answer and translation recommendations
// to the repo's TSX (Next.js App Router) rendering path, same as
// wire-admizz-blog-outline-target.js already did for blog-outline. Until
// this runs, both types are configured with no `newContentTargets` entry at
// all, so resolveTargetAndBody returns `no-file-mapping` and every
// recommendation of either type sits permanently blocked.
//
// Confirmed via direct repo inspection (Zunkireelabs/admizz-web-dev) and
// newpage-render.js/frontend.js changes made alongside this script:
//   - src/components/GeneratedDirectAnswer.tsx and
//     src/components/GeneratedTranslation.tsx are new, human-authored
//     components (this session's companion PR against admizz-web-dev,
//     branch feature/generated-direct-answer-translation off `main`) —
//     reuse the site's real typography/spacing/card classes, no new
//     visual design invented.
//   - renderDirectAnswerBodyTsx/renderTranslationBodyTsx
//     (server/implementers/lib/newpage-render.js) generate matching
//     src/app/**/page.tsx files that import those components and
//     JSON.stringify the content as props (safe against title/body text
//     containing quotes/braces/backticks), mirroring
//     renderBlogOutlineBodyTsx's already-proven pattern exactly.
//   - frontend.js's direct-answer/translation branches now auto-select this
//     TSX path the moment `filename` is set on the target config — no
//     further platform code changes needed, only this config.
//   - resolveTranslationTarget (url-file-map.js) was fixed in the same
//     change to produce a language-suffixed sibling DIRECTORY for a
//     Next.js App Router source file (e.g. src/app/about/page.tsx ->
//     src/app/about-fr/page.tsx) instead of a language-suffixed sibling
//     FILE (page.fr.tsx) — the latter is not a filename Next.js recognizes
//     as a route at all, which would have silently 404'd every translated
//     page this wiring produces.
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const { rows } = await pool.query('select url_file_map from sites where id=8862');
  const map = rows[0].url_file_map;
  map.newContentTargets = map.newContentTargets || {};

  let changed = false;

  if (!map.newContentTargets['direct-answer']) {
    map.newContentTargets['direct-answer'] = {
      dir: 'src/app/answers',
      extension: '.tsx',
      filename: 'page.tsx',
      urlPattern: '/answers/{slug}',
    };
    changed = true;
    console.log('[admizz] wired direct-answer -> src/app/answers/<slug>/page.tsx via GeneratedDirectAnswer');
  } else {
    console.log('[admizz] direct-answer newContentTarget already configured — skipping.');
  }

  if (!map.newContentTargets.translation) {
    // No `dir`/`urlPattern` needed here beyond documenting intent — the real
    // target file is derived from the SOURCE page's own resolved path via
    // resolveTranslationTarget, not from this config (see that function's
    // own comment). Only `filename` is load-bearing: it's the sole signal
    // frontend.js's translation branch checks to fork into the TSX renderer.
    map.newContentTargets.translation = {
      dir: 'src/app',
      extension: '.tsx',
      filename: 'page.tsx',
    };
    changed = true;
    console.log('[admizz] wired translation -> a language-suffixed sibling directory\'s page.tsx via GeneratedTranslation');
  } else {
    console.log('[admizz] translation newContentTarget already configured — skipping.');
  }

  if (changed) {
    await pool.query('update sites set url_file_map=$1 where id=8862', [JSON.stringify(map)]);
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
