// Is a blog topic already covered by the site? Uses the same deterministic coverage check the nightly job closes satisfied ideas with
// (keyword-coverage-service.js classifyGapCoverage: no model call, nothing persisted). A topic a person asked for by name
// (params.clientRequested) is never closed on the platform's own judgement of coverage. The check's `classify` is injectable so this
// stays testable without the database or the AI SDKs.
export async function verifyBlogTopic(rec, { site } = {}, classify = null, indexLoader = null) {
  const topic = rec.params?.topic;
  const siteId = site?.id ?? rec.site_id;
  if (!topic || !siteId || rec.params?.clientRequested === true) return { decision: 'still_valid', reason: 'not-checkable', evidence: null };
  const run = classify || (await import('../../agents/lib/keyword-coverage-service.js')).classifyGapCoverage;
  const v = await run(siteId, { topic }, { allowLLM: false, persist: false });
  if (['covered', 'duplicate'].includes(v?.status) && v.url) {
    return { decision: 'already_resolved', reason: 'topic-already-covered', evidence: { topic, coveredBy: v.url, coverage: v.status } };
  }
  // The content index (lib/content-index) sees what page coverage cannot: the same topic already being made. A draft awaiting approval, an approved
  // draft, an open pull request or merged content is the same work; writing it again is exactly the duplicate this check exists to prevent.
  // Best effort: an unreadable index never blocks (the coverage check above still ran), it is just not consulted.
  try {
    const { getFreshContentIndex } = await import('../../lib/content-index/store.js');
    const { checkTopicAgainstIndex } = await import('../../lib/content-index/check.js');
    const { entries } = await (indexLoader || getFreshContentIndex)(siteId);
    const hit = checkTopicAgainstIndex({ topic, entries });
    if (!hit.ok) return { decision: 'already_resolved', reason: 'topic-already-in-content-index', evidence: { topic, indexReason: hit.reason, matches: hit.matches.slice(0, 3) } };
  } catch { /* the index is a second opinion, never a requirement */ }
  return { decision: 'still_valid', reason: 'topic-not-covered', evidence: { topic, coverage: v?.status ?? null } };
}
