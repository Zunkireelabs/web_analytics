// Known crawler tokens used by AI answer engines / LLM training and browsing bots.
// Source: each vendor's published crawler documentation (robots.txt user-agent tokens).
//
// `citationRelevant: false` marks bots whose ONLY documented purpose is
// training a model on a dataset — they never fetch a page to answer a live
// user question, so blocking one has no bearing on whether THIS site's
// pages can actually be cited in a real AI answer. Deliberately excluded
// from the pass/fail determination below (still reported if blocked, just
// not penalized) — confirmed as a real false-negative in practice: a site
// whose robots.txt correctly Allow's every real answer-engine crawler
// while disallowing only Bytespider (a common, even recommended, choice)
// was still failing this check outright before this distinction existed.
const AI_CRAWLERS = [
  { token: 'GPTBot', vendor: 'OpenAI', purpose: 'trains OpenAI models', citationRelevant: true },
  { token: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'fetches pages a user asks ChatGPT to browse', citationRelevant: true },
  { token: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'powers ChatGPT search results/citations', citationRelevant: true },
  { token: 'ClaudeBot', vendor: 'Anthropic', purpose: 'trains Claude models', citationRelevant: true },
  { token: 'Claude-User', vendor: 'Anthropic', purpose: 'fetches pages a user asks Claude to browse', citationRelevant: true },
  { token: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'powers Claude search/citations', citationRelevant: true },
  { token: 'anthropic-ai', vendor: 'Anthropic', purpose: 'legacy Anthropic crawler token', citationRelevant: true },
  { token: 'PerplexityBot', vendor: 'Perplexity', purpose: 'powers Perplexity answers/citations', citationRelevant: true },
  { token: 'Perplexity-User', vendor: 'Perplexity', purpose: 'fetches pages a user asks Perplexity to browse', citationRelevant: true },
  { token: 'Google-Extended', vendor: 'Google', purpose: 'trains Gemini / feeds AI Overviews', citationRelevant: true },
  { token: 'CCBot', vendor: 'Common Crawl', purpose: 'dataset widely used to train LLMs', citationRelevant: false },
  { token: 'Bytespider', vendor: 'ByteDance', purpose: 'trains ByteDance/TikTok LLMs', citationRelevant: false },
  { token: 'Amazonbot', vendor: 'Amazon', purpose: 'trains Amazon/Alexa AI', citationRelevant: false },
  { token: 'Applebot-Extended', vendor: 'Apple', purpose: 'trains Apple Intelligence', citationRelevant: true },
  { token: 'meta-externalagent', vendor: 'Meta', purpose: 'trains Meta AI models', citationRelevant: false },
];

// Groups consecutive "User-agent:" lines that share the rules which follow them,
// per the robots.txt grouping rules (RFC 9309).
function parseGroups(content) {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);

  const groups = [];
  let current = null;
  let sawRuleSinceAgent = false;

  for (const line of lines) {
    const agentMatch = line.match(/^user-agent:\s*(.*)$/i);
    if (agentMatch) {
      if (!current || sawRuleSinceAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRuleSinceAgent = false;
      }
      current.agents.push(agentMatch[1].trim().toLowerCase());
      continue;
    }

    if (!current) continue;

    const disallowMatch = line.match(/^disallow:\s*(.*)$/i);
    if (disallowMatch) {
      current.rules.push({ type: 'disallow', path: disallowMatch[1].trim() });
      sawRuleSinceAgent = true;
      continue;
    }

    const allowMatch = line.match(/^allow:\s*(.*)$/i);
    if (allowMatch) {
      current.rules.push({ type: 'allow', path: allowMatch[1].trim() });
      sawRuleSinceAgent = true;
    }
  }

  return groups;
}

// Per RFC 9309: the most specific matching user-agent group applies; if a bot has
// no dedicated group, the wildcard ("*") group applies to it instead.
function resolveGroupFor(groups, botTokenLower) {
  const specific = groups.find((g) => g.agents.includes(botTokenLower));
  if (specific) return specific;
  return groups.find((g) => g.agents.includes('*')) || null;
}

function isBlockedEntirely(group) {
  if (!group) return false;
  return group.rules.some((r) => r.type === 'disallow' && r.path === '/');
}

export default function aiCrawlerAccess({ robotsTxt }) {
  if (robotsTxt.present !== true || !robotsTxt.content) {
    const noRobotsFile = robotsTxt.present === false;
    return {
      id: 'ai-crawler-access',
      title: 'AI Crawler Access (robots.txt)',
      category: 'aeo',
      passed: noRobotsFile ? true : null,
      score: noRobotsFile ? 5 : 0,
      maxScore: robotsTxt.present === null ? 0 : 5,
      message: noRobotsFile
        ? 'No robots.txt file found, so no AI crawlers are blocked by it.'
        : 'Could not verify robots.txt, so AI crawler access could not be checked.',
      recommendation: 'No action needed.',
    };
  }

  const groups = parseGroups(robotsTxt.content);
  const blocked = [];

  for (const bot of AI_CRAWLERS) {
    const group = resolveGroupFor(groups, bot.token.toLowerCase());
    if (isBlockedEntirely(group)) blocked.push(bot);
  }

  // Only a blocked CITATION-RELEVANT crawler fails this check — blocking a
  // training-only bot (CCBot, Bytespider, Amazonbot, meta-externalagent) is
  // a normal, even recommended, choice that doesn't affect whether this
  // site's pages can be cited in a live AI answer, and is reported
  // separately below rather than counted against the score.
  const blockedCitationRelevant = blocked.filter((b) => b.citationRelevant);
  const blockedTrainingOnly = blocked.filter((b) => !b.citationRelevant);
  const pass = blockedCitationRelevant.length === 0;

  const trainingOnlyNote = blockedTrainingOnly.length
    ? ` (also blocks ${blockedTrainingOnly.map((b) => b.token).join(', ')} — training-data-only, no effect on live citation, not penalized.)`
    : '';

  return {
    id: 'ai-crawler-access',
    title: 'AI Crawler Access (robots.txt)',
    category: 'aeo',
    passed: pass,
    score: pass ? 5 : 0,
    maxScore: 5,
    message: pass
      ? `robots.txt does not block any of the ${AI_CRAWLERS.filter((b) => b.citationRelevant).length} live-citation-relevant AI crawlers checked (e.g. GPTBot, ClaudeBot, PerplexityBot, Google-Extended).${trainingOnlyNote}`
      : `robots.txt blocks ${blockedCitationRelevant.length} AI crawler${blockedCitationRelevant.length > 1 ? 's' : ''} relevant to live citation via "Disallow: /": ${blockedCitationRelevant
          .map((b) => `${b.token} (${b.vendor} — ${b.purpose})`)
          .join(', ')}.${trainingOnlyNote}`,
    recommendation: pass
      ? 'No action needed.'
      : `Remove the "Disallow: /" rule(s) for ${blockedCitationRelevant
          .map((b) => b.token)
          .join(', ')} in robots.txt if you want your content crawled, cited, or answered by AI engines.`,
  };
};
