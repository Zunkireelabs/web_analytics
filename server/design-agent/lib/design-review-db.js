// Dedicated-table backend for the design review store (migration 249). Same API as the JSON
// backend in design-review-store.js, so callers do not change; chosen automatically when the
// tables exist (createReviewStore), with the JSON backend kept for databases not yet migrated.
//
// Why tables: every validation records evidence, a remembered result and possibly a proposal.
// In the JSON backend each of those rewrote the whole url_file_map (~0.5 MB) under a row lock.
// Here they are small row writes, and the only url_file_map write left is an APPROVED change
// to the group map — done in the same transaction as the proposal status and the history row,
// so the three can never disagree.
import {
  reviewStateOf, approveProposal, rejectProposal, rollbackLast, rememberResult, currentRevision, ReviewConflict,
} from './design-review-store.js';

const rowToProposal = (r) => ({
  id: r.id, status: r.status, kind: r.kind, groupId: r.group_id, pagePath: r.page_path,
  pageUrl: r.payload?.pageUrl || null, entry: r.payload?.entry || null, capture: r.payload?.capture || null,
  reason: r.payload?.reason || null, signals: r.payload?.signals || null, baseRevision: r.base_revision,
  createdAt: new Date(r.created_at).toISOString(), seen: r.seen, decidedAt: r.decided_at, decidedBy: r.decided_by, note: r.note,
  payload: r.payload || {},
});
const rowToHistory = (r) => ({ revision: r.revision, action: r.action, proposalId: r.proposal_id, by: r.actor, note: r.note, before: r.before, at: new Date(r.created_at).toISOString() });

export function createTableReviewStore({ pool, now = () => new Date() }) {
  const tx = async (fn) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  };
  const lockSiteRoot = async (c, siteId) => {
    const row = (await c.query('SELECT url_file_map FROM sites WHERE id = $1 FOR UPDATE', [siteId])).rows[0];
    if (!row) throw new Error(`No site ${siteId}.`);
    return row.url_file_map || {};
  };
  // Applies a pure transition (approve/reject/rollback) to the locked row and persists all three parts.
  const applyTransition = (siteId, { proposalId = null, historyFor = null }, transition) => tx(async (c) => {
    const ufm = await lockSiteRoot(c, siteId);
    const siteRoot = ufm.siteRoot || {};
    const provisional = {};
    if (proposalId) {
      const p = (await c.query('SELECT * FROM design_proposals WHERE id = $1 AND site_id = $2 FOR UPDATE', [proposalId, siteId])).rows[0];
      if (!p) throw new ReviewConflict(`No proposal ${proposalId}.`, 'not-found');
      provisional[p.id] = rowToProposal(p);
    }
    const history = historyFor ? (await c.query('SELECT * FROM design_group_history WHERE site_id = $1 ORDER BY revision DESC, id DESC LIMIT 1', [siteId])).rows.map(rowToHistory) : [];
    if (historyFor && history[0]?.proposalId && !provisional[history[0].proposalId]) {
      const p = (await c.query('SELECT * FROM design_proposals WHERE id = $1', [history[0].proposalId])).rows[0];
      if (p) provisional[p.id] = rowToProposal(p);
    }
    const state = { version: 1, provisional, history, pageResults: {}, evidence: [] };
    const out = transition({ ...siteRoot, designReview: state });
    const nextState = out.designReview;
    const nextSiteRoot = { ...out, designReview: siteRoot.designReview }; // legacy JSON slice untouched
    if (nextSiteRoot.designReview === undefined) delete nextSiteRoot.designReview;
    if (JSON.stringify(nextSiteRoot.designProfile) !== JSON.stringify(siteRoot.designProfile)) {
      await c.query('UPDATE sites SET url_file_map = $2 WHERE id = $1', [siteId, JSON.stringify({ ...ufm, siteRoot: nextSiteRoot })]);
    }
    for (const p of Object.values(nextState.provisional || {})) {
      await c.query('UPDATE design_proposals SET status = $2, decided_at = $3, decided_by = $4, note = $5 WHERE id = $1', [p.id, p.status, p.decidedAt || null, p.decidedBy || null, p.note || null]);
    }
    const added = (nextState.history || []).filter((h) => !history.some((x) => x.revision === h.revision && x.action === h.action));
    for (const h of added) {
      await c.query('INSERT INTO design_group_history (site_id, revision, action, proposal_id, actor, note, before) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [siteId, h.revision, h.action, h.proposalId || null, h.by, h.note || null, JSON.stringify(h.before || null)]);
    }
    // Any change to the group map invalidates every remembered result for the site (they described the
    // old map; a batch join or split moves many pages at once). Rebuilt on the next validation.
    if (JSON.stringify(nextSiteRoot.designProfile) !== JSON.stringify(siteRoot.designProfile)) {
      await c.query('DELETE FROM design_page_results WHERE site_id = $1', [siteId]);
    }
    // A confirmed-deleted page: its open recommendations can no longer be acted on. Closed as
    // superseded (the same terminal state a re-check that no longer detects the issue uses) in the
    // SAME transaction, so the approval and the closure can never disagree.
    const decided = proposalId ? nextState.provisional?.[proposalId] : null;
    if (decided?.kind === 'page-gone' && decided.status === 'approved') {
      await c.query(`UPDATE recommendations SET status = 'superseded', updated_at = now()
                      WHERE site_id = $1 AND status = 'open'
                        AND COALESCE(NULLIF(regexp_replace(regexp_replace(page, '^https?://[^/]+', ''), '/+$', ''), ''), '/') = $2`, [siteId, decided.pagePath]);
    }
    return { revision: currentRevision(nextSiteRoot) };
  });

  return {
    backend: 'tables',

    /** Remembered result + the proposal it points at, for one page (what the stage needs before validating). */
    async loadPageState(site, pagePath) {
      const r = (await pool.query('SELECT result FROM design_page_results WHERE site_id = $1 AND page_path = $2', [site.id, pagePath])).rows[0]?.result || null;
      let provisional = {};
      if (r?.provisionalId) {
        const p = (await pool.query('SELECT * FROM design_proposals WHERE id = $1', [r.provisionalId])).rows[0];
        if (p) provisional = { [p.id]: rowToProposal(p) };
      }
      return { version: 1, pageResults: r ? { [pagePath]: r } : {}, provisional, history: [], evidence: [] };
    },

    recordValidation: (siteId, { pagePath, evidence, result, proposal = null }) => tx(async (c) => {
      let proposalId = null; let deduplicated = false;
      if (proposal) {
        const ufm = (await c.query('SELECT url_file_map FROM sites WHERE id = $1', [siteId])).rows[0]?.url_file_map || {};
        const fp = proposal.capture?.fingerprint?.hash || null;
        const pending = (await c.query(`SELECT * FROM design_proposals WHERE site_id = $1 AND page_path = $2 AND status = 'pending' FOR UPDATE`, [siteId, pagePath])).rows;
        const same = pending.find((p) => p.kind === proposal.kind && (p.payload?.capture?.fingerprint?.hash || null) === fp);
        if (same) {
          await c.query('UPDATE design_proposals SET seen = seen + 1 WHERE id = $1', [same.id]);
          proposalId = same.id; deduplicated = true;
        } else {
          await c.query(`UPDATE design_proposals SET status = 'superseded', decided_at = now() WHERE site_id = $1 AND page_path = $2 AND status = 'pending'`, [siteId, pagePath]);
          proposalId = `p${now().getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          await c.query('INSERT INTO design_proposals (id, site_id, kind, page_path, group_id, payload, base_revision) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
            proposalId, siteId, proposal.kind, pagePath, proposal.groupId || null,
            JSON.stringify({ pageUrl: proposal.pageUrl, entry: proposal.entry || null, capture: proposal.capture || null, reason: proposal.reason || null, signals: proposal.signals || null, ...(proposal.extra || {}) }),
            currentRevision(ufm.siteRoot || {}),
          ]);
        }
      }
      if (result) {
        const prev = (await c.query('SELECT result FROM design_page_results WHERE site_id = $1 AND page_path = $2 FOR UPDATE', [siteId, pagePath])).rows[0]?.result;
        const st = rememberResult({ pageResults: prev ? { [pagePath]: prev } : {} }, pagePath, { ...result, provisionalId: proposalId || result.provisionalId || null }, now());
        await c.query(`INSERT INTO design_page_results (site_id, page_path, result, updated_at) VALUES ($1,$2,$3,now())
                       ON CONFLICT (site_id, page_path) DO UPDATE SET result = EXCLUDED.result, updated_at = now()`, [siteId, pagePath, JSON.stringify(st.pageResults[pagePath])]);
      }
      if (evidence) {
        await c.query('INSERT INTO design_validation_evidence (site_id, kind, page_path, status, payload) VALUES ($1,$2,$3,$4,$5)',
          [siteId, evidence.kind || 'validation', pagePath || evidence.pagePath || null, evidence.status || null, JSON.stringify({ ...evidence, ...(proposalId ? { provisionalId: proposalId } : {}) })]);
      }
      return { proposalId, deduplicated };
    }),

    appendEvidence: (siteId, record) => pool.query('INSERT INTO design_validation_evidence (site_id, kind, page_path, status, payload) VALUES ($1,$2,$3,$4,$5)',
      [siteId, record.kind || 'evidence', record.pagePath || record.path || null, record.status ?? (record.ok === undefined ? null : (record.ok ? 'ok' : 'flagged')), JSON.stringify(record)]),

    listPending: async (siteId) => (await pool.query(`SELECT * FROM design_proposals WHERE site_id = $1 AND status = 'pending' ORDER BY created_at`, [siteId])).rows.map(rowToProposal),
    getProposal: async (siteId, id) => { const r = (await pool.query('SELECT * FROM design_proposals WHERE site_id = $1 AND id = $2', [siteId, id])).rows[0]; return r ? rowToProposal(r) : null; },
    listHistory: async (siteId, limit = 50) => (await pool.query('SELECT * FROM design_group_history WHERE site_id = $1 ORDER BY revision DESC, id DESC LIMIT $2', [siteId, limit])).rows.map(rowToHistory),
    listEvidence: async (siteId, limit = 100) => (await pool.query('SELECT * FROM design_validation_evidence WHERE site_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [siteId, limit])).rows,

    /** Adds a proposal directly (resurvey, deleted pages, new-page patterns) — still only a proposal. */
    addProposal: (siteId, proposal) => tx(async (c) => {
      const ufm = (await c.query('SELECT url_file_map FROM sites WHERE id = $1', [siteId])).rows[0]?.url_file_map || {};
      // The same open question is asked once: a repeat bumps `seen` on the pending proposal.
      const dup = (await c.query(`SELECT id FROM design_proposals WHERE site_id = $1 AND kind = $2 AND page_path IS NOT DISTINCT FROM $3 AND status = 'pending' FOR UPDATE`, [siteId, proposal.kind, proposal.pagePath || null])).rows[0];
      if (dup) { await c.query('UPDATE design_proposals SET seen = seen + 1 WHERE id = $1', [dup.id]); return dup.id; }
      const id = `p${now().getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await c.query('INSERT INTO design_proposals (id, site_id, kind, page_path, group_id, payload, base_revision) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, siteId, proposal.kind, proposal.pagePath || null, proposal.groupId || null, JSON.stringify(proposal.payload || {}), currentRevision(ufm.siteRoot || {})]);
      return id;
    }),

    approve: (siteId, id, opts) => applyTransition(siteId, { proposalId: id }, (root) => approveProposal(root, id, { ...opts, now: now() })),
    reject: (siteId, id, opts) => applyTransition(siteId, { proposalId: id }, (root) => rejectProposal(root, id, { ...opts, now: now() })),
    rollbackLast: (siteId, opts) => applyTransition(siteId, { historyFor: true }, (root) => rollbackLast(root, { ...opts, now: now() })),
  };
}

export { reviewStateOf };
