import { Router } from 'express';
import { getSiteIdByCrmWebhookToken } from '../store/product-growth-config.js';
import { listProspects, applyCrmOutcome, markProspectsCrmSynced } from '../store/prospects.js';
import { safeMessage } from '../lib/errors.js';

// The external CRM boundary (Universal Product Growth mode, Phase 4).
// Analytics/Growth Intelligence never sends outreach itself — this is the
// two-way handoff: EXPORT hands qualified, human-approved prospects to the
// CRM; INCOMING accepts real outcome status back. Both sides authenticate
// with a per-site bearer token (product_growth_config.crm_webhook_token,
// server/store/product-growth-config.js's ensureCrmWebhookToken), never a
// session cookie — same "public, token-authenticated, no session" shape as
// server/routes/webhooks.js's GitHub webhooks. Public — must be mounted
// before any router with a blanket `router.use(requireAuth)`, same
// mount-order hazard webhooks.js's own comment documents.
const router = Router();

function siteIdFromAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  return token ? getSiteIdByCrmWebhookToken(token) : Promise.resolve(null);
}

// EXPORT — the CRM pulls qualified, staff-approved prospects it hasn't
// already received. Marking them synced on this same call (rather than a
// separate ack step) keeps the contract simple: a prospect appears exactly
// once across every successful pull, same idempotency shape a queue-consumer
// API would have. Only ever includes approved_for_crm = true rows — the
// human-approval gate (server/store/prospects.js's approveProspectForCrm) is
// enforced here structurally, not by caller discipline.
router.get('/crm/export', async (req, res, next) => {
  try {
    const siteId = await siteIdFromAuth(req);
    if (!siteId) return res.status(401).json({ error: 'Invalid or missing CRM token.' });

    const prospects = await listProspects(siteId, { approvedForCrm: true });
    const unsynced = prospects.filter((p) => !p.crmSyncedAt);
    await markProspectsCrmSynced(siteId, unsynced.map((p) => p.id));

    res.json(unsynced.map((p) => ({
      id: p.id, companyName: p.companyName, market: p.market, industry: p.industry,
      qualificationReason: p.qualificationReason, evidence: p.evidence, confidence: p.confidence,
      recommendedSegment: p.recommendedSegment, status: p.status,
    })));
  } catch (e) { next(e); }
});

// INCOMING — real outcome/status updates from the CRM's own lifecycle
// (Prospect -> Contacted -> ... -> Converted, or whatever names the CRM
// uses — stored as free text, never re-validated against a fixed enum here,
// see 168's migration comment). Matches by our own prospect id when given,
// falling back to whatever external_crm_id the CRM already knows for this
// prospect (set the first time it reports one).
router.post('/crm/webhook', async (req, res, next) => {
  try {
    const siteId = await siteIdFromAuth(req);
    if (!siteId) return res.status(401).json({ error: 'Invalid or missing CRM token.' });

    const { prospectId, externalCrmId, status } = req.body || {};
    if (!status || (!prospectId && !externalCrmId)) {
      return res.status(400).json({ error: 'status and one of prospectId/externalCrmId are required.' });
    }

    const updated = await applyCrmOutcome(siteId, { prospectId: prospectId ? Number(prospectId) : null, externalCrmId, status: String(status) });
    if (!updated) return res.status(404).json({ error: 'No matching prospect found for this site.' });

    res.json({ id: updated.id, status: updated.status });
  } catch (e) {
    const { message } = safeMessage('crm-webhook.applyOutcome', e, 'this CRM update could not be applied');
    res.status(500).json({ error: message });
  }
});

export default router;
