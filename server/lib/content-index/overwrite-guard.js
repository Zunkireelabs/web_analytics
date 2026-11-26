// OVERWRITE PROTECTION: an edit never silently replaces a file that changed after the item read it, and a new page never replaces a file that
// already exists. Runs in the one function every implementer's push goes through (implementers/lib/github-ops.js pushDraftBranch).
//
// What it knows, and how:
//  - READ LEDGER: every successful file read (github/client.js getFileContent) notes { site, ref, path } -> blob sha, in process memory. An
//    item that generates and pushes in the same shipping run therefore has a recorded "what I read" for every file it edits.
//  - At push time the file's CURRENT sha on the base branch is compared with what was read. Equal: write. Different: the file changed on
//    main (or through another item) since the read, so the edit is REBUILT from fresh content (retryable) or, when another in-flight item already
//    claims that file, BLOCKED. It is never written over.
//  - A file that exists but was never read by this item (a new page whose slug collides, or an edit with no recorded read) cannot be proven
//    safe: a net-new page onto an existing file is refused; anything else is allowed but reported as 'unverified-base', never as safe.
// Mode (OVERWRITE_GUARD): 'off' | 'log' (default: decides and records, never refuses) | 'enforce' (refuses).
import { NET_NEW_ACTION_TYPES } from './build.js';
import { operatorDetail } from '../errors.js';

export const overwriteGuardMode = (env = process.env) => {
  const v = String(env.OVERWRITE_GUARD || 'log').toLowerCase();
  return ['off', 'log', 'enforce'].includes(v) ? v : 'log';
};

// ── read ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const LEDGER_MAX = 2000;
const ledger = new Map();
const lkey = (siteId, ref, path) => `${siteId}|${ref}|${path}`;
export function noteFileRead(siteId, ref, path, sha) {
  if (siteId == null || !path || !sha) return;
  const k = lkey(siteId, ref, path);
  ledger.delete(k); ledger.set(k, { sha, at: Date.now() });
  if (ledger.size > LEDGER_MAX) ledger.delete(ledger.keys().next().value);
}
export const readShaFor = (siteId, ref, path) => ledger.get(lkey(siteId, ref, path))?.sha ?? null;
export const clearReadLedger = () => ledger.clear();

/**
 * Pure. The decision for ONE file about to be written.
 *   exists       the file exists on the base branch right now
 *   readSha      the sha this item read it at (null = it never read it)
 *   currentSha   the sha now
 *   netNew       this item creates a new page
 *   claimedBy    another in-flight item (draft/approved/in_pr) that holds this path, or null
 * @returns {{ ok: boolean, action: 'write'|'rebuild'|'block'|'unverified', reason: string|null }}
 */
export function decideWrite({ path, exists, readSha = null, currentSha = null, netNew = false, claimedBy = null }) {
  if (claimedBy) return { ok: false, action: 'block', reason: `"${path}" is already claimed by ${claimedBy.draftId != null ? `draft #${claimedBy.draftId}` : 'another item'} (${claimedBy.state}); this change would overwrite it.` };
  if (!exists) return { ok: true, action: 'write', reason: null };                        // a genuinely new file at a free path
  if (netNew) return { ok: false, action: 'block', reason: `"${path}" already exists on the base branch; a new page never replaces an existing file.` };
  if (!readSha) return { ok: true, action: 'unverified', reason: `"${path}" exists and this item has no record of reading it, so its base cannot be proven.` };
  if (readSha === currentSha) return { ok: true, action: 'write', reason: null };
  return { ok: false, action: 'rebuild', reason: `"${path}" changed on the base branch after this item read it (read ${String(readSha).slice(0, 7)}, now ${String(currentSha).slice(0, 7)}); the edit must be rebuilt from the current file.` };
}

/**
 * The gate. `files` = [{ path, content }]. `getSha(site, path, ref)` returns the blob sha or null; `entries` is the content index (for
 * claims by other in-flight items). Returns the pushDraftBranch gate shape: { ok: true, notes } or { ok: false, reason, error }.
 */
export async function validateNoBlindOverwrite(site, draft, files, { ref, batchRef = null, getSha, entries = [], mode = overwriteGuardMode(), readShaOf = readShaFor, record = null } = {}) {
  if (mode === 'off' || !Array.isArray(files) || !files.length) return { ok: true, notes: [] };
  const netNew = NET_NEW_ACTION_TYPES.has(draft?.action_type);
  const notes = []; const refusals = [];
  for (const f of files) {
    // Implementers read either from the base branch or from today's batch branch (to merge onto earlier items' edits). The comparison is made at the ref the
    // item actually read from: what it read there is what its edit was built on.
    let readRef = ref; let readSha = readShaOf(site.id, ref, f.path);
    if (!readSha && batchRef) { const b = readShaOf(site.id, batchRef, f.path); if (b) { readRef = batchRef; readSha = b; } }
    let currentSha = null;
    try { currentSha = await getSha(site, f.path, readRef); } catch (err) {
      // Cannot read the file: the guard cannot judge, and says so. Never a silent pass in enforce mode.
      const d = { ok: mode !== 'enforce', action: 'unverified', reason: `could not read "${f.path}" to compare it (${operatorDetail(err)})` };
      notes.push({ path: f.path, ...d }); if (!d.ok) refusals.push(d); continue;
    }
    const claimedBy = entries.find((e) => e.filePath === f.path && e.draftId != null && Number(e.draftId) !== Number(draft?.id) && ['draft', 'approved', 'in_pr'].includes(e.state)) || null;
    const d = decideWrite({ path: f.path, exists: currentSha != null, readSha, currentSha, netNew, claimedBy });
    notes.push({ path: f.path, ...d });
    if (!d.ok) refusals.push(d);
  }
  if (record) { try { await record(site.id, draft, notes); } catch { /* best effort */ } }
  const bad = refusals.filter((r) => r.action === 'block' || r.action === 'rebuild' || mode === 'enforce');
  if (!bad.length) return { ok: true, notes };
  if (mode === 'log') {
    console.warn(`[overwrite-guard] (log only) site ${site.id} draft ${draft?.id}: would refuse: ${bad.map((b) => b.reason).join(' | ')}`);
    return { ok: true, notes, wouldRefuse: bad.map((b) => b.reason) };
  }
  const rebuild = bad.every((b) => b.action === 'rebuild');
  return {
    ok: false, reason: rebuild ? 'file-changed-since-read' : 'overwrite-blocked', retryable: rebuild,
    error: `Nothing was written. ${bad.map((b) => b.reason).join(' ')}`,
  };
}
