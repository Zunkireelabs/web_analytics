// Does every finding the Data Analyst (Python) makes arrive in the app's recommendation queue? PURE: rows in, report out.
//
// This is the check to pass BEFORE the Python draft step is switched off. While that step is on, Python can turn a finding into a
// draft by itself, so a finding that never became a recommendation would still get fixed. Switch it off and any such finding is
// silently lost. This report names every one, and the second thing it looks for is the quieter gap: a finding the app already had
// from its own detectors, which the analyst sync skips instead of recording as corroboration.
//
// The eligibility rule and the recommendation key are the APP'S OWN (passed in), not copies, so this cannot drift from what the
// sync really does.
//
// Per eligible finding the verdict is one of:
//   created-from-analyst    a recommendation lists this finding id. It arrived. (what we want)
//   same-issue-recorded     a recommendation for the same site, page and fix type exists and records the analyst as detector or
//                           supporter. Merged correctly.
//   same-issue-not-recorded a recommendation for the same site, page and fix type exists but never heard of this finding. The
//                           issue is covered, but the analyst's evidence and its supporting_agents entry were dropped.
//   closed                  only a closed recommendation matches (fixed, or dismissed): nothing to ship, nothing lost
//   missing                 no recommendation at all. With the draft step OFF this finding would be lost.
const ANALYST_AGENTS = ['analyst-insights', 'analyst-fusion', 'analyst-keyword-gap'];

export function buildParityReport({ site, insights, recommendations, eligibility, keyOf, now = new Date() }) {
  const byFinding = new Map();
  for (const r of recommendations) for (const fid of r.finding_ids || []) { if (!byFinding.has(fid)) byFinding.set(fid, []); byFinding.get(fid).push(r); }
  const byKey = new Map();
  for (const r of recommendations) {
    const k = `${r.recommendation_type}|${r.page}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }

  const out = { siteId: site.id, name: site.name, generatedAt: now.toISOString(), insights: insights.length, ineligible: 0, eligible: 0, verdicts: {}, findings: [] };
  const count = (v) => { out.verdicts[v] = (out.verdicts[v] || 0) + 1; };

  for (const insight of insights) {
    const action = eligibility(site, insight);
    if (!action) { out.ineligible++; continue; }
    out.eligible++;
    const pageKey = keyOf({ generatorId: action.generatorId, params: action.params });

    let verdict; let rec = null;
    const withFinding = byFinding.get(action.findingId) || [];
    const sameIssue = (byKey.get(`${action.generatorId}|${pageKey}`) || []);
    const openSame = sameIssue.find((r) => r.status === 'open');
    if (withFinding.length) { verdict = 'created-from-analyst'; rec = withFinding[0]; }
    else if (openSame) {
      rec = openSame;
      const recorded = (rec.detecting_agents || []).concat(rec.supporting_agents || []).some((a) => ANALYST_AGENTS.includes(a));
      verdict = recorded ? 'same-issue-recorded' : 'same-issue-not-recorded';
    } else if (sameIssue.length) { verdict = 'closed'; rec = sameIssue[0]; }
    else verdict = 'missing';

    count(verdict);
    out.findings.push({
      verdict, findingId: action.findingId, generatorId: action.generatorId, page: action.page, pageKey,
      recommendationId: rec ? Number(rec.id) : null, recommendationStatus: rec?.status ?? null,
      detectingAgents: rec?.detecting_agents ?? [], supportingAgents: rec?.supporting_agents ?? [],
    });
  }
  out.safeToSwitchOffDraftStep = !out.verdicts.missing && out.eligible > 0;
  out.reasonNotSafe = out.eligible === 0 ? 'no eligible analyst findings were seen, so there is nothing to compare: do not treat this as a pass'
    : out.verdicts.missing ? `${out.verdicts.missing} eligible finding(s) have no recommendation and would be lost` : null;
  return out;
}

export function formatParity(reports) {
  const L = [];
  for (const r of reports) {
    L.push(`project ${r.siteId} "${r.name}": ${r.insights} analyst insights, ${r.eligible} eligible, ${r.ineligible} not eligible for a fix`);
    for (const [v, n] of Object.entries(r.verdicts)) L.push(`  ${v.padEnd(26)} ${n}`);
    for (const f of r.findings.filter((x) => x.verdict === 'missing' || x.verdict === 'same-issue-not-recorded').slice(0, 15)) {
      L.push(`  ! ${f.verdict}: ${f.generatorId} on ${f.page}  (finding ${f.findingId})${f.recommendationId ? `  -> recommendation #${f.recommendationId} knows ${f.detectingAgents.concat(f.supportingAgents).join('+') || 'no analyst'}` : ''}`);
    }
    L.push(`  switching the Python draft step off would be ${r.safeToSwitchOffDraftStep ? 'SAFE for this project' : `NOT safe: ${r.reasonNotSafe}`}`);
  }
  return L.join('\n');
}
