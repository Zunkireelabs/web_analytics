import { Router } from 'express';
import { getSiteIdByCrmWebhookToken, getProductGrowthConfig } from '../store/product-growth-config.js';
import { createTrialSignup, classifyTrialSignup } from '../store/trial-signups.js';
import { getLatestAgentRuns } from '../store/agent-runs.js';
import { fetchHomepageBodyText, findMatchingPhrase } from '../agents/lib/homepage-text.js';

// "See it live" self-serve trial tracking (Universal Product Growth mode).
// The trial/sandbox login itself lives outside this repo (e.g. Zenly's own
// app) — this is where it reports a new signup. Public, per-site bearer
// token (the same product_growth_config.crm_webhook_token issued for the
// CRM handoff — one external-boundary secret per site, not a second one to
// manage), mounted before requireAuth same as crm-webhook.js.
const router = Router();

async function siteIdFromAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  return token ? getSiteIdByCrmWebhookToken(token) : null;
}

// Real, evidence-based classification — never a guess from the company
// name or email domain alone:
//  1. The signup's own domain matches one of THIS site's already-tracked
//     real competitors (competitor-intelligence's own findings) — the
//     strongest possible signal, since that competitor was independently
//     identified, not guessed here.
//  2. Otherwise, the signup's own real homepage text contains one of the
//     site owner's configured competitor_signals phrases (language a
//     same-category seller would use about itself).
//  3. A real homepage was checked and matched neither — classified
//     'prospect', not silently left unclassified.
//  4. No domain given, or the domain couldn't be reached at all — stays
//     'unclassified'. No evidence either way is not evidence of innocence.
async function classify(siteId, companyDomain) {
  if (!companyDomain) return { classification: 'unclassified', evidence: null };

  const [config, [competitorRun]] = await Promise.all([
    getProductGrowthConfig(siteId),
    getLatestAgentRuns(siteId, ['competitor-intelligence']),
  ]);

  const trackedCompetitors = competitorRun?.facts?.competitorsIdentified || [];
  const normalizedDomain = companyDomain.replace(/^www\./, '').toLowerCase();
  if (trackedCompetitors.some((d) => d.replace(/^www\./, '').toLowerCase() === normalizedDomain)) {
    return { classification: 'competitor_suspect', evidence: { matchType: 'tracked-competitor-domain', domain: companyDomain } };
  }

  const origin = `https://${companyDomain}`;
  const fetched = await fetchHomepageBodyText(origin);
  if (!fetched) return { classification: 'unclassified', evidence: null };

  const matchedPhrase = findMatchingPhrase(fetched.text, config?.competitor_signals || []);
  if (matchedPhrase) {
    return { classification: 'competitor_suspect', evidence: { matchType: 'competitor-signal-phrase', matchedPhrase, sourceUrl: fetched.url } };
  }
  return { classification: 'prospect', evidence: { matchType: 'no-competitor-signal-found', sourceUrl: fetched.url } };
}

router.post('/trial-signup/webhook', async (req, res, next) => {
  try {
    const siteId = await siteIdFromAuth(req);
    if (!siteId) return res.status(401).json({ error: 'Invalid or missing token.' });

    const { email, companyName, companyDomain, source } = req.body || {};
    const signup = await createTrialSignup(siteId, { email, companyName, companyDomain, source });

    const { classification, evidence } = await classify(siteId, companyDomain);
    const classified = await classifyTrialSignup(signup.id, { classification, evidence });

    res.status(201).json(classified);
  } catch (e) { next(e); }
});

export default router;
