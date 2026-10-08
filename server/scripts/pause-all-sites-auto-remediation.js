import 'dotenv/config';
import { pool, query, pauseSiteAutoRemediation } from '../db.js';

const apply = process.argv.includes('--apply');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? Number(daysArg.split('=')[1]) : 2;

async function main() {
  const resumeAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const { rows: sites } = await query(
    `SELECT id, name, auto_remediation_enabled, auto_remediation_resume_at FROM sites ORDER BY id`
  );

  console.log(`Found ${sites.length} site(s). Resume time: ${resumeAt.toISOString()} (${days} day(s) from now).`);
  for (const site of sites) {
    console.log(
      `  site ${site.id} (${site.name}): currently enabled=${site.auto_remediation_enabled}, resume_at=${site.auto_remediation_resume_at ?? 'null'}`
    );
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to actually pause all sites.');
    return;
  }

  for (const site of sites) {
    const updated = await pauseSiteAutoRemediation(site.id, resumeAt);
    console.log(`  paused site ${site.id} (${site.name}) until ${updated.auto_remediation_resume_at}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
