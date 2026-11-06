// PREPARE: generation and validation, with NOTHING approved, pushed or opened. The 11:00 ship run takes only what this marks
// prepared.
//
// One item, in order:
//   1. a page-level fix needs the site's design profile; without a usable one it waits for the Design Agent (queued for derivation,
//      released back to the queue, not prepared)
//   2. generateDraft      the generator, with its existing Quality Gate and bounded regeneration (unchanged)
//   3. submitDraftForApproval
//   4. validateDraft      every check approveAndPublishDraft runs before approval, extracted unchanged (Quality Gate, live responsive
//                         preview against the real page with its bounded repair loop, rendering gate, technical check with its
//                         bounded repair loop). Throws on any failure.
//   5. markPrepared       ONLY after all of the above passed
//
// FAILURE. A refused generation or failed validation is evidence about the work: the draft is abandoned (so its recommendation is
// visible again, never silently hidden) and the queue item fails. An outage-shaped error (GitHub, network, rate limit) is not
// evidence about the work: the item goes back to the queue (releaseItem retryable) for the next pass. Correction loops stay the
// existing bounded ones inside generateDraft and validateDraft; across passes the queue's own attempt count is the bound.

const OUTAGE = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|rate limit|secondary rate|5\d\d|GitHub App is not configured|timed out/i;
export const isOutage = (err) => err?.designPending === true || (OUTAGE.test(String(err?.message || err || '')) && !(err?.status >= 400 && err?.status < 500));

export async function prepareItem(site, item, deps) {
  const { generateDraft, submitDraftForApproval, validateDraft, markPrepared, releaseItem, abandonDraft, hasUsableDesignProfile, queueDesignDerivation } = deps;

  if (item.params?.page && !hasUsableDesignProfile(site)) {
    await queueDesignDerivation(site).catch(() => {});
    await releaseItem(item.id, { retryable: true, error: 'awaiting live design: no usable design profile yet' });
    return { itemId: item.id, outcome: 'awaiting-design' };
  }

  let draft = null;
  try {
    draft = await generateDraft(site.id, { generatorId: item.generator_id, params: item.params, source: item.source, findingId: item.finding_id, waitForDesignAgent: false });
    await submitDraftForApproval(site.id, draft.id);
    const { draft: validated } = await validateDraft(site.id, draft.id, {});
    const prepared = await markPrepared(item.id, { draftId: validated.id, filePaths: [], score: item.score ?? null });
    return { itemId: item.id, outcome: 'prepared', draftId: validated.id, prepared: Boolean(prepared) };
  } catch (err) {
    const outage = isOutage(err);
    if (draft && !outage) await abandonDraft(site.id, draft.id, `preparation failed: ${String(err.message || err).slice(0, 300)}`).catch(() => {});
    await releaseItem(item.id, { retryable: outage, error: String(err.message || err).slice(0, 500) });
    return { itemId: item.id, outcome: outage ? 'retry-later' : 'failed', error: String(err.message || err) };
  }
}

// One project's preparation pass: record today's candidates in the queue (deduplicated there), claim what is queued, prepare each
// until the deadline. Candidate SELECTION is injected: at cutover it must be the auto-remediation selection (lanes, budgets,
// pacing, breakers) so quotas are unchanged; this module owns only the order prepare -> validate -> markPrepared.
export async function prepareSite(site, { selectCandidates, enqueue, claimForPreparation, limit = 25, sources = null, deadlineAt = null, now = () => Date.now(), isAborted = () => false, ...deps }) {
  const candidates = await selectCandidates(site);
  for (const c of candidates) {
    await enqueue(site.id, { source: c.source || 'daily-pipeline', lane: c.lane || 'analytics', generatorId: c.generatorId, recommendationId: c.recommendationId ?? null, findingId: c.findingId ?? null, params: c.params || {}, score: c.score ?? null });
  }
  const claimed = await claimForPreparation(site.id, { limit, workerId: 'daily-pipeline', sources });
  const results = [];
  for (const item of claimed) {
    if (isAborted() || (deadlineAt != null && now() >= deadlineAt)) {
      // past the deadline: hand it straight back, untouched, for the next cycle
      await deps.releaseItem(item.id, { retryable: true, error: 'not prepared before the daily deadline' });
      results.push({ itemId: item.id, outcome: 'deferred' });
      continue;
    }
    results.push(await prepareItem(site, item, deps));
  }
  const count = (o) => results.filter((r) => r.outcome === o).length;
  return { candidates: candidates.length, claimed: claimed.length, prepared: count('prepared'), failed: count('failed'), retryLater: count('retry-later'), awaitingDesign: count('awaiting-design'), deferred: count('deferred'), results };
}
