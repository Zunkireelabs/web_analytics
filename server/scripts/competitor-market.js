import 'dotenv/config';
import { requireWriteAllowed, announceDatabase } from '../lib/script-guard.js';
import { getSiteById } from '../store/read.js';
import { resolveMarketServiceTerms } from '../agents/lib/market-seed-terms.js';
import { discoverMarketCompetitors } from '../agents/lib/competitor-market-discovery.js';
import { upsertCompetitorClassification, listCompetitorsByKind } from '../store/competitor-profiles.js';
import { listSpendByEndpoint, getMonthSpendUsd, getMonthlyBudgetUsd, setMonthlyBudgetUsd } from '../store/provider-spend.js';
import { getSearchPerformanceRange } from '../store/read.js';
import { pool } from '../db.js';

// Market map for ONE project: who competes for the searches this business should be found for, and which of them are
// genuine rivals rather than directories or one-keyword domains.
//
// Read-only by default EXCEPT that discovery itself is a paid DataForSEO call, so --dry-run is the safe default and
// nothing is called without --run. Classifications are only stored with --save.
//
//   node server/scripts/competitor-market.js --site-id 8862                 # what is already stored, plus spend
//   node server/scripts/competitor-market.js --site-id 8862 --seeds         # the keyword set that would be asked, no call
//   node server/scripts/competitor-market.js --site-id 8862 --run           # make the paid call, print, store nothing
//   node server/scripts/competitor-market.js --site-id 8862 --run --save    # also store the classifications
//   node server/scripts/competitor-market.js --site-id 8862 --set-budget 5  # cap this project's monthly DataForSEO spend
//   node server/scripts/competitor-market.js --site-id 8862 --cycle         # full cycle, DRY: no paid footprint, nothing written
//   node server/scripts/competitor-market.js --site-id 8862 --cycle --save  # full cycle for real: buys data, writes opportunities
//   node server/scripts/competitor-market.js --site-id 8862 --opportunities # what is already in the queue from competitor evidence
//
// Prints domains, evidence and costs. Never another company's page content, never a credential.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}

const money = (n) => (typeof n === 'number' ? `$${n.toFixed(4)}` : 'not reported');

function printGroup(label, rows) {
  if (!rows.length) return;
  console.log(`\n${label} (${rows.length})`);
  for (const r of rows) {
    const score = r.relevanceScore ?? r.relevance_score;
    console.log(`  ${r.domain}  score ${score == null ? 'n/a' : Number(score).toFixed(3)}  ${r.confidence ? `confidence ${r.confidence}` : ''}`);
    if (r.reason) console.log(`      ${r.reason}`);
    const e = r.evidence || r.classification;
    if (e) {
      const parts = [];
      if (e.serpQueryHits != null) parts.push(`ranks for ${e.serpQueryHits}/${e.queriesChecked} asked keywords`);
      if (e.serviceTermOverlap != null) parts.push(`service overlap ${Math.round(e.serviceTermOverlap * 100)}%`);
      else parts.push('service overlap not measured');
      if (parts.length) console.log(`      evidence: ${parts.join(', ')}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const siteId = Number(args['site-id']);
  if (!Number.isInteger(siteId)) throw new Error('Pass --site-id <id>.');
  announceDatabase();

  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site ${siteId}.`);
  console.log(`\nSite ${site.id} — ${site.name}`);

  if (args['set-budget'] != null && args['set-budget'] !== true) {
    requireWriteAllowed(args);
    await setMonthlyBudgetUsd(siteId, 'dataforseo', Number(args['set-budget']));
    console.log(`Monthly DataForSEO budget for this project set to $${Number(args['set-budget']).toFixed(2)}.`);
  }

  const budget = await getMonthlyBudgetUsd(siteId, 'dataforseo');
  const spent = await getMonthSpendUsd(siteId, 'dataforseo');
  console.log(`DataForSEO this month: ${money(spent)}${budget == null ? ' (no cap set)' : ` of $${budget.toFixed(2)}`}`);

  const services = await resolveMarketServiceTerms(siteId);
  console.log(`Service terms: ${services.terms.length ? services.terms.join(', ') : '(none known)'}  [source: ${services.source || 'none'}, confidence: ${services.confidence || 'n/a'}]`);
  if (!services.terms.length) {
    console.log('\nNothing to research: this project has no verified capabilities, profile topics or confirmed offerings.');
    console.log('Add them before paying for market discovery — seeding from a guess would research the wrong market.');
    return;
  }

  if (args.opportunities) {
    const { listCompetitorOpportunities, getLearnedMultipliers } = await import('../store/competitor-opportunities.js');
    const rows = await listCompetitorOpportunities(siteId, { status: args.status === true ? 'pending_review' : (args.status || 'pending_review') });
    console.log(`\nCompetitor-evidence opportunities in the queue: ${rows.length}`);
    for (const r of rows) {
      console.log(`  [${r.opportunity_type}] ${r.topic}  score ${r.opportunity_score ?? 'n/a'}  priority ${r.priority}  seen ${r.observation_count}x  lifecycle ${r.lifecycle_state}`);
      if (r.existing_page_match) console.log(`      improve: ${r.existing_page_match}`);
      if (r.reason) console.log(`      ${r.reason}`);
    }
    const learned = await getLearnedMultipliers(siteId);
    console.log(Object.keys(learned).length
      ? `\nVerified outcomes so far: ${JSON.stringify(learned)}`
      : '\nNo verified outcomes yet, so every kind of work is still weighted equally.');
    return;
  }

  if (args.cycle) {
    const { runCompetitorGrowthCycle } = await import('../agents/lib/competitor-growth-cycle.js');
    if (args.save) requireWriteAllowed(args);
    console.log(args.save ? '\nRunning the full cycle (this costs money)…' : '\nRunning the full cycle DRY: no footprint is bought and nothing is written.');
    const report = await runCompetitorGrowthCycle(site, { save: !!args.save });
    console.log(`\nCost this run: ${money(report.costUsd)}`);
    if (report.learning?.ran) {
      const { describeLearning } = await import('../agents/lib/competitor-outcome-learning.js');
      console.log(`Learning:     ${report.learning.lifecycleAdvanced.length} lifecycle change(s), ${report.learning.outcomesCounted.length} verified outcome(s) counted`);
      for (const c of report.learning.outcomesCounted) {
        console.log(`                ${c.topic} [${c.opportunityType}] -> ${c.outcome} (${c.verdict}, ${c.reason}, clicks ${c.clicksDelta >= 0 ? '+' : ''}${c.clicksDelta})`);
      }
      for (const s of report.learning.skipped) console.log(`                skipped ${s.topic}: ${s.reason}`);
      console.log(`                ${describeLearning(report.learning.multipliers)}`);
    } else {
      console.log(`Learning:     skipped (${report.learning?.reason})`);
    }
    console.log(`Discovery:    ${report.discovery.ran ? (report.discovery.ok ? `${report.discovery.business?.length || 0} business rival(s), ${report.discovery.stored || 0} stored` : `failed (${report.discovery.reason})`) : `skipped (${report.discovery.reason})`}`);
    console.log(`Footprints:   ${report.footprint.ran ? `${report.footprint.collected.length} collected, ${report.footprint.skipped.length} skipped${report.footprint.stoppedEarly ? ` — stopped early (${report.footprint.stoppedEarly})` : ''}` : `skipped (${report.footprint.reason})`}`);
    if (!report.opportunities.ran) {
      console.log(`Opportunities: skipped (${report.opportunities.reason})`);
      return;
    }
    console.log(`Opportunities: ${report.opportunities.built} built, ${report.opportunities.kept} kept, ${report.opportunities.written.inserted} new / ${report.opportunities.written.updated} updated`);
    console.log(`  by type:   ${JSON.stringify(report.opportunities.byType)}`);
    console.log(`  rejected:  ${JSON.stringify(report.opportunities.rejected)}`);
    console.log('\nBest opportunities:');
    for (const o of report.opportunities.top) {
      console.log(`  [${o.type}] ${o.keyword}  score ${o.score} (${o.confidence})`);
      if (o.existingPage) console.log(`      improve: ${o.existingPage}`);
      console.log(`      ${o.reason}`);
    }
    if (!args.save) console.log('\n(Dry run. Nothing bought, nothing written. Add --save to run it for real.)');
    console.log('\nOpportunities stop here, in the existing review queue. The weekly ship cycle, the recommendation');
    console.log('gates and a human merge still decide what actually reaches a site.');
    return;
  }

  if (args.seeds) {
    const { buildMarketSeeds } = await import('../agents/lib/competitor-market-discovery.js');
    const { LOCATION_NAMES, resolveSiteLocations } = await import('../agents/lib/site-locations.js');
    const names = resolveSiteLocations(site).map((l) => LOCATION_NAMES[l.locationCode]).filter(Boolean);
    const { targetPlaces } = await import('../agents/lib/local-seo.js');
    const seeds = buildMarketSeeds({ services: services.terms, locationNames: names, declaredPlaces: targetPlaces(site) });
    console.log(`\nWould ask about ${seeds.length} keyword(s) per market, in ${resolveSiteLocations(site).length} market(s):`);
    for (const s of seeds) console.log(`  ${s}`);
    return;
  }

  if (!args.run) {
    for (const kind of ['business', 'organic', 'keyword_specific']) {
      printGroup(`Stored ${kind.replace('_', ' ')} competitors`, await listCompetitorsByKind(siteId, kind));
    }
    const spend = await listSpendByEndpoint(siteId, { days: 30 });
    if (spend.length) {
      console.log('\nProvider spend, last 30 days');
      for (const r of spend) console.log(`  ${r.provider} ${r.endpoint} (${r.job}): ${r.calls} call(s), ${money(r.cost_usd)}`);
    }
    console.log('\n(Read-only. Add --run to make the paid discovery call, --save to store the result.)');
    return;
  }

  // getSearchPerformanceRange filters on `date BETWEEN $3 AND $4`, so both dates must be real: nulls would quietly
  // return nothing and the probe would silently fall back to the seeds. 90 days is the window the weekly competitor
  // job already uses for "this site's own real queries".
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  let ownTopQueries = [];
  try {
    const rows = await getSearchPerformanceRange(siteId, start, end, 'query', 25);
    ownTopQueries = (rows || []).map((r) => r.dim_value).filter(Boolean);
  } catch { /* a site with no Search Console data still has a market; seeds are then the probe */ }
  console.log(`Own top queries used as the relevance probe: ${ownTopQueries.length || 'none (seeds will be used)'}`);

  console.log('\nCalling DataForSEO Labs (this costs money)…');
  const result = await discoverMarketCompetitors(site, { services: services.terms, ownTopQueries });
  console.log(`Cost this run: ${money(result.costUsd)}`);
  for (const l of result.perLocation) {
    console.log(`  market ${l.locationCode}: ${l.ok ? `${l.found} domain(s)` : `no data (${l.reason})`}`);
  }
  if (result.skipped) {
    console.log(`\nNo market map produced: ${result.skipped}`);
    return;
  }

  printGroup('Business rivals', result.classified.business);
  printGroup('Also found, over the cap', result.classified.overflowBusiness);
  printGroup('Organic competitors (directories, publishers — topic evidence only)', result.classified.organic);
  printGroup('Keyword-specific domains (evidence about one keyword)', result.classified.keywordSpecific);
  printGroup('Excluded', result.classified.excluded);

  if (!args.save) {
    console.log('\n(Nothing stored. Add --save to write these classifications.)');
    return;
  }
  requireWriteAllowed(args);
  const runAt = new Date();
  let saved = 0;
  for (const group of [result.classified.business, result.classified.overflowBusiness, result.classified.organic, result.classified.keywordSpecific, result.classified.excluded]) {
    for (const c of group) {
      await upsertCompetitorClassification(siteId, c.domain, {
        kind: c.kind, relevanceScore: c.relevanceScore, classification: { ...c.evidence, reason: c.reason, confidence: c.confidence },
        excludedReason: c.excludedReason, runAt,
      });
      saved += 1;
    }
  }
  console.log(`\nStored ${saved} classification(s) for site ${siteId}.`);
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
