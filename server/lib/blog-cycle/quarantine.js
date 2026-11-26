// QUARANTINE WITH THE CONTENT KEPT. When an article fails its checks after the bounded repairs, what was written is NOT thrown away: it is stored in the
// topic decision log (origin 'quarantine') with the exact issues, so a person or a later repair pass can start from it instead of paying for a
// new generation, and the day's record can say which article was blocked and why. The other articles are never affected.
import { recordTopicDecision, listQuarantinedArticles } from '../topic-research/decision-log.js';

const MAX_CONTENT_CHARS = 120_000;

/** Best effort, never throws. Returns the log row id or null. */
export async function quarantineArticle(siteId, { topic, content, issues = [], attempts = null, recommendationId = null, reason = null }, opts = {}) {
  const text = JSON.stringify(content ?? null);
  const keep = text.length <= MAX_CONTENT_CHARS ? content : { truncated: true, title: content?.title ?? null, chars: text.length, sections: (content?.sections || []).slice(0, 3) };
  return recordTopicDecision(siteId, {
    topic, decision: 'deferred', origin: 'quarantine',
    gates: issues.map((i) => ({ gate: i.patternId || 'issue', ok: false, detail: i.detail || '', blocking: i.blocking !== false })),
    evidence: { quarantined: true, reason: reason || 'failed article validation after repair attempts', attempts, content: keep },
    enforced: true, recommendationId,
  }, opts);
}

export { listQuarantinedArticles };
