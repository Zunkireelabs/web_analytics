// DESIGN REVIEW STORE — everything the live design validation REMEMBERS, and the only
// way the saved layout-group map is allowed to change.
//
// Stored under sites.url_file_map.siteRoot.designReview (JSONB; no migration):
//
//   provisional   proposed changes to the group map, each from a fresh capture of ONE
//                 page, waiting for a person: { id, kind, groupId, pagePath, entry,
//                 status: pending|approved|rejected|superseded, baseRevision, ... }
//   pageResults   the last validation outcome per page, keyed by the page's layout
//                 fingerprint, so an unchanged page is not re-compared or re-captured
//                 on every draft (and a blocked page is not retried in a tight loop)
//   history       a snapshot before every approved change, so any change can be rolled
//                 back (bounded)
//   evidence      a bounded log of validation / integrity decisions, for measuring
//                 false positives and tuning (design_gate_decisions cannot hold these
//                 without a migration: its `gate` column is CHECK-limited)
//
// Rules that make shared groups safe:
//   * Validation never changes layoutGroups. It can only ADD a provisional proposal.
//   * A proposal is applied only by approveProposal(), by a named person, against the
//     layoutGroups.revision they reviewed (expectedRevision). If the map changed since,
//     the approval is refused (conflict) and must be redone against the new state.
//   * Every approved change snapshots what it replaced; rollback restores it.
//   * Every write happens inside ONE row-locked transaction on the fresh row, touching
//     only this slice and the group map, never rewriting from a stale snapshot.
import { pathKey } from './live-design-validation.js';

export const REVIEW_VERSION = 1;
const MAX_EVIDENCE = 300;
const MAX_HISTORY = 20;
const MAX_PENDING = 30;
const MEMO_TTL_MS = 24 * 60 * 60 * 1000;
export const BLOCK_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]; // retry delays for transient blocks
export const MAX_TRANSIENT_ATTEMPTS = 6; // after this, a blocked page waits for a person / a changed page

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function emptyState() {
  return { version: REVIEW_VERSION, provisional: {}, pageResults: {}, history: [], evidence: [] };
}

export function reviewStateOf(siteRoot) {
  const s = siteRoot?.designReview;
  return s && s.version === REVIEW_VERSION ? s : emptyState();
}

const withState = (siteRoot, state) => ({ ...siteRoot, designReview: state });
const profileOf = (siteRoot) => siteRoot?.designProfile || {};

export function currentRevision(siteRoot) {
  return profileOf(siteRoot).layoutGroups?.revision || 0;
}

// ── Evidence (M2) ──────────────────────────────────────────────────────────

export function appendEvidence(state, record, now = new Date()) {
  const evidence = [...(state.evidence || []), { at: now.toISOString(), ...record }];
  return { ...state, evidence: evidence.slice(-MAX_EVIDENCE) };
}

// ── Remembered results (M3) ────────────────────────────────────────────────

export function lookupMemo(state, pagePath, fingerprintHash, now = new Date()) {
  const r = state.pageResults?.[pagePath];
  if (!r) return null;
  if (r.outcome === 'blocked') {
    // A blocked page stays blocked until its retry time; after the attempt cap it waits for a person or a changed page.
    if (r.exhausted) return { ...r, usable: false, waitingFor: 'review' };
    if (r.retryAfter && Date.parse(r.retryAfter) > now.getTime()) return { ...r, usable: false, waitingFor: 'backoff' };
    return null;
  }
  if (r.fingerprintHash !== fingerprintHash) return null;
  if (r.expiresAt && Date.parse(r.expiresAt) <= now.getTime()) return null;
  return { ...r, usable: true };
}

export function rememberResult(state, pagePath, result, now = new Date()) {
  const prev = state.pageResults?.[pagePath];
  const entry = { ...result, lastAt: now.toISOString(), firstAt: prev?.firstAt || now.toISOString() };
  if (result.outcome === 'blocked') {
    const attempts = (prev?.outcome === 'blocked' ? prev.attempts || 0 : 0) + 1;
    entry.attempts = attempts;
    entry.exhausted = !result.transient || attempts >= MAX_TRANSIENT_ATTEMPTS;
    // A missing page is re-checked no sooner than an hour later, so a deploy blip is never mistaken for a deletion.
    const delay = Math.max(BLOCK_BACKOFF_MS[Math.min(attempts - 1, BLOCK_BACKOFF_MS.length - 1)], result.reason === 'page-gone' ? 60 * 60_000 : 0);
    entry.retryAfter = new Date(now.getTime() + delay).toISOString();
  } else {
    entry.expiresAt = new Date(now.getTime() + MEMO_TTL_MS).toISOString();
  }
  return { ...state, pageResults: { ...(state.pageResults || {}), [pagePath]: entry } };
}

// ── Provisional proposals (H4) ─────────────────────────────────────────────

export function addProvisional(state, proposal, { baseRevision, now = new Date() }) {
  const pagePath = proposal.pagePath || pathKey(proposal.pageUrl);
  const fp = proposal.capture?.fingerprint?.hash || null;
  const existing = Object.values(state.provisional || {}).find((p) => p.status === 'pending' && p.pagePath === pagePath && p.kind === proposal.kind && (p.capture?.fingerprint?.hash || null) === fp);
  if (existing) {
    return { state: { ...state, provisional: { ...state.provisional, [existing.id]: { ...existing, seen: (existing.seen || 1) + 1, lastSeenAt: now.toISOString() } } }, id: existing.id, deduplicated: true };
  }
  let provisional = { ...(state.provisional || {}) };
  // A newer proposal for the same page supersedes older pending ones for it.
  for (const [k, p] of Object.entries(provisional)) {
    if (p.status === 'pending' && p.pagePath === pagePath) provisional[k] = { ...p, status: 'superseded', decidedAt: now.toISOString() };
  }
  const id = `p${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  provisional[id] = {
    id, status: 'pending', kind: proposal.kind, groupId: proposal.groupId || null, pagePath, pageUrl: proposal.pageUrl,
    entry: proposal.entry || null, capture: proposal.capture || null, reason: proposal.reason || null, signals: proposal.signals || null,
    payload: proposal.payload || proposal.extra || null,
    baseRevision, createdAt: now.toISOString(), seen: 1,
  };
  // Bound the pending list: oldest pending is dropped first.
  const pending = Object.values(provisional).filter((p) => p.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const old of pending.slice(0, Math.max(0, pending.length - MAX_PENDING))) provisional[old.id] = { ...old, status: 'superseded', decidedAt: now.toISOString(), entry: null };
  return { state: { ...state, provisional }, id, deduplicated: false };
}

export function listPending(state) {
  return Object.values(state.provisional || {}).filter((p) => p.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── Applying / rolling back (pure over siteRoot) ───────────────────────────

const removeFromGroups = (groups, key, exceptId = null) => groups.map((g) => (g.id === exceptId ? g : { ...g, members: g.members.filter((m) => pathKey(m) !== key) }));

function upsertPage(pages, entry) {
  const key = pathKey(entry.url);
  const i = pages.findIndex((p) => pathKey(p.url) === key);
  const next = [...pages];
  if (i >= 0) next[i] = entry; else next.push(entry);
  return next;
}

function snapshotFor(siteRoot, pageKeys) {
  const p = profileOf(siteRoot);
  const pages = {};
  for (const k of pageKeys) pages[k] = clone((p.pages || []).find((x) => pathKey(x.url) === k) || null);
  return { groups: clone(p.layoutGroups?.groups || []), pages, approvedPagePatterns: clone(p.approvedPagePatterns || null) };
}

export class ReviewConflict extends Error {
  constructor(message, code, extra = {}) { super(message); this.name = 'ReviewConflict'; this.code = code; Object.assign(this, extra); }
}

export function approveProposal(siteRoot, id, { by, note = null, expectedRevision, now = new Date() }) {
  if (!by) throw new ReviewConflict('An approval must name who approved it.', 'approver-required');
  const state = reviewStateOf(siteRoot);
  const prop = state.provisional?.[id];
  if (!prop) throw new ReviewConflict(`No proposal ${id}.`, 'not-found');
  if (prop.status !== 'pending') throw new ReviewConflict(`Proposal ${id} is already ${prop.status}.`, 'not-pending');
  const revision = currentRevision(siteRoot);
  if (expectedRevision !== revision) throw new ReviewConflict(`The group map changed since this was reviewed (reviewed at revision ${expectedRevision}, now ${revision}). Review again.`, 'revision-conflict', { expectedRevision, revision });

  const profile = profileOf(siteRoot);
  let groups = clone(profile.layoutGroups?.groups || []);
  let pages = clone(profile.pages || []);
  const key = prop.pagePath;
  const oldGroup = groups.find((g) => g.members.some((m) => pathKey(m) === key));
  const before = snapshotFor(siteRoot, [key, ...(prop.kind === 'replace-sample' ? [pathKey(groups.find((g) => g.id === prop.groupId)?.sample || '')] : []), ...(prop.payload?.parts || []).flatMap((pt) => (pt.entries || []).map((e) => pathKey(e.url)))].filter(Boolean));

  if (['join', 'new-group'].includes(prop.kind) && oldGroup && pathKey(oldGroup.sample) === key) {
    throw new ReviewConflict(`This page is the sample of group ${oldGroup.id}; moving it would leave that group without its baseline. Propose a replace-sample for that group instead.`, 'is-group-sample');
  }
  const entry = prop.entry ? { ...prop.entry, url: prop.entry.url || prop.pageUrl } : null;
  let nextApprovedPatterns = profile.approvedPagePatterns;

  if (prop.kind === 'new-group') {
    if (!entry) throw new ReviewConflict('This proposal carries no capture.', 'no-capture');
    const members = (prop.payload?.members?.length ? prop.payload.members : [key]).map(pathKey);
    for (const k of members) {
      const holder = groups.find((x) => pathKey(x.sample) === k && x.members.length > 1);
      if (holder) throw new ReviewConflict(`${k} is the sample of group ${holder.id}; moving it would leave that group without its baseline.`, 'is-group-sample');
      groups = removeFromGroups(groups, k);
    }
    const nextId = groups.reduce((n, g) => Math.max(n, Number(String(g.id).replace(/\D/g, '')) || 0), 0) + 1;
    const extraSamples = (prop.payload?.samples || []).map(pathKey).filter((x) => x !== key);
    groups.push({ id: `g${nextId}`, size: members.length, sample: key, samples: extraSamples, members: members.includes(key) ? members : [key, ...members], capture: prop.capture || null });
    pages = upsertPage(pages, entry);
  } else if (prop.kind === 'join') {
    // One page, or a batch of pages (payload.members) that all match the same group's sample.
    const g = groups.find((x) => x.id === prop.groupId);
    if (!g) throw new ReviewConflict(`Group ${prop.groupId} no longer exists.`, 'group-missing');
    const joining = (prop.payload?.members?.length ? prop.payload.members : [key]).map(pathKey);
    for (const k of joining) {
      const holder = groups.find((x) => x.id !== g.id && pathKey(x.sample) === k && x.members.length > 1);
      if (holder) throw new ReviewConflict(`${k} is the sample of group ${holder.id}; moving it would leave that group without its baseline.`, 'is-group-sample');
      groups = removeFromGroups(groups, k, g.id).map((x) => (x.id === g.id && !x.members.some((m) => pathKey(m) === k) ? { ...x, members: [...x.members, k] } : x));
    }
  } else if (prop.kind === 'replace-sample') {
    const g = groups.find((x) => x.id === prop.groupId);
    if (!g) throw new ReviewConflict(`Group ${prop.groupId} no longer exists.`, 'group-missing');
    if (!entry) throw new ReviewConflict('This proposal carries no capture.', 'no-capture');
    const oldSampleKey = pathKey(g.sample);
    groups = groups.map((x) => (x.id === g.id ? { ...x, sample: key, members: x.members.some((m) => pathKey(m) === key) ? x.members : [...x.members, key], capture: prop.capture || null } : x));
    pages = pages.filter((p) => pathKey(p.url) !== oldSampleKey || oldSampleKey === key);
    pages = upsertPage(pages, entry);
  } else if (prop.kind === 'page-gone') {
    // The page no longer exists on the live site (confirmed twice, some time apart). Its group
    // membership and capture go; a page that is a group's baseline cannot be removed until the group
    // has another sample (propose replace-sample first), unless it was that group's only page.
    const holder = groups.find((g) => pathKey(g.sample) === key);
    if (holder && holder.members.some((m) => pathKey(m) !== key)) {
      throw new ReviewConflict(`This page is the sample of group ${holder.id}, which still has other pages. Approve a replace-sample for that group first.`, 'is-group-sample');
    }
    groups = removeFromGroups(groups, key);
    pages = pages.filter((p) => pathKey(p.url) !== key);
  } else if (prop.kind === 'add-sample') {
    // An ADDITIONAL representative for a group whose pages vary (B): the primary sample is unchanged.
    const g = groups.find((x) => x.id === prop.groupId);
    if (!g) throw new ReviewConflict(`Group ${prop.groupId} no longer exists.`, 'group-missing');
    if (!entry) throw new ReviewConflict('This proposal carries no capture.', 'no-capture');
    const samples = [...new Set([...(g.samples || []), key])].filter((x) => pathKey(x) !== pathKey(g.sample));
    groups = groups.map((x) => (x.id === g.id ? { ...x, samples, members: x.members.some((m) => pathKey(m) === key) ? x.members : [...x.members, key] } : x));
    pages = upsertPage(pages, entry);
  } else if (prop.kind === 'split-group') {
    // A heterogeneous group (A) replaced by the sub-groups the resurvey found, each with its own sample.
    const g = groups.find((x) => x.id === prop.groupId);
    const parts = prop.payload?.parts || [];
    if (!g) throw new ReviewConflict(`Group ${prop.groupId} no longer exists.`, 'group-missing');
    if (parts.length < 2) throw new ReviewConflict('A split needs at least two parts.', 'bad-split');
    const covered = new Set(parts.flatMap((pt) => pt.members.map(pathKey)));
    const lost = g.members.filter((m) => !covered.has(pathKey(m)));
    if (lost.length) throw new ReviewConflict(`The split leaves ${lost.length} page(s) of ${g.id} in no group (${lost.slice(0, 3).join(', ')}).`, 'bad-split');
    let nextId = groups.reduce((n, x) => Math.max(n, Number(String(x.id).replace(/\D/g, '')) || 0), 0);
    const replacement = parts.map((pt) => ({ id: `g${++nextId}`, size: pt.members.length, sample: pt.sample, samples: pt.samples || [], members: pt.members, splitFrom: g.id }));
    groups = groups.flatMap((x) => (x.id === g.id ? replacement : [x]));
    for (const pt of parts) for (const e of pt.entries || []) pages = upsertPage(pages, e);
  } else if (prop.kind === 'new-page-pattern') {
    // F: the design pattern NEW pages of a type may use when the site has no page of that type yet.
    const pageType = prop.payload?.pageType;
    if (!pageType || !prop.payload?.pattern?.sectionOrder?.length) throw new ReviewConflict('A page pattern needs a page type and a section order.', 'bad-pattern');
    nextApprovedPatterns = { ...(profile.approvedPagePatterns || {}), [pageType]: { ...prop.payload.pattern, approvedBy: by, approvedAt: now.toISOString(), source: prop.payload.source || null } };
  } else {
    throw new ReviewConflict(`Unknown proposal kind ${prop.kind}.`, 'unknown-kind');
  }
  groups = groups.filter((g) => g.members.length).map((g) => ({ ...g, size: g.members.length }));

  const nextRevision = revision + 1;
  const history = [...(state.history || []), {
    revision: nextRevision, at: now.toISOString(), by, action: 'approve', proposalId: id, kind: prop.kind, pagePath: key, groupId: prop.groupId || null, note, before,
  }].slice(-MAX_HISTORY);
  const nextProfile = { ...profile, pages, layoutGroups: { ...(profile.layoutGroups || {}), groups, revision: nextRevision, updatedAt: now.toISOString() }, ...(nextApprovedPatterns ? { approvedPagePatterns: nextApprovedPatterns } : {}) };
  // Every remembered validation result described the OLD map (a join/split/sample change can move any
  // number of pages), so all of them are dropped; they are rebuilt on the next validation.
  const nextState = { ...state, history, provisional: { ...state.provisional, [id]: { ...prop, status: 'approved', decidedAt: now.toISOString(), decidedBy: by, note } }, pageResults: {} };
  return withState({ ...siteRoot, designProfile: nextProfile }, nextState);
}

export function rejectProposal(siteRoot, id, { by, note = null, now = new Date() }) {
  if (!by) throw new ReviewConflict('A rejection must name who rejected it.', 'approver-required');
  const state = reviewStateOf(siteRoot);
  const prop = state.provisional?.[id];
  if (!prop) throw new ReviewConflict(`No proposal ${id}.`, 'not-found');
  if (prop.status !== 'pending') throw new ReviewConflict(`Proposal ${id} is already ${prop.status}.`, 'not-pending');
  return withState(siteRoot, { ...state, provisional: { ...state.provisional, [id]: { ...prop, status: 'rejected', decidedAt: now.toISOString(), decidedBy: by, note, entry: null } } });
}

// Undo the most recent approved change. Refused if the map has been changed by anything else since.
export function rollbackLast(siteRoot, { by, note = null, expectedRevision, now = new Date() }) {
  if (!by) throw new ReviewConflict('A rollback must name who did it.', 'approver-required');
  const state = reviewStateOf(siteRoot);
  const last = (state.history || []).at(-1);
  if (!last) throw new ReviewConflict('There is nothing to roll back.', 'no-history');
  const revision = currentRevision(siteRoot);
  if (expectedRevision !== revision) throw new ReviewConflict(`The group map changed (expected revision ${expectedRevision}, now ${revision}).`, 'revision-conflict', { expectedRevision, revision });
  if (last.revision !== revision) throw new ReviewConflict('The latest change in the history is not the current state; the map was changed outside this process. Not rolling back blindly.', 'history-mismatch');

  const profile = profileOf(siteRoot);
  let pages = clone(profile.pages || []);
  for (const [key, entry] of Object.entries(last.before.pages || {})) {
    pages = pages.filter((p) => pathKey(p.url) !== key);
    if (entry) pages.push(entry);
  }
  const nextRevision = revision + 1;
  const history = [...state.history.slice(0, -1), { ...last, rolledBackAt: now.toISOString(), rolledBackBy: by },
    { revision: nextRevision, at: now.toISOString(), by, action: 'rollback', rolledBackRevision: last.revision, note, before: snapshotFor(siteRoot, Object.keys(last.before.pages || {})) }].slice(-MAX_HISTORY);
  const nextProfile = { ...profile, pages, layoutGroups: { ...(profile.layoutGroups || {}), groups: clone(last.before.groups), revision: nextRevision, updatedAt: now.toISOString() } };
  if (last.before.approvedPagePatterns !== undefined) { if (last.before.approvedPagePatterns) nextProfile.approvedPagePatterns = clone(last.before.approvedPagePatterns); else delete nextProfile.approvedPagePatterns; }
  const provisional = { ...state.provisional };
  if (last.proposalId && provisional[last.proposalId]) provisional[last.proposalId] = { ...provisional[last.proposalId], status: 'rolled-back' };
  return withState({ ...siteRoot, designProfile: nextProfile }, { ...state, history, provisional, pageResults: {} });
}

// ── Persistence: ONE row-locked transaction on the fresh row ───────────────

export async function defaultWithSiteLock(siteId, fn) {
  const { pool } = await import('../../db.js');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT url_file_map FROM sites WHERE id = $1 FOR UPDATE', [siteId]);
    if (!rows.length) throw new Error(`No site ${siteId}.`);
    const urlFileMap = rows[0].url_file_map || {};
    const result = await fn(urlFileMap);
    if (result?.urlFileMap) await client.query('UPDATE sites SET url_file_map = $2 WHERE id = $1', [siteId, JSON.stringify(result.urlFileMap)]);
    await client.query('COMMIT');
    return result?.value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Picks the storage: the dedicated tables (migration 249) when they exist, otherwise the JSON slice.
// An explicit withSiteLock (tests, or a caller that wants the JSON slice) forces the JSON backend.
let tablesAvailable = null;
async function tablesExist(pool) {
  if (tablesAvailable === null) {
    try { tablesAvailable = (await pool.query("SELECT to_regclass('public.design_proposals') IS NOT NULL AS ok")).rows[0].ok === true; } catch { tablesAvailable = false; }
  }
  return tablesAvailable;
}
export function __resetBackendDetection() { tablesAvailable = null; }

export function createReviewStore({ withSiteLock = null, now = () => new Date(), pool = null } = {}) {
  if (withSiteLock) return createJsonReviewStore({ withSiteLock, now });
  let chosen = null;
  const pick = async () => {
    if (chosen) return chosen;
    const p = pool || (await import('../../db.js')).pool;
    if (await tablesExist(p)) {
      const { createTableReviewStore } = await import('./design-review-db.js');
      chosen = createTableReviewStore({ pool: p, now });
    } else chosen = createJsonReviewStore({ withSiteLock: defaultWithSiteLock, now });
    return chosen;
  };
  const methods = ['loadPageState', 'recordValidation', 'appendEvidence', 'listPending', 'approve', 'reject', 'rollbackLast', 'addProposal', 'getProposal', 'listHistory', 'listEvidence', 'read'];
  const proxy = { backend: 'auto', resolve: pick };
  for (const m of methods) proxy[m] = async (...args) => { const b = await pick(); if (!b[m]) throw new Error(`${m} is not supported by the ${b.backend} design review backend`); return b[m](...args); };
  return proxy;
}

function createJsonReviewStore({ withSiteLock = defaultWithSiteLock, now = () => new Date() } = {}) {
  // fn(siteRoot) -> { siteRoot, value } ; the whole url_file_map is re-read under the lock
  const mutate = (siteId, fn) => withSiteLock(siteId, async (ufm) => {
    const siteRoot = ufm.siteRoot || {};
    const out = await fn(siteRoot);
    if (!out) return { value: undefined };
    return { urlFileMap: { ...ufm, siteRoot: out.siteRoot }, value: out.value };
  });
  const read = (siteId) => withSiteLock(siteId, async (ufm) => ({ value: reviewStateOf(ufm.siteRoot) }));

  return {
    backend: 'json',
    read,
    loadPageState: async (site) => reviewStateOf(site?.url_file_map?.siteRoot),
    /** One write per validation: evidence + remembered result + (optionally) a provisional proposal. */
    recordValidation: (siteId, { pagePath, evidence, result, proposal = null }) => mutate(siteId, (siteRoot) => {
      let state = reviewStateOf(siteRoot);
      let proposalId = null; let deduplicated = false;
      if (proposal) { const added = addProvisional(state, proposal, { baseRevision: currentRevision(siteRoot), now: now() }); state = added.state; proposalId = added.id; deduplicated = added.deduplicated; }
      if (result) state = rememberResult(state, pagePath, { ...result, provisionalId: proposalId || result.provisionalId || null }, now());
      if (evidence) state = appendEvidence(state, { ...evidence, ...(proposalId ? { provisionalId: proposalId } : {}) }, now());
      return { siteRoot: withState(siteRoot, state), value: { proposalId, deduplicated } };
    }),
    appendEvidence: (siteId, record) => mutate(siteId, (siteRoot) => ({ siteRoot: withState(siteRoot, appendEvidence(reviewStateOf(siteRoot), record, now())) })),
    addProposal: (siteId, proposal) => mutate(siteId, (siteRoot) => {
      const added = addProvisional(reviewStateOf(siteRoot), { ...proposal, pageUrl: proposal.payload?.pageUrl || null }, { baseRevision: currentRevision(siteRoot), now: now() });
      return { siteRoot: withState(siteRoot, added.state), value: added.id };
    }),
    listPending: async (siteId) => listPending(await read(siteId)),
    approve: (siteId, id, opts) => mutate(siteId, (siteRoot) => ({ siteRoot: approveProposal(siteRoot, id, { ...opts, now: now() }), value: { revision: undefined } })),
    reject: (siteId, id, opts) => mutate(siteId, (siteRoot) => ({ siteRoot: rejectProposal(siteRoot, id, { ...opts, now: now() }) })),
    rollbackLast: (siteId, opts) => mutate(siteId, (siteRoot) => ({ siteRoot: rollbackLast(siteRoot, { ...opts, now: now() }) })),
  };
}
