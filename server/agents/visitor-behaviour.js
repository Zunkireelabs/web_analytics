import { getPosthogSummary } from '../store/project-posthog.js';
import { getProductGrowthConfig } from '../store/product-growth-config.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';
import { analyzeDropOffs, describeDropOff } from './lib/visitor-behaviour.js';

export const meta = {
  id: 'visitor-behaviour',
  name: 'Visitor Behaviour',
  description: 'Reads where visitors stop, from the client\'s own PostHog, and raises a recommendation only for a step that ends a large share of visits and does not look like success. Says where people stopped, never why.',
  category: 'seo',
  version: 1,
  dataSources: [
    {
      id: 'posthog', status: 'connected',
      description: 'The client\'s own PostHog: the last meaningful step of each session. Optional — a project without it simply has no findings from this agent.',
    },
  ],
};

const WINDOW_DAYS = 28;

// Deps are injectable so the whole decision can be tested without a database.
export async function run({ siteId, deps = {} }) {
  const summaryFor = deps.getPosthogSummary || getPosthogSummary;
  const growthConfig = deps.getProductGrowthConfig || getProductGrowthConfig;
  const now = deps.now || new Date();

  const end = new Date(now); end.setUTCDate(end.getUTCDate() - 1); // yesterday: today is a partial day
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const range = { start: ymd(start), end: ymd(end) };

  const summary = await summaryFor(siteId, range.start, range.end).catch(() => null);
  if (!summary) {
    // Not an error and not a defect: most projects do not use PostHog.
    return { meta, status: 'insufficient-data', facts: null, narrative: null, message: 'PostHog is not connected for this project, so there is no visitor behaviour to read.', generatedAt: new Date().toISOString() };
  }

  // The client's own goal event means "the visit worked", so a visit ending there is not a drop-off. Best-effort: a
  // site without a growth config simply has none, which falls back to the wording heuristic alone.
  const config = await growthConfig(siteId).catch(() => null);
  const conversionEvents = [config?.conversion_event ?? config?.conversionEvent].filter(Boolean);

  const analysis = analyzeDropOffs(summary, { conversionEvents });
  if (analysis.status === 'insufficient-data') {
    return {
      meta, status: 'insufficient-data', facts: { reason: analysis.reason, measuredDays: analysis.measuredDays ?? null, needDays: analysis.needDays ?? null }, narrative: null,
      message: analysis.reason === 'too_few_days'
        ? `PostHog has ${analysis.measuredDays} day(s) of data for this project; at least ${analysis.needDays} are needed before a drop-off means anything.`
        : 'PostHog has no usable visit data for this period.',
      generatedAt: new Date().toISOString(),
    };
  }

  const findings = analysis.candidates.map((c) => makeFinding({
    id: `visitor-behaviour:drop-off:${c.step}`,
    evidence: { step: c.step, visits: c.visits, sharePct: Math.round(c.share * 100), totalSessions: analysis.totalSessions, windowDays: WINDOW_DAYS, from: range.start, to: range.end },
    whyItMatters: describeDropOff(c, { totalSessions: analysis.totalSessions, days: WINDOW_DAYS }),
    priority: c.priority,
    // No generator can safely act here: what is wrong at a step is a design or offer decision, and nothing in the data
    // says what. Null makes this a manual recommendation, which is the honest shape for "look at this".
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(c.priority), basis: 'computed', value: c.visits },
  }));

  return {
    meta, status: 'ok',
    facts: { windowDays: WINDOW_DAYS, measuredDays: summary.measured_days, totalSessions: analysis.totalSessions, stepsConsidered: analysis.considered, findings },
    narrative: null,
    generatedAt: new Date().toISOString(),
  };
}

const ymd = (d) => d.toISOString().slice(0, 10);
