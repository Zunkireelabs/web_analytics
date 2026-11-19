// The AI crawlers this feature recognises, from each vendor's own documentation (read 2026-11-18).
//
//   kind  training = collects pages that may train models | search = builds an AI search index | user = fetches a page
//         because a person asked an assistant | other = generic or site-owner-requested crawl
//   list  which published IP list proves a visit is really that vendor's (see verify.js LIST_URLS); null = the vendor
//         publishes none, so a visit can be counted but never marked verified.
//
// Not here on purpose: Google-Extended and Applebot-Extended. Both vendors document them as robots.txt switches only:
// they never send a request, so they can never appear in an access log. Googlebot IS listed, but flagged `ai: false`: it is
// ordinary search crawling, kept for reference and left out of the AI totals.
//
// The Meta entries come from user agents seen in real logs (2026-11-18), not from a Meta page read for this feature,
// so treat them as observed rather than vendor-confirmed.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A product token inside a user-agent string: not part of a longer name ("GPTBot-test", "NotGPTBot") and not a URL
// slug. Matching the user-agent FIELD only (parse-log.js) is what keeps a blog post titled "...-gptbot-claudebot-..." from
// counting as a visit, which inflated a first whole-line count 8x on real logs.
const token = (name) => new RegExp(`(?:^|[^a-z0-9-])${escapeRe(name)}(?![a-z0-9-])`, 'i');

// `ai: false` marks a crawler that is NOT an AI crawler (Googlebot: ordinary search). It is recognised, verified and stored like
// the others so it can be shown for reference, but the dashboard keeps it out of the "AI crawler visits" totals, where its
// volume (thousands a day) would drown every real AI number.
const bot = (id, label, vendor, kind, name, list, ai = true) => ({ id, label, vendor, kind, list, ai, pattern: token(name) });

export const BOTS = Object.freeze([
  bot('gptbot', 'GPTBot', 'OpenAI', 'training', 'GPTBot', 'openai-gptbot'),
  bot('oai-searchbot', 'OAI-SearchBot', 'OpenAI', 'search', 'OAI-SearchBot', 'openai-searchbot'),
  bot('chatgpt-user', 'ChatGPT-User', 'OpenAI', 'user', 'ChatGPT-User', 'openai-chatgpt-user'),

  bot('claudebot', 'ClaudeBot', 'Anthropic', 'training', 'ClaudeBot', 'anthropic'),
  bot('claude-searchbot', 'Claude-SearchBot', 'Anthropic', 'search', 'Claude-SearchBot', 'anthropic'),
  bot('claude-user', 'Claude-User', 'Anthropic', 'user', 'Claude-User', 'anthropic'),

  bot('perplexitybot', 'PerplexityBot', 'Perplexity', 'search', 'PerplexityBot', 'perplexity-bot'),
  bot('perplexity-user', 'Perplexity-User', 'Perplexity', 'user', 'Perplexity-User', 'perplexity-user'),

  // Google: AI use cannot be told apart from search for Googlebot, so only the AI-specific agents are listed.
  bot('google-cloudvertexbot', 'Google-CloudVertexBot', 'Google', 'other', 'Google-CloudVertexBot', 'google-common'),
  bot('googleother', 'GoogleOther', 'Google', 'other', 'GoogleOther', 'google-common'),
  bot('google-agent', 'Google-Agent', 'Google', 'user', 'Google-Agent', 'google-user-triggered-agents'),
  // Googlebot: Google's ordinary search crawler. Not an AI crawler, shown for reference only (ai: false). Googlebot-Image, -Video and
  // -News are separate tokens and are not matched here.
  bot('googlebot', 'Googlebot', 'Google', 'search', 'Googlebot', 'google-common', false),

  bot('applebot', 'Applebot', 'Apple', 'search', 'Applebot', 'apple'),

  bot('bytespider', 'Bytespider', 'ByteDance', 'training', 'Bytespider', null),

  bot('meta-externalagent', 'meta-externalagent', 'Meta', 'training', 'meta-externalagent', null),
  bot('meta-externalfetcher', 'meta-externalfetcher', 'Meta', 'user', 'meta-externalfetcher', null),
  bot('meta-webindexer', 'meta-webindexer', 'Meta', 'search', 'meta-webindexer', null),
]);

// Our own agents hit our own sites (the opportunity agent fetching pages). They are not an AI engine reading the site, so
// they are recognised only to be left out of every count.
const OWN_AGENTS = [token('ZunkireeAnalyticsBot')];

const BY_ID = new Map(BOTS.map((b) => [b.id, b]));
export const botById = (id) => BY_ID.get(id) || null;

/**
 * Classify one user-agent string.
 *   null                 not an AI crawler we track
 *   { own: true }        one of our own agents: never counted
 *   { bot }              a tracked crawler (the entry from BOTS)
 */
export function classifyUserAgent(ua) {
  const s = String(ua ?? '');
  if (!s || s === '-') return null;
  if (OWN_AGENTS.some((re) => re.test(s))) return { own: true };
  const hit = BOTS.find((b) => b.pattern.test(s));
  return hit ? { bot: hit } : null;
}
