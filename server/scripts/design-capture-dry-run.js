import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { createLiveDesignAnalysisHandler } from '../design-agent/live-analysis-handler.js';
import { extractDesignProfile } from '../design-agent/live-analysis/profile-extract.js';
import { stampDesignProfile, validateDesignProfile } from '../design-agent/lib/design-profile.js';
import { sitePageUrl, TEMPLATE_VERIFIED_BY } from '../implementers/lib/design-drift.js';

// Finds out WHY a project's design capture fails, without saving anything.
//
//   node server/scripts/design-capture-dry-run.js --site-id 8874          prints what it would do (nothing runs)
//   node server/scripts/design-capture-dry-run.js --site-id 8874 --run    runs the real capture and the real model call (one call, about a minute),
//                                                                         then runs the platform's own validation on the result and prints which
//                                                                         rule fails. NOTHING is saved: the project, the queue and the job table
//                                                                         are not touched.
//
// It runs the same steps the Design Agent worker runs (live-analysis-handler.js), up to and including the validation that persistDesignProfile applies.
const argv = process.argv;
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : (argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[i + 1]); };

async function main() {
  const siteId = Number(flag('site-id')); const run = flag('run') === true;
  if (!siteId) { console.error('Usage: design-capture-dry-run.js --site-id <id> [--run]'); process.exit(1); }
  const site = await getSiteById(siteId);
  if (!site) { console.error(`Site ${siteId} not found.`); process.exit(1); }
  const pageUrl = sitePageUrl(site);
  console.log(`\nSite ${siteId} "${site.name}"  page to capture: ${pageUrl}`);
  if (!run) { console.log('\nCHECK ONLY. Nothing ran. Add --run to run the real capture and ONE model call; nothing is saved.'); return; }

  let raw = null;
  const handler = createLiveDesignAnalysisHandler({
    getSiteByIdFn: async () => ({ ...site, url_file_map: { ...(site.url_file_map || {}), siteRoot: { ...(site.url_file_map?.siteRoot || {}), designProfile: undefined } } }),
    extractProfileFn: async (...a) => { raw = await extractDesignProfile(...a); return raw; },
  });
  const t0 = Date.now();
  let outcome;
  try { outcome = await handler({ id: 0, site_id: siteId, params: { mode: 'design-profile', pageUrl } }); }
  catch (err) { console.log(`\nFAILED BEFORE VALIDATION at stage "${err.stage || 'unknown'}": ${err.message}`); process.exit(2); }
  console.log(`\nCapture and model call finished in ${Math.round((Date.now() - t0) / 1000)}s.`);

  const profile = stampDesignProfile(outcome.designProfile, { derivedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT, derivedRef: 0 });
  const v = validateDesignProfile(profile);
  console.log(v.ok ? '\nVALIDATION: PASSES (the platform would have saved this profile).' : `\nVALIDATION: FAILS: ${v.errors.length} rule(s):\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
  const show = (label, val) => console.log(`  ${label.padEnd(26)} ${JSON.stringify(val)}`);
  console.log('\nWhat the platform received:');
  show('version', profile.version); show('typography.body', profile.typography?.body); show('typography.heading', profile.typography?.heading);
  show('layout', profile.layout); show('spacing', profile.spacing); show('pages analysed', (profile.pages || []).length);
  show('top-level keys', Object.keys(profile));
  console.log('\nNothing was saved.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
