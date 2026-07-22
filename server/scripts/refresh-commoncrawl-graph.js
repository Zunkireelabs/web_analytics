import 'dotenv/config';
import { createReadStream, createWriteStream, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import * as cheerio from 'cheerio';
import { pool } from '../db.js';
import { listSites } from '../store/read.js';
import { listCompetitorProfiles } from '../store/competitor-profiles.js';
import { resolveOwnDomain } from '../agents/lib/site-domain.js';
import * as ccStore from '../store/commoncrawl-backlinks.js';

// ETL: downloads one Common Crawl domain-level Web Graph release and stores
// every real referring-domain relationship pointing at a tracked site or
// competitor into commoncrawl_backlink_domains / commoncrawl_backlink_summary
// (migrations 044/045). This is the ONLY script that writes those tables —
// see server/providers/backlinks/provider.js for the read side, which no
// provider implements yet (that's a later phase). Does not touch
// authority_snapshots, DataForSEO, or any agent/dashboard code.
//
//   npm run refresh-commoncrawl-graph
//
// The domain-level edges file runs into the billions of rows and tens of
// gigabytes compressed, so this is meant to run as an occasional background/
// cron job, not inline in a request. See the stage comments below for the
// download -> resolve -> stream -> store pipeline.

const HYPERLINKGRAPH_BASE = 'https://data.commoncrawl.org/projects/hyperlinkgraph';
const BLOG_INDEX_URL = 'https://commoncrawl.org/blog';
const WORK_ROOT = path.join(os.tmpdir(), 'commoncrawl-graph');
const EDGES_LOG_INTERVAL = 25_000_000; // ~100-200 checkpoints over a multi-billion-row file
const INSERT_BATCH_SIZE = 5000;

function log(stage, message) {
  console.log(`[commoncrawl:${stage}] ${message}`);
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(n) / 10));
  return `${(n / 2 ** (i * 10)).toFixed(1)} ${units[i]}`;
}

// Common Crawl's reverse-domain-name notation: leading "www." stripped,
// remaining labels reversed — "www.sub.example.com" -> "com.example.sub".
function toReversedDomain(domain) {
  return domain.replace(/^www\./, '').split('.').reverse().join('.');
}
function fromReversedDomain(reversed) {
  return reversed.split('.').reverse().join('.');
}

// ---------------------------------------------------------------------------
// Stage: determine the latest available release (task 2) — no filename is
// ever hardcoded. Common Crawl doesn't publish a manifest for the domain-
// level graph (unlike the host-level graph's .paths.gz), so this scrapes the
// same "Host- and Domain-Level Web Graphs" announcement the project itself
// publishes for every release, always listed newest-first, and reads the
// release identifier out of that post.
// ---------------------------------------------------------------------------
async function resolveLatestRelease() {
  log('resolve', `Looking up the latest release from ${BLOG_INDEX_URL} ...`);
  const indexRes = await fetch(BLOG_INDEX_URL);
  if (!indexRes.ok) throw new Error(`Could not load ${BLOG_INDEX_URL}: HTTP ${indexRes.status}`);
  const $index = cheerio.load(await indexRes.text());

  let postHref = null;
  $index('a[href*="and-domain-level-web-graphs"]').each((_, el) => {
    if (postHref) return;
    postHref = $index(el).attr('href');
  });
  if (!postHref) throw new Error('Could not find a "Host- and Domain-Level Web Graphs" post on the Common Crawl blog.');
  const postUrl = new URL(postHref, BLOG_INDEX_URL).toString();

  log('resolve', `Latest web graph announcement: ${postUrl}`);
  const postRes = await fetch(postUrl);
  if (!postRes.ok) throw new Error(`Could not load ${postUrl}: HTTP ${postRes.status}`);
  const postHtml = await postRes.text();
  const $post = cheerio.load(postHtml);

  // Prefer a release id read from an actual data.commoncrawl.org link in the
  // post (most authoritative); fall back to scanning the post's text.
  let release = null;
  $post('a[href*="data.commoncrawl.org/projects/hyperlinkgraph/"]').each((_, el) => {
    if (release) return;
    const m = $post(el).attr('href')?.match(/hyperlinkgraph\/([\w-]+)\//);
    if (m) release = m[1];
  });
  if (!release) {
    const m = $post.text().match(/cc-main-[\w-]+/i);
    if (m) release = m[0];
  }
  if (!release) throw new Error(`Could not extract a release identifier from ${postUrl}.`);

  const urls = {
    verticesUrl: `${HYPERLINKGRAPH_BASE}/${release}/domain/${release}-domain-vertices.txt.gz`,
    edgesUrl: `${HYPERLINKGRAPH_BASE}/${release}/domain/${release}-domain-edges.txt.gz`,
    ranksUrl: `${HYPERLINKGRAPH_BASE}/${release}/domain/${release}-domain-ranks.txt.gz`,
  };

  const head = await fetch(urls.verticesUrl, { method: 'HEAD' });
  if (!head.ok) throw new Error(`Resolved release "${release}" but its vertices file is not reachable (HTTP ${head.status}) at ${urls.verticesUrl}`);

  log('resolve', `Latest release: ${release}`);
  return { release, ...urls };
}

// ---------------------------------------------------------------------------
// Stage: build the tracked domain list (task 3) — every site's own domain
// plus every domain any site currently tracks as a competitor. Reuses the
// exact store functions competitor storage and the Authority Agent already
// use (listSites/listCompetitorProfiles/resolveOwnDomain) rather than new
// queries, so this list matches what the rest of the app considers "ours".
// ---------------------------------------------------------------------------
async function getTrackedDomains() {
  const sites = await listSites();
  const until = new Date();
  const since = new Date(until.getTime() - 90 * 24 * 60 * 60 * 1000);
  const untilStr = until.toISOString().slice(0, 10);
  const sinceStr = since.toISOString().slice(0, 10);

  const domains = new Map(); // domain -> { kind: 'site'|'competitor', siteId }
  for (const site of sites) {
    const ownDomain = await resolveOwnDomain(site, site.id, sinceStr, untilStr);
    if (ownDomain && !domains.has(ownDomain)) domains.set(ownDomain, { kind: 'site', siteId: site.id });

    const competitors = await listCompetitorProfiles(site.id);
    for (const c of competitors) {
      if (c.domain && !domains.has(c.domain)) domains.set(c.domain, { kind: 'competitor', siteId: site.id });
    }
  }
  return domains;
}

// ---------------------------------------------------------------------------
// Stage: download the required graph files (task 4), resumable via HTTP
// Range requests against whatever partial file already exists on disk —
// re-running the script after a crash or interrupted network connection
// continues the download rather than restarting a many-gigabyte transfer
// from zero.
// ---------------------------------------------------------------------------
async function downloadResumable(url, destPath, label) {
  mkdirSync(path.dirname(destPath), { recursive: true });

  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`${label}: HEAD ${url} failed with HTTP ${head.status}`);
  const totalBytes = Number(head.headers.get('content-length') || 0);
  const existingBytes = existsSync(destPath) ? statSync(destPath).size : 0;

  if (totalBytes && existingBytes >= totalBytes) {
    log('download', `${label}: already fully downloaded (${formatBytes(existingBytes)}), skipping.`);
    return destPath;
  }

  const rangeRequested = existingBytes > 0;
  log('download', `${label}: ${rangeRequested ? `resuming from ${formatBytes(existingBytes)} of ` : 'starting, '}${formatBytes(totalBytes)} total.`);
  const res = await fetch(url, rangeRequested ? { headers: { Range: `bytes=${existingBytes}-` } } : {});
  if (!res.ok) throw new Error(`${label}: GET ${url} failed with HTTP ${res.status}`);

  // A server that ignores our Range header and returns the full file (200
  // instead of 206) would corrupt a resumed file if we blindly appended.
  const append = rangeRequested && res.status === 206;
  const out = createWriteStream(destPath, { flags: append ? 'a' : 'w' });

  let downloaded = append ? existingBytes : 0;
  let lastLogged = Date.now();
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    downloaded += chunk.length;
    if (Date.now() - lastLogged > 15_000) {
      lastLogged = Date.now();
      log('download', `${label}: ${formatBytes(downloaded)}${totalBytes ? ` / ${formatBytes(totalBytes)}` : ''}`);
    }
  });
  await pipeline(body, out);
  log('download', `${label}: complete (${formatBytes(downloaded)}).`);
  return destPath;
}

// Streams one gzip text file line by line — the file is never read into
// memory as a whole; readline + a decompression pipe hold at most a small
// internal buffer regardless of the file's total size (task 6).
async function forEachLine(gzipPath, onLine) {
  const input = createReadStream(gzipPath);
  const rl = createInterface({ input: input.pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line) onLine(line);
  }
}

// ---------------------------------------------------------------------------
// Stage: resolve domain IDs (task 5) — pass 1 over the vertices file, kept
// small in memory because only tracked domains (a handful) are looked up,
// not the graph's full ~100M+ vertex set.
// ---------------------------------------------------------------------------
async function resolveTargetIds(verticesPath, trackedDomains) {
  const reversedToDomain = new Map([...trackedDomains.keys()].map((d) => [toReversedDomain(d), d]));
  const targetIdToDomain = new Map(); // vertex id -> tracked domain
  let lines = 0;

  await forEachLine(verticesPath, (line) => {
    lines++;
    const parts = line.split(/\s+/);
    if (parts.length < 2) return;
    const [id, reversedDomain] = parts;
    const domain = reversedToDomain.get(reversedDomain);
    if (domain) targetIdToDomain.set(id, domain);
  });

  log('resolve-ids', `Scanned ${lines.toLocaleString()} vertices; matched ${targetIdToDomain.size} of ${trackedDomains.size} tracked domains.`);
  return targetIdToDomain;
}

// ---------------------------------------------------------------------------
// Stage: stream the edges file (task 6) exactly once — by far the largest
// file (billions of rows). For every edge whose target is one of ours, its
// source id and resolved target domain are appended to a small local
// "matches" file so this pass never has to hold matches in memory either.
// ---------------------------------------------------------------------------
async function streamMatchingEdges(edgesPath, targetIdToDomain, matchesPath, graphRelease) {
  const out = createWriteStream(matchesPath, { flags: 'w' });
  const neededFromIds = new Set();
  let edgesScanned = 0;
  let edgesMatched = 0;
  const start = Date.now();

  await forEachLine(edgesPath, (line) => {
    edgesScanned++;
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const [fromId, toId] = parts;
      const targetDomain = targetIdToDomain.get(toId);
      if (targetDomain) {
        edgesMatched++;
        neededFromIds.add(fromId);
        out.write(`${fromId}\t${targetDomain}\n`);
      }
    }
    if (edgesScanned % EDGES_LOG_INTERVAL === 0) {
      const elapsedMin = ((Date.now() - start) / 60_000).toFixed(1);
      log('edges', `${edgesScanned.toLocaleString()} edges scanned, ${edgesMatched.toLocaleString()} matched (${elapsedMin} min elapsed).`);
      // Checkpoint so a resumed run (and any operator watching the table)
      // can see progress even mid-stream.
      ccStore.updateGraphReleaseProgress(graphRelease, { edges_scanned: edgesScanned, edges_matched: edgesMatched }).catch(() => {});
    }
  });
  await new Promise((resolve, reject) => out.close((err) => (err ? reject(err) : resolve())));

  log('edges', `Done: ${edgesScanned.toLocaleString()} edges scanned, ${edgesMatched.toLocaleString()} matched.`);
  return { edgesScanned, edgesMatched, neededFromIds };
}

// Pass 2 over the vertices file — resolves only the source ids the edges
// pass actually needs, again bounded by result size rather than graph size.
async function resolveSourceIds(verticesPath, neededFromIds) {
  const fromIdToDomain = new Map();
  await forEachLine(verticesPath, (line) => {
    const parts = line.split(/\s+/);
    if (parts.length < 2) return;
    const [id, reversedDomain] = parts;
    if (neededFromIds.has(id)) fromIdToDomain.set(id, fromReversedDomain(reversedDomain));
  });
  log('resolve-ids', `Resolved ${fromIdToDomain.size} of ${neededFromIds.size} referring-domain ids to domain names.`);
  return fromIdToDomain;
}

// ---------------------------------------------------------------------------
// Stage: store matching referring-domain relationships (task 7) — reads the
// matches file once, resolves each source id to a domain name, and batch-
// inserts. Duplicates (a resumed re-run re-processing the same edges) are
// skipped safely by the unique constraint + ON CONFLICT DO NOTHING in
// server/store/commoncrawl-backlinks.js.
// ---------------------------------------------------------------------------
async function storeBacklinkDomains(matchesPath, fromIdToDomain, graphRelease) {
  let batch = [];
  let stored = 0;
  let skippedUnresolved = 0;

  const input = createReadStream(matchesPath, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const [fromId, targetDomain] = line.split('\t');
    const sourceDomain = fromIdToDomain.get(fromId);
    if (!sourceDomain) { skippedUnresolved++; continue; }
    batch.push({ targetDomain, sourceDomain, graphRelease });
    if (batch.length >= INSERT_BATCH_SIZE) {
      await ccStore.insertBacklinkDomainsBatch(batch);
      stored += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await ccStore.insertBacklinkDomainsBatch(batch);
    stored += batch.length;
  }

  log('store', `Stored ${stored.toLocaleString()} referring-domain rows (${skippedUnresolved.toLocaleString()} edges had an unresolvable source id, skipped).`);
  return stored;
}

// ---------------------------------------------------------------------------
// Stage: generate summary rows (task 8) — one row per tracked domain per
// release, real referring-domain counts straight from what was just stored
// plus this release's graph rank for that domain.
// ---------------------------------------------------------------------------
async function resolveTargetRanks(ranksPath, targetIdToDomain) {
  const ranksByDomain = new Map();
  let malformedWarned = false;

  await forEachLine(ranksPath, (line) => {
    const parts = line.split(/\s+/);
    const id = parts[0];
    const domain = targetIdToDomain.get(id);
    if (!domain) return;
    // Documented as "harmonic centrality and pagerank" without a published
    // column spec; the common cc-webgraph/LAW convention is
    // <id> <harmonicc_pos> <harmonicc_val> <pr_pos> <pr_val>. Take the
    // pagerank rank position when present; degrade to the first numeric
    // column rather than throwing if the real file doesn't match.
    let rank = null;
    if (parts.length >= 5) rank = Number(parts[3]);
    else if (parts.length >= 2) rank = Number(parts[1]);
    if (!Number.isFinite(rank)) {
      if (!malformedWarned) { log('ranks', `Unexpected ranks file column layout (${parts.length} columns) — graph_rank may be inaccurate.`); malformedWarned = true; }
      rank = null;
    }
    ranksByDomain.set(domain, rank);
  });

  return ranksByDomain;
}

async function generateSummaries(targetIdToDomain, ranksByDomain, graphRelease) {
  for (const domain of targetIdToDomain.values()) {
    const referringDomains = await ccStore.countReferringDomains(domain, graphRelease);
    await ccStore.upsertBacklinkSummary({
      domain,
      referringDomains,
      graphRank: ranksByDomain.get(domain) ?? null,
      graphRelease,
    });
  }
  log('summary', `Wrote summary rows for ${targetIdToDomain.size} tracked domain(s).`);
}

async function main() {
  let graphRelease;
  let workDir;
  try {
    const trackedDomains = await getTrackedDomains();
    if (!trackedDomains.size) {
      log('main', 'No tracked domains resolved yet (no site has a known domain and no competitors are tracked) — nothing to do.');
      return;
    }
    log('main', `Tracked domains: ${[...trackedDomains.keys()].join(', ')}`);

    const resumable = await ccStore.getIncompleteGraphRelease();
    let release;
    if (resumable) {
      log('main', `Resuming incomplete release ${resumable.graph_release} (status=${resumable.status}).`);
      release = {
        release: resumable.graph_release,
        verticesUrl: resumable.vertices_url,
        edgesUrl: resumable.edges_url,
        ranksUrl: resumable.ranks_url,
      };
    } else {
      release = await resolveLatestRelease();
      const existing = await ccStore.getGraphRelease(release.release);
      if (existing?.status === 'completed') {
        log('main', `Release ${release.release} is already fully processed. Nothing to do.`);
        return;
      }
    }
    graphRelease = release.release;
    workDir = path.join(WORK_ROOT, graphRelease);
    mkdirSync(workDir, { recursive: true });

    await ccStore.getOrCreateGraphRelease(graphRelease, release);
    await ccStore.updateGraphReleaseProgress(graphRelease, { tracked_domains_count: trackedDomains.size });

    const verticesPath = path.join(workDir, 'vertices.txt.gz');
    const edgesPath = path.join(workDir, 'edges.txt.gz');
    const ranksPath = path.join(workDir, 'ranks.txt.gz');
    const matchesPath = path.join(workDir, 'matches.tsv');

    await downloadResumable(release.verticesUrl, verticesPath, 'vertices');
    await downloadResumable(release.edgesUrl, edgesPath, 'edges');
    await downloadResumable(release.ranksUrl, ranksPath, 'ranks');

    const targetIdToDomain = await resolveTargetIds(verticesPath, trackedDomains);
    await ccStore.updateGraphReleaseProgress(graphRelease, { vertices_matched: targetIdToDomain.size });
    if (!targetIdToDomain.size) {
      log('main', 'None of the tracked domains appear in this release\'s vertex set — nothing to store.');
      await ccStore.completeGraphRelease(graphRelease, { source_domains_resolved: 0 });
      return;
    }

    const { edgesScanned, edgesMatched, neededFromIds } = await streamMatchingEdges(edgesPath, targetIdToDomain, matchesPath, graphRelease);
    const fromIdToDomain = await resolveSourceIds(verticesPath, neededFromIds);
    await storeBacklinkDomains(matchesPath, fromIdToDomain, graphRelease);

    const ranksByDomain = await resolveTargetRanks(ranksPath, targetIdToDomain);
    await generateSummaries(targetIdToDomain, ranksByDomain, graphRelease);

    await ccStore.completeGraphRelease(graphRelease, {
      edges_scanned: edgesScanned,
      edges_matched: edgesMatched,
      source_domains_resolved: fromIdToDomain.size,
    });
    log('main', `Release ${graphRelease} complete.`);

    rmSync(workDir, { recursive: true, force: true });
  } catch (err) {
    log('main', `Failed: ${err.message}`);
    if (graphRelease) await ccStore.failGraphRelease(graphRelease, err.message).catch(() => {});
    throw err;
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end().finally(() => process.exit(1));
  });
