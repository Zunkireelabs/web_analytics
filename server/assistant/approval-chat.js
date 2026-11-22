// Approving in conversation. The person says what they think in their own words; this reads the intent conservatively and the assistant
// either acts (a clear "go ahead" about ONE open pull request), answers, or asks. It never guesses an approval:
//   approve   a clear yes, with no doubt, condition, question or negation in it
//   decline   a clear "not yet / don't / hold / stop / cancel"
//   unclear   anything else that is about the pull request (a question, "ok but…", a change request) -> the assistant asks or answers
//   none      nothing to do with approving (normal conversation continues)
// Deterministic on purpose: an approval merges code into a client's staging branch, so "the model felt it was a yes" is not enough.

const YES = /\b(ok(ay)?|approved?|approve it|lgtm|looks? (good|fine|great|right)|go ahead|go for it|ship it|merge( it| them| that| this)?|yes|yep|yeah|sure|do it|proceed|all good|sounds good|fine by me|good to go|perfect)\b|👍|✅/i;
const NO = /\b(don'?t|do not|dont|wait|hold( on| off| it)?|not yet|no\b|stop|cancel|never ?mind|leave it|skip|not (ok|okay|good|ready|sure))\b/i;
const DOUBT = /\b(but|however|except|unless|only if|before|first|instead|actually|change|fix|wrong|issue|problem|concern|worried|what|why|how|which|when|who|can you|could you|is it|are you sure|not sure|maybe|probably)\b|\?/i;

export function classifyApproval(message) {
  const t = String(message || '').trim();
  if (!t || t.length > 200) return 'none';
  if (NO.test(t)) return 'decline';
  const yes = YES.test(t);
  if (yes && !DOUBT.test(t)) return 'approve';
  if (yes) return 'unclear';
  // Not an approval, but plainly about the waiting change ("is it safe?", "what does it change?") -> answer or ask, never merge.
  return /\b(pull request|pr|merge|merged|stage|staging|safe|change|changes|changed|diff|ready|review)\b|#\d+/i.test(t) ? 'unclear' : 'none';
}

// Which pending pull request does the message mean? Names one ("#12", "pr 12"), or there is exactly one open, or the message says "all".
export function pickPullRequests(message, pending) {
  const nums = pending.map((p) => p.prNumber);
  const named = [...String(message).matchAll(/(?:#|\bpr\s*|pull request\s*)(\d+)/gi)].map((m) => Number(m[1])).filter((n) => nums.includes(n));
  if (named.length) return { prs: [...new Set(named)] };
  if (nums.length === 1) return { prs: nums };
  if (/\b(all|both|every|everything|all of them|each)\b/i.test(message)) return { prs: nums };
  return { prs: [], ambiguous: nums };
}
