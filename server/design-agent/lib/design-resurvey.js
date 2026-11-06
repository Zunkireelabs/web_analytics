// DESIGN RESURVEY (Phase 2 A + B) — regroup a site's pages by their REAL layout and propose
// changes to the saved group map. Never applies anything: every change is a proposal for review.
//
// Root causes fixed here, versus the first layout survey (live-analysis/layout-survey.js):
//   * it compared FULL class sets (content classes included) with plain Jaccard, so pages that share a
//     design system but not a template were lumped together (Zunkiree's /blog with /schedule-a-call);
//     this uses the layout fingerprint + the combined similarity/containment/structure rule;
//   * it only saw the pages already in url_file_map.pages, so whole sets (Zunkiree's English blog
//     posts) were missing; this also reads the live sitemap;
//   * one sample stood for a whole group however much it varied; this picks SEVERAL representatives
//     by measured variation, and never a thin one.
import { computeLayoutFingerprint, compareLayouts, pathKey } from './live-design-validation.js';
import { NOT_A_LAYOUT } from '../live-analysis/layout-survey.js';

export const MAX_SAMPLES_PER_GROUP = 3;
const VARIATION_FLOOR = 0.92; // a page this similar to an existing sample adds nothing as another sample

// ── page discovery ─────────────────────────────────────────────────────────

export function urlsFromSitemapXml(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

export async function discoverSitemapUrls(origin, fetchText, { maxSitemaps = 20, maxUrls = 2000 } = {}) {
  const seen = new Set(); const pages = new Set();
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  while (queue.length && seen.size < maxSitemaps && pages.size < maxUrls) {
    const sm = queue.shift();
    if (seen.has(sm)) continue; seen.add(sm);
    let xml; try { xml = await fetchText(sm); } catch { continue; }
    for (const u of urlsFromSitemapXml(xml)) {
      if (/\.xml(\?|$)/i.test(u)) queue.push(u);
      else { try { if (new URL(u).origin === origin) pages.add(u); } catch { /* ignore */ } }
    }
  }
  return [...pages];
}

// ── clustering on the combined rule ────────────────────────────────────────

// Greedy: each page joins the group whose CURRENT representatives it matches best (all three signals);
// otherwise it starts a group. Pages are visited richest-first so groups are seeded by full examples.
export function clusterByLayout(pages) {
  const ordered = [...pages].sort((a, b) => b.fp.count - a.fp.count || a.path.localeCompare(b.path));
  const groups = [];
  for (const p of ordered) {
    let best = null;
    for (const g of groups) {
      const cmp = compareLayouts(p.fp, g.seed.fp);
      if (cmp.verdict === 'match' && (!best || cmp.similarity > best.cmp.similarity)) best = { g, cmp };
    }
    if (best) best.g.members.push(p); else groups.push({ seed: p, members: [p] });
  }
  return groups;
}

// Representatives that cover the group's real variation: the most central page first, then repeatedly
// the page LEAST like any chosen sample, while it is still meaningfully different. Thin pages (few
// structural classes relative to the group) are never chosen.
export function pickSamples(members, { max = MAX_SAMPLES_PER_GROUP } = {}) {
  if (members.length === 1) return [members[0]];
  const counts = members.map((m) => m.fp.count).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  const eligible = members.filter((m) => m.fp.count >= Math.max(4, Math.floor(median * 0.6)));
  const pool = eligible.length ? eligible : members;
  const score = (m) => pool.reduce((acc, o) => acc + (o === m ? 0 : compareLayouts(m.fp, o.fp).similarity), 0);
  const chosen = [pool.reduce((best, m) => (score(m) > score(best) ? m : best), pool[0])];
  while (chosen.length < max) {
    let far = null; let farSim = 1;
    for (const m of pool) {
      if (chosen.includes(m)) continue;
      const sim = Math.max(...chosen.map((c) => compareLayouts(m.fp, c.fp).similarity));
      if (sim < farSim) { farSim = sim; far = m; }
    }
    if (!far || farSim >= VARIATION_FLOOR) break;
    chosen.push(far);
  }
  return chosen;
}

// What a reviewer needs to judge a sample change: what each side has that the other does not.
export function structuralDiff(currentFp, proposedFp) {
  const A = new Set(currentFp?.classes || []); const B = new Set(proposedFp?.classes || []);
  return {
    onlyInCurrent: [...A].filter((c) => !B.has(c)).slice(0, 40),
    onlyInProposed: [...B].filter((c) => !A.has(c)).slice(0, 40),
    signals: currentFp && proposedFp ? compareLayouts(proposedFp, currentFp) : null,
  };
}

// ── proposals against the saved map ────────────────────────────────────────

/**
 * @param {{groups:Array}} layoutGroups  the saved map (never modified)
 * @param {Array<{path, fp}>} pages       every surveyed page with its live fingerprint
 * @returns {{ clusters, proposals }}      proposals: split-group | join | new-group | add-sample | replace-sample
 */
export function proposeFromSurvey(layoutGroups, pages) {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const clusters = clusterByLayout(pages).map((c, i) => ({ id: `c${i + 1}`, members: c.members, samples: pickSamples(c.members) }));
  const clusterOf = new Map();
  for (const c of clusters) for (const m of c.members) clusterOf.set(m.path, c);
  const proposals = [];
  const assigned = new Set();

  for (const g of layoutGroups?.groups || []) {
    const members = g.members.map(pathKey).filter((p) => byPath.has(p));
    for (const m of g.members) assigned.add(pathKey(m));
    if (!members.length) continue;
    const parts = new Map();
    for (const m of members) { const c = clusterOf.get(m); if (!parts.has(c)) parts.set(c, []); parts.get(c).push(m); }
    const sampleFp = byPath.get(pathKey(g.sample))?.fp || null;

    if (parts.size >= 2) {
      // One saved group, several real layouts: split it, each part with its own representatives.
      const partList = [...parts.entries()].map(([c, ms]) => {
        const local = ms.map((p) => byPath.get(p));
        const samples = pickSamples(local);
        return { members: ms, sample: samples[0].path, samples: samples.slice(1).map((s) => s.path), cluster: c.id };
      });
      proposals.push({
        kind: 'split-group', groupId: g.id,
        reason: `${g.id} holds ${parts.size} different layouts (${partList.map((p) => `${p.members.length} like ${p.sample}`).join('; ')})`,
        payload: { parts: partList, currentSample: g.sample },
      });
      continue;
    }

    // Homogeneous: is the saved sample a good representative, and is one sample enough?
    const local = members.map((p) => byPath.get(p));
    const samples = pickSamples(local);
    const proposed = samples[0];
    const current = byPath.get(pathKey(g.sample));
    if (!current) {
      proposals.push({ kind: 'replace-sample', groupId: g.id, pagePath: proposed.path, reason: `the saved sample ${g.sample} is no longer reachable`, payload: { diff: structuralDiff(null, proposed.fp), currentSample: g.sample } });
    } else if (current.path !== proposed.path && current.fp.count < proposed.fp.count * 0.6) {
      proposals.push({ kind: 'replace-sample', groupId: g.id, pagePath: proposed.path, reason: `the saved sample ${g.sample} is thin (${current.fp.count} layout classes vs ${proposed.fp.count})`, payload: { diff: structuralDiff(current.fp, proposed.fp), currentSample: g.sample } });
    }
    const have = new Set([pathKey(g.sample), ...(g.samples || []).map(pathKey)]);
    for (const s of samples.slice(1)) {
      if (have.has(s.path)) continue;
      const vs = sampleFp ? compareLayouts(s.fp, sampleFp) : null;
      proposals.push({ kind: 'add-sample', groupId: g.id, pagePath: s.path, reason: `${g.id}'s pages vary; ${s.path} shows a variant the current sample does not (similarity ${vs?.similarity ?? '?'})`, payload: { diff: structuralDiff(sampleFp, s.fp) } });
    }
  }

  // Pages in no saved group: join the saved group whose sample they match, else a new group per cluster.
  const unassigned = pages.filter((p) => !assigned.has(p.path));
  const newClusters = new Map();
  const joins = new Map(); // groupId -> pages: one reviewable proposal per target group, not one per page
  for (const p of unassigned) {
    let best = null;
    for (const g of layoutGroups?.groups || []) {
      const sfp = byPath.get(pathKey(g.sample))?.fp;
      if (!sfp) continue;
      const cmp = compareLayouts(p.fp, sfp);
      if (cmp.verdict === 'match' && (!best || cmp.similarity > best.cmp.similarity)) best = { g, cmp };
    }
    if (best) { if (!joins.has(best.g.id)) joins.set(best.g.id, []); joins.get(best.g.id).push({ path: p.path, signals: best.cmp }); }
    else { const c = clusterOf.get(p.path); if (!newClusters.has(c)) newClusters.set(c, []); newClusters.get(c).push(p); }
  }
  for (const [groupId, list] of joins) {
    const worst = list.reduce((w, x) => (x.signals.similarity < w.signals.similarity ? x : w), list[0]);
    proposals.push({
      kind: 'join', groupId, pagePath: list[0].path,
      reason: `${list.length} page(s) not in any group match ${groupId}'s sample (weakest match ${worst.path}: ${worst.signals.similarity}/${worst.signals.containment.min}/${worst.signals.skeleton})`,
      payload: { members: list.map((x) => x.path), weakest: { path: worst.path, signals: worst.signals } },
    });
  }
  for (const [c, ms] of newClusters) {
    const samples = pickSamples(ms);
    proposals.push({ kind: 'new-group', pagePath: samples[0].path, reason: `${ms.length} page(s) with a layout no saved group has (cluster ${c.id})`, payload: { members: ms.map((m) => m.path), samples: samples.map((s) => s.path) } });
  }
  return { clusters, proposals };
}

export async function surveyPages(urls, fetchHtml, { concurrency = 6 } = {}) {
  const list = [...new Set(urls)].filter((u) => { try { return !NOT_A_LAYOUT.test(new URL(u).pathname); } catch { return false; } });
  const out = []; const failed = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (next < list.length) {
      const u = list[next++];
      try { const fp = computeLayoutFingerprint(await fetchHtml(u)); if (fp.count >= 4) out.push({ url: u, path: pathKey(u), fp }); else failed.push({ url: u, reason: 'no structure in served HTML' }); } catch (err) { failed.push({ url: u, reason: err.message }); }
    }
  }));
  return { pages: out, failed };
}
