// Business-relevance verdicts for a batch of topics, from THIS client's own profile. A thin wrapper over agents/lib/topic-relevance.js
// (validateTopics), which already makes the decision in code from five criteria and never accepts on keyword overlap alone. Heavy imports are lazy
// (the same reason topic-queue.js gives): this module must stay importable by tests that mock the stores partially.

/**
 * @returns {Promise<Map<string, {verdict, reasons, anchors, criteria, source}>>} keyed by the topic text as given.
 * `validate` and `loadContext` are injectable. Any failure means every topic is 'unknown' (held), never accepted.
 */
export async function judgeRelevance(siteId, topics, { validate = null, loadContext = null } = {}) {
  const list = [...new Set((topics || []).map((t) => String(t || '').trim()).filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;
  try {
    const ctx = await (loadContext || (async (id) => (await import('../tenant-context.js')).loadBusinessContext(id, { agent: 'content' })))(siteId);
    const run = validate || (await import('../../agents/lib/topic-relevance.js')).validateTopics;
    const verdicts = await run(list, ctx, { siteId });
    for (const v of verdicts) out.set(v.topic, v);
  } catch (err) {
    console.error(`[blog-cycle] site ${siteId}: relevance could not be judged (${err.message}); topics are held, not accepted`);
  }
  for (const t of list) if (!out.has(t)) out.set(t, { topic: t, verdict: 'unknown', reasons: ['relevance could not be judged'], anchors: [], source: 'unavailable' });
  return out;
}
