import { canonicalPageKey, bareHost } from './canonical.js';

// Builds the duplicate report for a proposed canonical page key. PURE: it takes rows and returns a report, so it can be tested
// with no database and run read-only against any copy of the data.
//
// For each open recommendation it computes the canonical key at four levels, each adding one decision on top of the last:
//   safe              fragment, tracking parameters, query order, host case, and www ONLY for a project's own domain
//   + trailing-slash  /a/ and /a as one page      (a person decides: can differ on some frameworks)
//   + scheme          http and https as one page  (a person decides)
//   + www-any         www stripped with no domain evidence (shown so a person can see what the evidence rule is holding back)
// A group of 2 or more open rows with the same site, fix type and canonical key is a collision at the FIRST level where it appears,
// because that level says what decision it needs. Rows are never altered; this only reports.
//
// The same site, page and fix type is the identity the database enforces for open recommendations (recommendations_dedup_key),
// so two rows that collide here are exactly two rows the proposed key would merge into one.

const LEVELS = [
  { name: 'safe', options: (c) => ({ canonicalHost: c }), decision: 'none: these rules cannot change which page it is' },
  { name: 'trailing-slash', options: (c) => ({ canonicalHost: c, trailingSlash: true }), decision: 'decide: is /a/ the same page as /a on this site?' },
  { name: 'scheme', options: (c) => ({ canonicalHost: c, trailingSlash: true, scheme: true }), decision: 'decide: is http:// the same page as https://?' },
  { name: 'www-unverified', options: () => ({ canonicalHost: '*', trailingSlash: true, scheme: true }), decision: 'verify: is www an alias of the bare host? (no domain evidence)' },
];

// "*" means "treat any www as the alias", used only for the last, unverified level.
function keyAt(level, row, siteHost) {
  const opts = level.options(siteHost);
  if (opts.canonicalHost === '*') {
    const forced = canonicalPageKey(row.page, { ...opts, canonicalHost: hostOf(row.page) });
    return forced;
  }
  return canonicalPageKey(row.page, opts);
}

function hostOf(pageKey) {
  const m = /^(?:redirect::)?https?:\/\/([^/?#:]+)/i.exec(String(pageKey || ''));
  return m ? m[1] : null;
}

export function buildDuplicateReport({ recommendations, sites = [], draftCounts = new Map(), sampleLimit = 8 }) {
  const siteById = new Map(sites.map((s) => [Number(s.id), s]));
  const open = recommendations.filter((r) => (r.status ?? 'open') === 'open');

  const report = {
    totals: { rows: recommendations.length, open: open.length, urlKeyed: 0, notUrlKeyed: 0 },
    wouldRewrite: { safe: 0, withSlash: 0, withScheme: 0 },
    collisions: [],
    rewritesWithoutCollision: [],
    notUrlKeyedSample: [],
  };

  const groups = new Map(); // level|site|type|key -> rows
  const rowInfo = (r, canonical, siteHost) => ({
    id: Number(r.id), siteId: Number(r.site_id), type: r.recommendation_type,
    original: r.page, normalized: canonical.key, changes: canonical.changes, status: r.status ?? 'open',
    detectingAgents: r.detecting_agents ?? [], supportingAgents: r.supporting_agents ?? [],
    findingIds: r.finding_ids ?? [], draftsAttached: draftCounts.get(Number(r.id)) ?? 0,
    firstDetectedAt: r.first_detected_at ?? null, projectDomain: siteHost,
  });

  const seen = new Set();
  for (const r of open) {
    const site = siteById.get(Number(r.site_id));
    const siteHost = bareHost(site?.website_domain);
    const safe = canonicalPageKey(r.page, { canonicalHost: siteHost });
    if (!safe.url) {
      report.totals.notUrlKeyed++;
      if (report.notUrlKeyedSample.length < sampleLimit) report.notUrlKeyedSample.push({ id: Number(r.id), type: r.recommendation_type, page: r.page });
      continue;
    }
    report.totals.urlKeyed++;
    if (safe.key !== r.page) report.wouldRewrite.safe++;

    for (const level of LEVELS) {
      const c = keyAt(level, r, siteHost);
      if (level.name === 'trailing-slash' && c.key !== r.page) report.wouldRewrite.withSlash++;
      if (level.name === 'scheme' && c.key !== r.page) report.wouldRewrite.withScheme++;
      const gk = `${level.name}|${r.site_id}|${r.recommendation_type}|${c.key}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(rowInfo(r, c, siteHost));
    }
  }

  // a collision belongs to the first level where it appears; a later level only reports groups that are NEW at that level
  const reportedMemberSets = new Set();
  for (const level of LEVELS) {
    for (const [gk, members] of groups) {
      if (!gk.startsWith(`${level.name}|`) || members.length < 2) continue;
      const ids = members.map((m) => m.id).sort((a, b) => a - b).join(',');
      if (reportedMemberSets.has(ids)) continue;
      reportedMemberSets.add(ids);
      const rulesUsed = [...new Set(members.flatMap((m) => m.changes))].sort();
      report.collisions.push({
        level: level.name, decisionNeeded: level.decision, siteId: members[0].siteId, type: members[0].type,
        normalizedKey: members[0].normalized, rulesThatMergeThem: rulesUsed,
        // the row a merge would keep (the oldest) and the ones it would fold in, so the plan can be read off the report
        keep: [...members].sort((a, b) => a.id - b.id)[0].id, foldIn: [...members].sort((a, b) => a.id - b.id).slice(1).map((m) => m.id),
        rows: [...members].sort((a, b) => a.id - b.id),
      });
    }
  }

  const collided = new Set(report.collisions.flatMap((c) => c.rows.map((r) => r.id)));
  for (const r of open) {
    const site = siteById.get(Number(r.site_id));
    const safe = canonicalPageKey(r.page, { canonicalHost: bareHost(site?.website_domain) });
    if (safe.url && safe.key !== r.page && !collided.has(Number(r.id)) && report.rewritesWithoutCollision.length < sampleLimit * 4) {
      report.rewritesWithoutCollision.push({ id: Number(r.id), siteId: Number(r.site_id), type: r.recommendation_type, original: r.page, normalized: safe.key, changes: safe.changes });
    }
  }
  report.totals.collisionGroups = report.collisions.length;
  report.totals.rowsInCollisions = collided.size;
  report.totals.draftsOnFoldedRows = report.collisions.reduce((n, c) => n + c.rows.filter((r) => r.id !== c.keep).reduce((m, r) => m + r.draftsAttached, 0), 0);
  return report;
}

export function formatReport(report) {
  const L = [];
  const t = report.totals;
  L.push(`Open recommendations examined: ${t.open} (of ${t.rows}); URL-keyed: ${t.urlKeyed}; other keys left alone: ${t.notUrlKeyed}`);
  L.push(`Rows whose stored page would change: ${report.wouldRewrite.safe} under the safe rules, ${report.wouldRewrite.withSlash} with trailing-slash, ${report.wouldRewrite.withScheme} with scheme too`);
  L.push(`Collision groups: ${t.collisionGroups} (${t.rowsInCollisions} rows). Drafts attached to rows that a merge would fold in: ${t.draftsOnFoldedRows}`);
  for (const c of report.collisions) {
    L.push('');
    L.push(`COLLISION [${c.level}] site ${c.siteId}, fix type "${c.type}", ${c.decisionNeeded}`);
    L.push(`  merged by rules: ${c.rulesThatMergeThem.join(', ') || '(identical after parsing)'}; would keep #${c.keep}, fold in ${c.foldIn.map((i) => `#${i}`).join(', ')}`);
    L.push(`  canonical: ${c.normalizedKey}`);
    for (const r of c.rows) {
      L.push(`  #${r.id} [${r.status}] ${r.original}   detected by ${r.detectingAgents.join('+') || '?'}${r.supportingAgents.length ? `, supported by ${r.supportingAgents.join('+')}` : ''}; findings=${r.findingIds.length}; drafts=${r.draftsAttached}`);
    }
  }
  if (report.rewritesWithoutCollision.length) {
    L.push('');
    L.push('Would be rewritten but collide with nothing (sample):');
    for (const r of report.rewritesWithoutCollision.slice(0, 12)) L.push(`  #${r.id} site ${r.siteId} ${r.type}: ${r.original}  ->  ${r.normalized}  [${r.changes.join(', ')}]`);
  }
  return L.join('\n');
}
