import { query } from '../db.js';
import { getProductIdBySiteId } from './products.js';
import { getProductGrowthConfig } from './product-growth-config.js';

// Progress readout for a PRODUCT site's goals (book_demos / grow_signups /
// activate_users, migration 177). The platform already stores the raw signals
// — prospects (CRM lifecycle, migration 168) and trial_signups (migration 169)
// — but nothing turned them into "how are we doing against the goal". This
// reads them; it never writes, and never estimates anything it can't count.
//
// What this does NOT cover (stated, not hidden): named GA4 events. Today only
// the aggregate ga4_conversions count is ingested, so a product site's
// website-side funnel (visits -> demo-form views -> submits) is not here;
// that needs a named-event collector and is a separate piece of work.

// Prospect lifecycle values come from the CRM webhook as free text
// (routes/crm-webhook.js). These are the ones that mean a demo was booked or
// happened; 'trial' and 'converted' are tracked separately, never folded in.
export const DEMO_STATUSES = Object.freeze(['demo_booked', 'demo_completed']);
const CONVERTED_STATUSES = Object.freeze(['converted']);

// A signup the classifier flagged as a probable competitor is real data but
// not a win — it is excluded from the headline number and reported alongside.
const NOT_A_WIN = 'competitor_suspect';

// product_growth_config.conversion_event is free text ('booked_demo', 'trial',
// 'signup', 'purchase' ...). Map it onto the one count that answers "did the
// thing the site owner said matters happen". Unknown text returns null — the
// caller then shows the raw counts without inventing a headline.
export function headlineFor(conversionEvent, counts) {
  const event = String(conversionEvent || '').toLowerCase();
  if (!event) return null;
  if (/demo/.test(event)) return { label: 'Demos booked', value: counts.demosBooked };
  if (/trial|signup|sign_up|sign-up|register/.test(event)) return { label: 'Trial signups', value: counts.trialSignups };
  if (/purchase|convert|paid|customer|sale/.test(event)) return { label: 'Converted customers', value: counts.converted };
  return null;
}

export function summarizeFunnel({ conversionEvent, prospectStatusCounts = {}, signupCounts = {} }) {
  const sum = (statuses) => statuses.reduce((n, s) => n + (Number(prospectStatusCounts[s]) || 0), 0);
  const counts = {
    demosBooked: sum(DEMO_STATUSES),
    converted: sum(CONVERTED_STATUSES),
    trialSignups: Number(signupCounts.real) || 0,
    competitorSuspectSignups: Number(signupCounts.competitor) || 0,
    prospectsByStatus: Object.fromEntries(Object.entries(prospectStatusCounts).map(([k, v]) => [k, Number(v) || 0])),
  };
  return { conversionEvent: conversionEvent || null, headline: headlineFor(conversionEvent, counts), counts };
}

export async function getProductFunnel(siteId, { days = 30 } = {}) {
  const productId = await getProductIdBySiteId(siteId);
  if (!productId) return null;
  const window = Math.max(1, Math.min(Number(days) || 30, 365));

  const [config, prospects, signups] = await Promise.all([
    getProductGrowthConfig(siteId),
    query(
      `SELECT status, COUNT(*) AS n FROM prospects
        WHERE product_id = $1 AND updated_at >= now() - ($2 || ' days')::interval
        GROUP BY status`,
      [productId, String(window)]
    ),
    query(
      `SELECT (classification = $3) AS is_competitor, COUNT(*) AS n FROM trial_signups
        WHERE product_id = $1 AND created_at >= now() - ($2 || ' days')::interval
        GROUP BY (classification = $3)`,
      [productId, String(window), NOT_A_WIN]
    ),
  ]);

  const prospectStatusCounts = Object.fromEntries(prospects.rows.map((r) => [r.status, Number(r.n)]));
  const signupCounts = { real: 0, competitor: 0 };
  for (const r of signups.rows) signupCounts[r.is_competitor ? 'competitor' : 'real'] = Number(r.n);

  return { windowDays: window, ...summarizeFunnel({ conversionEvent: config?.conversion_event, prospectStatusCounts, signupCounts }) };
}
