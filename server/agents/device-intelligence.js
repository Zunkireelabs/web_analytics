import { getSearchPerformanceRange, getGa4BreakdownDelta } from '../store/read.js';
import { flagLowCtr } from './lib/ctr-anomaly.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { priorPeriod } from '../util/dates.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'device-intelligence',
  name: 'Device Intelligence Agent',
  description: 'Analyzes device-split search and traffic performance to surface low-CTR devices and usage shifts.',
  category: 'seo',
  version: 1,
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

  // No draft generator exists for device/UX fixes (mobile speed, responsive
  // layout, tap targets) — recommendedAction is honestly left null rather
  // than forced onto a content generator that doesn't fit. Findings still
  // carry real evidence/priority/impact; they just aren't draftable today.
  const candidates = [
    ...lowCtrDevices.map((d) => ({
      id: `device-intelligence:low-ctr:${d.device}`,
      evidence: { device: d.device, ctr: d.ctr, ctrDeviationPct: d.ctrDeviationPct, clicks: d.clicks, impressions: d.impressions },
      whyItMatters: `${d.device} CTR is ${Math.abs(d.ctrDeviationPct)}% below this site's own cross-device average.`,
      magnitude: Math.abs(d.ctrDeviationPct),
      // A whole device class under-performing this site's own average is a
      // confirmed defect, not a stat: the same listings earn materially
      // fewer clicks on one device than on the others. There is no single
      // file to change — the cause is spread across layout, speed and
      // how titles truncate on that device — so it surfaces read-only
      // instead of being dropped, and points at the device to investigate.
      reportOnly: {
        kind: 'device-ctr-deficit',
        label: `${d.device} click-through rate is below this site's average`,
        page: '',
        whyBlocked: `Search listings for this site earn ${Math.abs(d.ctrDeviationPct)}% fewer clicks on ${d.device.toLowerCase()} than on this site's other devices. The cause is usually how pages look, load or truncate on that device rather than any one file, so it needs someone to look at real ${d.device.toLowerCase()} results before anything is changed.`,
      },
    })),
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
      recommendedAction: null,
      // Declining-sessions candidates carry no reportOnly: a device losing
      // sessions is a trend to read, not a defect on the site.
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
