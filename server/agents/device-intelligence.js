import { getSearchPerformanceRange, getGa4BreakdownRange, getBreakdownDataDates } from '../store/read.js';
import { flagLowCtrSignificant } from './lib/ctr-anomaly.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { VERDICT, makeVerification } from './lib/verdict.js';
import { assessWindows, clipWindowToLag, computeShareShifts, splitShareShifts, GSC_LAG_DAYS } from './lib/window-coverage.js';
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

// The CTR gap already cleared a two-proportion z-test and a position-
// comparability check in flagLowCtrSignificant — that is what makes it
// assertable, so say so on the finding.
const ctrVerification = (d) => makeVerification(VERDICT.CONFIRMED, 'two-proportion-z-test',
  `CTR ${d.ctrDeviationPct}% vs the other devices' impression-weighted CTR, z=${d.ctrZ}, comparable ranking position`);

export async function run({ siteId, start, end }) {
  const prior = priorPeriod(start, end);

  // GSC's last ~3 days are not final yet, so the CTR comparison reads a
  // window clipped to the lag rather than one ending 'today'.
  const gscWindow = clipWindowToLag({ start, end }, GSC_LAG_DAYS) || { start, end };
  const gscDevices = await getSearchPerformanceRange(siteId, gscWindow.start, gscWindow.end, 'device', 5);

  // Usage shift (GA4). Two guards the old absolute-delta comparison lacked:
  // (1) a coverage check — GA4 data starts when the property was connected,
  // so the prior window can be mostly/entirely empty (site 8862: 3 days,
  // site 8864: none), and "mobile 24 to 480" is then just the data starting;
  // (2) it compares each device's SHARE of sessions, not the absolute session
  // delta, because a whole-site traffic surge (site 1 rose ~10x) would
  // otherwise rank the biggest device as a "shift" when the mix never moved.
  const ga4Dates = await getBreakdownDataDates(siteId, 'ga4', 'device', prior.start, end).catch(() => null);
  const ga4Windows = assessWindows({ start, end }, prior, ga4Dates, { lagDays: 0 });
  let growingDevices = [];
  let decliningDevices = [];
  let usageShift = { status: 'ok', reason: null };
  if (ga4Windows.ok) {
    const [recentRows, priorRows] = await Promise.all([
      getGa4BreakdownRange(siteId, ga4Windows.recent.start, ga4Windows.recent.end, 'device', 50),
      getGa4BreakdownRange(siteId, ga4Windows.prior.start, ga4Windows.prior.end, 'device', 50),
    ]);
    const shifts = splitShareShifts(computeShareShifts(recentRows, priorRows), { limit: 5 });
    // GA4's deviceCategory dimension returns lowercase ("desktop"); GSC's
    // device dimension (used for `devices`/`lowCtrDevices`) returns uppercase
    // ("DESKTOP"). Normalized to uppercase so both sections refer to the same
    // device consistently.
    const shape = (r) => ({ device: r.key.toUpperCase(), recent: r.recent, prior: r.prior, delta: r.delta, recentSharePct: r.recentShare, priorSharePct: r.priorShare, shareDeltaPp: r.shareDelta });
    growingDevices = shifts.gainers.map(shape);
    decliningDevices = shifts.droppers.map(shape);
  } else {
    usageShift = { status: 'insufficient-data', reason: ga4Windows.reason };
  }

  const devices = gscDevices.map((d) => ({
    device: d.dim_value,
    clicks: Number(d.clicks),
    impressions: Number(d.impressions),
    ctr: Number(d.ctr),
    avgPosition: d.avg_position != null ? Number(d.avg_position) : null,
  }));
  // Impression-weighted, two-proportion z-tested, and position-aware — a
  // device ranking far worse than the rest is `confoundedDevices` (its CTR
  // gap may just be its rank), which is reported as context, never as a
  // confirmed defect.
  const { flagged: lowCtrDevices, confounded: confoundedDevices } = flagLowCtrSignificant(devices);

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
    const baseEvidence = { device: d.device, ctr: d.ctr, ctrDeviationPct: d.ctrDeviationPct, ctrZ: d.ctrZ, clicks: d.clicks, impressions: d.impressions, diagnosis: diagnosis.cause };

    if (diagnosis.fixes.length) {
      return diagnosis.fixes.map((fix) => ({
        id: `device-intelligence:low-ctr:${d.device}:${fix.scope}:${fix.page || diagnosis.cause}`,
        evidence: { ...baseEvidence, ...diagnosis.evidence },
        whyItMatters: `${d.device} CTR is ${Math.abs(d.ctrDeviationPct)}% below this site's other devices (statistically significant, z=${d.ctrZ}) — ${diagnosis.explanation}`,
        magnitude,
        recommendedAction: fix.recommendedAction,
        verification: ctrVerification(d),
      }));
    }

    return [{
      id: `device-intelligence:low-ctr:${d.device}`,
      evidence: { ...baseEvidence, ...diagnosis.evidence },
      whyItMatters: `${d.device} CTR is ${Math.abs(d.ctrDeviationPct)}% below this site's other devices (statistically significant, z=${d.ctrZ}).`,
      magnitude,
      verification: ctrVerification(d),
      // A whole device class significantly under-performing the site's other
      // devices, at a comparable position (both enforced upstream by
      // flagLowCtrSignificant), is a real deficit, not a stat. diagnosis.explanation is set only for
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
      evidence: { device: d.device, recent: d.recent, prior: d.prior, delta: d.delta, recentSharePct: d.recentSharePct, priorSharePct: d.priorSharePct, shareDeltaPp: d.shareDeltaPp },
      whyItMatters: `${d.device} share of sessions fell from ${d.priorSharePct}% to ${d.recentSharePct}% (${ga4Windows.recent.start} to ${ga4Windows.recent.end} vs ${ga4Windows.prior.start} to ${ga4Windows.prior.end}).`,
      magnitude: Math.abs(d.shareDeltaPp),
    })),
  ];
  const ranked = [...candidates].sort((a, b) => b.magnitude - a.magnitude);
  const priorities = priorityByRank(ranked);
  const priorityById = new Map(ranked.map((c, i) => [c.id, priorities[i]]));
  const findings = candidates.map((c) => {
    const priority = priorityById.get(c.id);
    return makeFinding({
      id: c.id, evidence: c.evidence, whyItMatters: c.whyItMatters, priority,
      verification: c.verification || null,
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
    devices, lowCtrDevices, confoundedDevices, growingDevices, decliningDevices,
    usageShift,
    gscWindow,
    findings,
  };

  const system = 'You are an SEO/UX strategist writing for a non-technical site owner. Given device-split search ' +
    'CTR/position (real GSC data), lowCtrDevices (devices whose CTR is statistically significantly below the other ' +
    'devices\' impression-weighted CTR at a comparable ranking position), confoundedDevices (a lower CTR that may ' +
    'simply be a worse ranking position — NEVER call these a defect or a problem with the device, at most note the ' +
    'ranking gap), and growingDevices/decliningDevices (a device\'s SHARE of GA4 sessions in the requested period vs ' +
    'an equal-length prior period, in percent / percentage points — never an absolute session count change). If ' +
    'usageShift.status is "insufficient-data", say the usage comparison is not available and why; never describe ' +
    'a usage shift. If lowCtrDevices is empty, do not claim any device under-performs. Write 2-3 sentences, then, ' +
    'only if a device is in lowCtrDevices, suggest ONE concrete optimization action (e.g. mobile page speed, ' +
    'responsive layout, tap-target sizing) for it. Use ONLY the numbers given, never invent a benchmark. A lower ' +
    'average position is BETTER. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 300 })
    .catch((err) => { console.warn('[agents] device-intelligence narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
