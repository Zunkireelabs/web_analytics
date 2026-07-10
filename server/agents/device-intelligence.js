import { getSearchPerformanceRange, getGa4BreakdownDelta } from '../store/read.js';
import { flagLowCtr } from './lib/ctr-anomaly.js';
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

  const facts = {
    rangeStart: start, rangeEnd: end, priorStart: prior.start, priorEnd: prior.end,
    devices, lowCtrDevices, growingDevices, decliningDevices,
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
