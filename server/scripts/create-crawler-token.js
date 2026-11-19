import { createCrawlerToken } from '../store/ai-crawlers.js';
import { getSiteById } from '../store/read.js';
import { pool } from '../db.js';

// Creates the upload token for one project's log-shipping script (deploy/ai-crawler-shipper/README.md).
//
//   node server/scripts/create-crawler-token.js --site-id <id> [--label "superrank-web-prod"]
//
// The raw token is printed ONCE and never stored (only its hash is). Put it straight into the shipper's token file on the web
// server. WRITES to whichever database DATABASE_URL points at: against production that needs the owner's explicit OK.
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };

try {
  const siteId = Number(arg('site-id'));
  if (!Number.isInteger(siteId) || siteId <= 0) { console.error('Usage: node server/scripts/create-crawler-token.js --site-id <id> [--label <text>]'); process.exit(1); }
  const site = await getSiteById(siteId);
  if (!site) { console.error(`No project with id ${siteId}.`); process.exit(1); }
  const t = await createCrawlerToken(siteId, { label: arg('label') });
  console.log(`Project: ${site.name} (id ${site.id})`);
  console.log(`Token id ${t.id}, prefix ${t.token_prefix}…`);
  console.log('\nToken (shown once, store it now):\n' + t.token);
} catch (err) {
  console.error('create-crawler-token failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
