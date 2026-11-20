import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { refreshBusinessProfile } from '../lib/business-intelligence.js';
import { describeCompany, ownIndustryLabel, FIELD_KEYS, normalizeProfile, emptyProfile, profileState } from '../lib/business-profile.js';
import { validateTopics } from '../agents/lib/topic-relevance.js';
import { validateCompetitorCandidate } from '../agents/lib/competitor-category.js';
import { query } from '../db.js';

// READ-ONLY proposal of the data changes the business intelligence layer would make. It writes NOTHING to the database.
//
//   node server/scripts/propose-business-intelligence-changes.js --site-id 8872 --site-id 8871 [--out report.json]
//
// For each project it (1) runs the profile engine but captures the version instead of saving it, (2) judges the project's open blog
// recommendations against that proposed profile, and (3) lists the stored competitors the category check would exclude. The report is
// what a person reviews and approves BEFORE any profile is written, any recommendation is closed or any competitor row is changed.
// Set LLM_TEST_CACHE_DIR-style caching is not used here: every model call is real and counted.

const argv = process.argv;
const ids = argv.flatMap((a, i) => (a === '--site-id' ? [Number(argv[i + 1])] : [])).filter(Boolean);
const out = (() => { const i = argv.indexOf('--out'); return i > -1 ? argv[i + 1] : null; })();
if (!ids.length) { console.error('Usage: node server/scripts/propose-business-intelligence-changes.js --site-id <id> [--site-id <id> ...] [--out report.json]'); process.exit(1); }

const report = [];
for (const siteId of ids) {
  const captured = [];
  const entry = { siteId };
  try {
    const run = await refreshBusinessProfile(siteId, {
      reason: 'baseline',
      deps: {
        getCurrent: async () => null, // propose from nothing: shows what a first profile would hold
        save: async (id, body) => { captured.push(body); return { unchanged: false, version: 1, dryRun: true }; },
      },
    });
    entry.run = { insufficient: run.insufficient, reason: run.reason ?? null, usage: run.usage ?? null };
    const body = captured[0];
    const profile = normalizeProfile(body?.profile || emptyProfile());
    entry.profile = {
      state: profileState(profile),
      ownIndustry: ownIndustryLabel(profile),
      description: describeCompany(profile),
      fields: Object.fromEntries(FIELD_KEYS.map((k) => [k, { status: profile.fields[k].status, confidence: profile.fields[k].confidence, value: profile.fields[k].value, evidenceCount: profile.fields[k].evidence.length }])),
    };

    // Open recommendations that would be closed: blog topics this profile says are not relevant to the company.
    const { rows: recs } = await query(`SELECT id, recommendation_type, page, params FROM recommendations WHERE site_id = $1 AND status = 'open' AND recommendation_type = 'blog-outline' ORDER BY id`, [siteId]);
    const topicOf = (r) => String(r.params?.topic || r.page || '').replace(/^topic::/, '');
    const ctx = { status: 'canonical', profile, siteId };
    const verdicts = entry.profile.ownIndustry ? await validateTopics(recs.map(topicOf), ctx, { siteId }) : recs.map((r) => ({ topic: topicOf(r), verdict: 'unknown', reasons: ['no usable profile'] }));
    entry.recommendations = {
      open: recs.length,
      wouldClose: recs.map((r, i) => ({ id: r.id, topic: verdicts[i].topic, verdict: verdicts[i].verdict, reasons: verdicts[i].reasons })).filter((x) => x.verdict === 'reject'),
      held: recs.map((r, i) => ({ id: r.id, topic: verdicts[i].topic, reasons: verdicts[i].reasons })).filter((_, i) => verdicts[i].verdict === 'unknown'),
      keep: recs.length - verdicts.filter((v) => v.verdict !== 'accept').length,
    };

    // Stored competitors the category check would exclude.
    const { rows: comps } = await query(`SELECT id, domain, excluded_reason FROM competitor_profiles WHERE site_id = $1 AND excluded_reason IS NULL ORDER BY domain`, [siteId]);
    entry.competitors = {
      active: comps.length,
      wouldExclude: comps.map((c) => ({ id: c.id, domain: c.domain, ...validateCompetitorCandidate(c.domain, {}, profile) })).filter((c) => c.excluded).map((c) => ({ id: c.id, domain: c.domain, kind: c.kind, reasons: c.reasons })),
    };
  } catch (err) { entry.error = String(err.message).slice(0, 200); }
  report.push(entry);
  console.log(`site ${siteId}: profile ${entry.profile?.state ?? 'none'} (${entry.profile?.ownIndustry ?? 'no industry'}) | open blog recs ${entry.recommendations?.open ?? '?'} -> would close ${entry.recommendations?.wouldClose?.length ?? '?'}, hold ${entry.recommendations?.held?.length ?? '?'} | competitors ${entry.competitors?.active ?? '?'} -> would exclude ${entry.competitors?.wouldExclude?.length ?? '?'}${entry.error ? ` | ERROR ${entry.error}` : ''}`);
}
if (out) { writeFileSync(out, JSON.stringify(report, null, 1)); console.log(`\nFull report written to ${out}. NOTHING was written to the database.`); }
else console.log('\nNOTHING was written to the database. Add --out <file> to save the full report.');
process.exit(0);
