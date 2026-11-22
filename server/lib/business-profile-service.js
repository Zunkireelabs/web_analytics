import {
  FIELD_KEYS, normalizeProfile, applyReview, profileState, lastVerifiedAt, diffProfiles, REQUIRED_FOR_CONFIRMED,
} from './business-profile.js';

// What the Business Intelligence page reads and does. Pure orchestration over injected dependencies (the store, the engine, the audit
// log), so every rule here is tested without a database. Routes in routes/projects.js are thin wrappers around these functions.

// The five concepts kept apart on the page, and the fields that belong to each (lib/business-profile.js explains why they are separate).
export const GROUPS = Object.freeze([
  { key: 'company', label: 'The company', hint: 'What it is, and the industry it operates in itself.', fields: ['description', 'ownIndustry', 'subIndustry'] },
  { key: 'offering', label: 'What it sells', hint: 'Products and services, how it earns, and for a marketplace who is on each side and what is listed.', fields: ['productsServices', 'businessModel', 'marketplace'] },
  { key: 'customers', label: 'Who buys it', hint: 'Its customers, their industries, and the problems it solves for them. These are not the company’s own industry.', fields: ['targetCustomers', 'targetCustomerIndustries', 'customerProblems'] },
  { key: 'market', label: 'Market', hint: 'Where it operates and who it competes with.', fields: ['geographicMarkets', 'competitorCategories'] },
  { key: 'topics', label: 'Subjects', hint: 'What it is an authority on.', fields: ['coreTopics'] },
]);

export const FIELD_LABELS = Object.freeze({
  description: 'Description', ownIndustry: 'Own industry', subIndustry: 'Sub-industry', businessModel: 'Business model',
  productsServices: 'Products and services', targetCustomerIndustries: 'Customer industries', targetCustomers: 'Target customers',
  customerProblems: 'Customer problems', geographicMarkets: 'Geographic markets', competitorCategories: 'Competitor categories', coreTopics: 'Core topics', marketplace: 'Marketplace',
});

export function buildView(current, { now = new Date() } = {}) {
  if (!current) {
    return { exists: false, state: 'insufficient', version: null, groups: [], pending: [], counts: { confirmed: 0, detected: 0, assumed: 0, insufficient: FIELD_KEYS.length }, lastVerifiedAt: null, createdAt: null, source: null, reason: null };
  }
  const profile = normalizeProfile(current.profile);
  const pendingByField = new Map((current.pending || []).map((p) => [p.field, p]));
  const counts = { confirmed: 0, detected: 0, assumed: 0, insufficient: 0 };
  const groups = GROUPS.map((g) => ({
    key: g.key, label: g.label, hint: g.hint,
    fields: g.fields.map((k) => {
      const f = profile.fields[k];
      counts[f.status] += 1;
      return {
        key: k, label: FIELD_LABELS[k], value: f.value, status: f.status, confidence: f.confidence, evidence: f.evidence,
        verifiedAt: f.verifiedAt, verifiedBy: f.verifiedBy, required: REQUIRED_FOR_CONFIRMED.includes(k),
        pending: pendingByField.get(k) || null,
      };
    }),
  }));
  return {
    exists: true, state: profileState(profile), version: current.version, groups, pending: current.pending || [], counts,
    lastVerifiedAt: lastVerifiedAt(profile), createdAt: current.createdAt ?? null, source: current.source ?? null, reason: current.reason ?? null,
    generatedAt: new Date(now).toISOString(),
  };
}

// A person's review. edits: [{ field, accept, value? }] confirm, correct or clear fields. decisions: [{ field, decision: 'accept'|'dismiss' }]
// resolve the automated findings that differed from a confirmed field: accepting applies the proposed value as the person's confirmed
// value, dismissing keeps the confirmed value and drops the finding. Nothing here can change a field the reviewer did not name.
export async function reviewProfile(siteId, { edits = [], decisions = [] } = {}, user, deps) {
  const current = await deps.getCurrent(siteId);
  if (!current) return { ok: false, status: 404, error: 'This project has no business profile yet. Refresh it first.' };
  const userId = user?.id ?? null;
  const known = new Set(FIELD_KEYS);
  const cleanEdits = (Array.isArray(edits) ? edits : []).filter((e) => e && known.has(e.field));
  const pending = new Map((current.pending || []).map((p) => [p.field, p]));
  const fromDecisions = [];
  for (const d of Array.isArray(decisions) ? decisions : []) {
    if (!d || !known.has(d.field)) continue;
    const p = pending.get(d.field);
    if (!p) continue; // nothing is pending for this field: the screen is stale
    if (d.decision === 'accept') fromDecisions.push({ field: d.field, accept: true, value: p.proposed });
    pending.delete(d.field);
  }
  const { profile, applied } = applyReview(current.profile, [...fromDecisions, ...cleanEdits], { userId });
  const resolved = (Array.isArray(decisions) ? decisions : []).filter((d) => d && known.has(d.field) && ['accept', 'dismiss'].includes(d.decision) && (current.pending || []).some((p) => p.field === d.field));
  if (applied.length === 0 && resolved.length === 0) return { ok: false, status: 400, error: 'Nothing to change.' };

  // A field that was rejected (cleared) is no longer pending either.
  for (const a of applied) if (a.action === 'rejected') pending.delete(a.field);
  const saved = await deps.save(siteId, {
    profile, pending: [...pending.values()], changed: diffProfiles(current.profile, profile).map((c) => c.field),
    applied: [...applied, ...resolved.map((d) => ({ field: d.field, action: d.decision === 'accept' ? 'accepted-detected-change' : 'dismissed-detected-change' }))],
    source: 'human', actor: userId, reason: 'review',
  });
  if (deps.audit) await deps.audit({ action: 'business_profile.reviewed', targetType: 'site', targetId: siteId, metadata: { applied, resolved: resolved.map((d) => ({ field: d.field, decision: d.decision })), version: saved?.version ?? null } }).catch(() => {});
  return { ok: true, saved, applied, resolved };
}

// A person's request to read the website again. Returns what the engine returned, with a plain reason when nothing could be learned.
export async function refreshProfile(siteId, user, deps) {
  const out = await deps.refresh(siteId, { reason: 'refresh' });
  if (deps.audit) await deps.audit({ action: 'business_profile.refreshed', targetType: 'site', targetId: siteId, metadata: { insufficient: Boolean(out?.insufficient), reason: out?.reason ?? null, changed: out?.changed ?? [], pending: (out?.pending || []).length } }).catch(() => {});
  return out;
}
