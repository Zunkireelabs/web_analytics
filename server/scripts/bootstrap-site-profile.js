#!/usr/bin/env node
// Populates site_profiles (industry / main_topics / site_type) from a site's
// own REAL evidence — its actual mapped page paths and, when available, its
// real top GSC search queries. Never invents an industry.
//
// WHY THIS EXISTS
//
// saveSiteProfile (store/data-analyst.js) has existed since site_profiles was
// added, but nothing in this codebase ever called it — the "industry
// clustering pipeline" getSiteProfile's own doc comment describes ("Empty
// until the clustering pipeline has run at least once for this site") does
// not exist. Every generator that reads a site's profile
// (imageQueryContextFor for Pexels sourcing, content-gap.js for entity
// suggestions) has therefore always seen `null` for any site that was never
// hand-seeded — which is every site except whichever one happened to get a
// manual DB write. Concretely: blog-outline.js's featured-image search falls
// back to buildImageQueries' hardcoded 'artificial intelligence technology'
// default for a site with no profile, which is exactly what this file's own
// header comment already documents as the wrong-industry-photo bug on a
// non-AI tenant.
//
// This script is the missing write path: real evidence in, one LLM call
// grounded ONLY in that evidence, saveSiteProfile out. Safe to re-run — it
// always overwrites with a fresh derivation, same as force-design-profile
// -rescan.js's relationship to the design profile.
//
//   node server/scripts/bootstrap-site-profile.js --site 8862
//   node server/scripts/bootstrap-site-profile.js --site 8862 --show   (dry run, no write)

import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { getSearchPerformanceRange } from '../store/read.js';
import { saveSiteProfile } from '../store/data-analyst.js';
import { callLLMForJson } from '../llm.js';

const SITE_TYPES = ['service', 'product', 'ecommerce', 'education'];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

// Real page paths only — excludes the noise every real site accumulates
// (test/preview/admin/thank-you/duplicate -old/-v2 variants) that would
// otherwise dilute the LLM's read of what the business actually does.
const NOISE_PATTERN = /test|preview|thank-you|admin|coming-soon|-old\b|-v2\b|affiliate-dashboard/i;

function realPagePaths(site) {
  const pages = site.url_file_map?.pages || {};
  return Object.keys(pages).filter((p) => !NOISE_PATTERN.test(p)).slice(0, 60);
}

async function realTopQueries(siteId) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  try {
    const rows = await getSearchPerformanceRange(siteId, start, end, 'query', 30);
    return rows.map((r) => r.dim_value).filter(Boolean);
  } catch {
    // gsc_breakdown may have no rows yet for a freshly connected site —
    // page paths alone are still real evidence, just thinner.
    return [];
  }
}

export async function bootstrapSiteProfile(siteId) {
  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site ${siteId}`);

  const pagePaths = realPagePaths(site);
  const topQueries = await realTopQueries(siteId);
  if (!pagePaths.length && !topQueries.length) {
    throw Object.assign(
      new Error(`Site ${siteId} has no mapped pages and no real search-query history — nothing real to derive an industry from yet.`),
      { refusal: true },
    );
  }

  const system = 'You are classifying what business a website belongs to, using ONLY the real evidence given below — ' +
    'never invent or assume anything not directly supported by it. Respond with ONLY a JSON object: ' +
    `{"industry": "a few words", "mainTopics": ["...", "..."] (3-5 real topics/services this evidence actually shows), ` +
    `"siteType": one of ${JSON.stringify(SITE_TYPES)}}`;
  const user = [
    pagePaths.length ? `Real page paths on this site:\n${pagePaths.join('\n')}` : null,
    topQueries.length ? `Real top search queries this site actually ranks for:\n${topQueries.join('\n')}` : null,
  ].filter(Boolean).join('\n\n');

  const parsed = await callLLMForJson(system, user, { maxTokens: 300, generatorId: 'bootstrap-site-profile', siteId });
  const siteType = SITE_TYPES.includes(parsed.siteType) ? parsed.siteType : 'service';
  const profile = {
    industry: String(parsed.industry || '').slice(0, 200),
    mainTopics: (Array.isArray(parsed.mainTopics) ? parsed.mainTopics : []).slice(0, 5).map((t) => String(t).slice(0, 100)),
    siteType,
  };
  if (!profile.industry) {
    throw Object.assign(new Error(`Model returned no industry for site ${siteId} from real evidence — refusing to save an empty profile.`), { refusal: true });
  }
  return { profile, evidence: { pagePaths: pagePaths.length, topQueries: topQueries.length } };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const siteId = Number(arg('site'));
  const show = process.argv.includes('--show');
  if (!siteId) {
    console.error('Usage: bootstrap-site-profile.js --site <id> [--show]');
    process.exit(1);
  }
  const { profile, evidence } = await bootstrapSiteProfile(siteId);
  console.log(`site ${siteId}: derived from ${evidence.pagePaths} real page path(s), ${evidence.topQueries} real query(ies)`);
  console.log(JSON.stringify(profile, null, 2));
  if (!show) {
    await saveSiteProfile(siteId, profile);
    console.log('saved.');
  } else {
    console.log('(--show: not saved)');
  }
  process.exit(0);
}
