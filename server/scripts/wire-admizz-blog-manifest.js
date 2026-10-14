// Adds manifestFile to Admizz's (site 8862) blog-outline newContentTargets
// config, so frontend.js's computeGeneratedPostsManifestUpdate starts
// writing src/data/generated-posts.json alongside every new post — the
// piece that makes new posts appear on /blogs (see
// server/implementers/frontend.js's apply()).
//
// Idempotent — safe to re-run.
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const { rows } = await pool.query('select url_file_map from sites where id=8862');
  const map = rows[0].url_file_map;
  const target = map.newContentTargets?.['blog-outline'];
  if (!target) {
    console.log('[admizz] no blog-outline newContentTarget configured yet — run wire-admizz-blog-outline-target.js first.');
    await pool.end();
    return;
  }
  if (target.manifestFile) {
    console.log('[admizz] manifestFile already configured — skipping.');
    await pool.end();
    return;
  }
  target.manifestFile = 'src/data/generated-posts.json';
  await pool.query('update sites set url_file_map=$1 where id=8862', [JSON.stringify(map)]);
  console.log('[admizz] wired blog-outline manifestFile -> src/data/generated-posts.json');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
