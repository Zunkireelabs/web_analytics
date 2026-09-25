import { getSearchPerformanceRange, getGa4BreakdownDelta } from '../store/read.js';
import { flagLowCtr } from './lib/ctr-anomaly.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { priorPeriod } from '../util/dates.js';
import { callLLM } from '../llm.js';
import { diagnoseDeviceCtrDeficit } from './lib/device-ctr-diagnosis.js';

export const meta = {
  id: 'device-intelligence',
  name: 'Device Intelligence Agent',
  description: 'Analyzes device-split search and traffic performance to surface low-CTR devices and usage shifts.',
  category: 'seo',
  version: 1,
  requiresCapabilities: ['gsc', 'ga4'],
};

export async function run({ siteId, start, end }) {
  const prior = priorPeriod(start, end);

  const [gscDevices, delta] = await Promise.all([
    getSearchPerformanceRange(siteId, start, end, 'device', 5),
    getGa4BreakdownDelta(siteId, 'device', { start, end }, prior, 5),
  ]);

  const devices = gscDevices.map((d) => ({
    device: d.dim_value,
    clicks: Number(d.clicks),
    impressions: Number(d.impressions),
    ctr: Number(d.ctr),
    avgPosition: d.avg_position != null ? Number(d.avg_position) : null,
  }));
  const lowCtrDevices = flagLowCtr(devices);

  // GA4's deviceCategory dimension returns lowercase ("desktop"); GSC's
  // device dimension (used above for `devices`/`lowCtrDevices`) returns
  // uppercase ("DESKTOP"). Normalized to uppercase so both sections refer
  // to the same device consistently.
  const growingDevices = delta.gainers.map((r) => ({ device: r.dim_value.toUpperCase(), recent: Number(r.recent), prior: Number(r.prior), delta: Number(r.delta) }));
  const decliningDevices = delta.droppers.map((r) => ({ device: r.dim_value.toUpperCase(), recent: Number(r.recent), prior: Number(r.prior), delta: Number(r.delta) }));

  // Each flagged low-CTR device is diagnosed against real evidence this
  // platform already collects elsewhere (ranking position, title length,
  // viewport meta — see device-ctr-diagnosis.js's own header for exactly
  // which existing capability each check reuses) before falling back to a
  // reportOnly. A device whose deficit clears a real, evidence-backed cause
  // gets one draftable finding per fix instead of a permanent dead end; one
  // that doesn't still surfaces read-only, but with the SPECIFIC evidence
  // this diagnosis actually gathered rather than a generic "look at it."
  const lowCtrCandidates = (await Promise.all(lowCtrDevices.map(async (d) => {
    const diagnosis = await diagnoseDeviceCtrDeficit(siteId, d, devices, { start, end });
    const magnitude = Math.abs(d.ctrDeviationPct);
    const baseEvidence = { device: d.device, ctr: d.ctr, ctrDeviationPct: d.ctrDeviationPct, clicks: d.clicks, impressions: d.impressions, diagnosis: diagnosis.cause };

    if (diagnosis.fixes.length) {
      return diagnosis.fixes.map((fix) => ({
        id: `device-intelligence:low-ctr:${d.device}:${fix.scope}:${fix.page || diagnosis.cause}`,
        evidence: { ...baseEvidence, ...diagnosis.evidence },
        whyItMatters: `${d.device} CTR is ${Math.abs(d.ctrDeviationPct)}% below this site's own cross-device average — ${diagnosis.explanation}`,
        magnitude,
        recommendedAction: fix.recommendedAction,
      }));
    }

    return [{
      id: `device-intelligence:low-ctr:${d.device}`,
      evidence: { ...baseEvidence, ...diagnosis.evidence },
      whyItMatters: `${d.device} CTR is ${Math.abs(d.ctrDeviationPct)}% below this site's own cross-device average.`,
      magnitude,
      // A whole device class under-performing this site's own average is a
      // confirmed defect, not a stat. diagnosis.explanation is set only for
      // 'position' (a real, evidence-backed cause with no single-file fix);
      // 'undiagnosed' means position/title-length/viewport were all
      // checked and came back clean, which is itself real information —
      // distinguishing "investigated, no fixable technical cause found"
      // from "never looked."
      reportOnly: {
        kind: 'device-ctr-deficit',
        label: `${d.device} click-through rate is below this site's average`,
        page: '',
        whyBlocked: diagnosis.explanation
          || `Checked ranking position${diagnosis.evidence.checkedTitleLength ? ', title length,' : ''}${diagnosis.evidence.checkedViewport ? ' and viewport configuration' : ''} for ${d.device.toLowerCase()} — none show a diagnosable technical cause. Search listings for this site still earn ${Math.abs(d.ctrDeviationPct)}% fewer clicks on ${d.device.toLowerCase()} than on this site's other devices, so it needs someone to look at real ${d.device.toLowerCase()} results directly.`,
      },
    }];
  }))).flat();

  const candidates = [
    ...lowCtrCandidates,
    ...decliningDevices.map((d) => ({
      id: `device-intelligence:declining:${d.device}`,
      evidence: { device: d.device, recent: d.recent, prior: d.prior, delta: d.delta },
      whyItMatters: `${d.device} sessions dropped from ${d.prior} to ${d.recent} (${start} to ${end} vs the prior period).`,
      magnitude: Math.abs(d.delta),
    })),
  ];
  const ranked = [...candidates].sort((a, b) => b.magnitude - a.magnitude);
  const priorities = priorityByRank(ranked);
  const priorityById = new Map(ranked.map((c, i) => [c.id, priorities[i]]));
  const findings = candidates.map((c) => {
    const priority = priorityById.get(c.id);
    return makeFinding({
      id: c.id, evidence: c.evidence, whyItMatters: c.whyItMatters, priority,
      recommendedAction: c.recommendedAction || null,
      // Declining-sessions candidates carry no reportOnly: a device losing
      // sessions is a trend to read, not a defect on the site. A low-CTR
      // candidate with a real recommendedAction (device-ctr-diagnosis.js
      // found an evidenced, fixable cause) carries no reportOnly either —
      // it's draftable, not blocked.
      reportOnly: c.reportOnly || null,
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: c.magnitude },
    });
  });

  const facts = {
    rangeStart: start, rangeEnd: end, priorStart: prior.start, priorEnd: prior.end,
    devices, lowCtrDevices, growingDevices, decliningDevices,
    findings,
  };

  const system = 'You are an SEO/UX strategist writing for a non-technical site owner. Given device-split search ' +
    'CTR/position (real GSC data), low-CTR devices (this site\'s own CTR relative to its own cross-device average ' +
    '— not an external benchmark), and growing/declining device usage (real GA4 session deltas, requested period ' +
    'vs an equal-length prior period), write 2-3 sentences naming the lowest-CTR device and the clearest usage ' +
    'shift, then suggest ONE concrete optimization action (e.g. mobile page speed, responsive layout, tap-target ' +
    'sizing) for the flagged device. Use ONLY the numbers given, never invent a benchmark. A lower average ' +
    'position is BETTER. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 300 })
    .catch((err) => { console.warn('[agents] device-intelligence narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
