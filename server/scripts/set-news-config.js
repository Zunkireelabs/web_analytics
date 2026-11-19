import 'dotenv/config';
import { pool } from '../db.js';
import { saveNewsConfig, getNewsConfig } from '../store/site-news-config.js';
import { NEWS_PRESETS } from '../agents/lib/news-presets.js';

// Sets a project's news-post settings from a preset.
//   node server/scripts/set-news-config.js --site-id 8862 --preset admizz              show what would be written (default)
//   node server/scripts/set-news-config.js --site-id 8862 --preset admizz --write      write it, switched OFF
//   node server/scripts/set-news-config.js --site-id 8862 --preset admizz --write --enable   write it and switch it on
// This writes to the database DATABASE_URL points at: on production it needs the owner's OK first.
const a = process.argv.slice(2);
const val = (k) => a[a.indexOf(k) + 1];
const siteId = Number(val('--site-id'));
const preset = NEWS_PRESETS[val('--preset')];
if (!Number.isInteger(siteId) || !preset) { console.error(`usage: --site-id <id> --preset <${Object.keys(NEWS_PRESETS).join('|')}> [--write] [--enable]`); process.exit(1); }
try {
  const existing = await getNewsConfig(siteId);
  const enabled = a.includes('--enable') || !!existing?.enabled;
  console.log(`site ${siteId}: ${existing ? 'has a config already (enabled=' + existing.enabled + ')' : 'no config yet'}; would write preset "${val('--preset')}", enabled=${enabled}, every ${preset.intervalDays} days, countries: ${preset.officialSources.map((s) => s.country).join(', ')}`);
  if (a.includes('--write')) { await saveNewsConfig(siteId, { ...preset, enabled }); console.log('written.'); } else console.log('dry run, nothing written.');
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await pool.end(); }
