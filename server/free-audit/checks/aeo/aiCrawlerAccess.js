import { parseRobotsGroups, evaluateAccess, partialRestrictions } from '../../robotsAccess.js';

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
  { token: 'GPTBot', vendor: 'OpenAI', purpose: 'trains OpenAI models (ChatGPT search uses OAI-SearchBot)', citationRelevant: false },
  { token: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'fetches pages a user asks ChatGPT to browse', citationRelevant: true },
  { token: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'powers ChatGPT search results/citations', citationRelevant: true },
  { token: 'ClaudeBot', vendor: 'Anthropic', purpose: 'trains Claude models (answers use Claude-User / Claude-SearchBot)', citationRelevant: false },
  { token: 'Claude-User', vendor: 'Anthropic', purpose: 'fetches pages a user asks Claude to browse', citationRelevant: true },
  { token: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'powers Claude search/citations', citationRelevant: true },
  { token: 'anthropic-ai', vendor: 'Anthropic', purpose: 'legacy Anthropic training crawler token', citationRelevant: false },
  { token: 'PerplexityBot', vendor: 'Perplexity', purpose: 'powers Perplexity answers/citations', citationRelevant: true },
  { token: 'Perplexity-User', vendor: 'Perplexity', purpose: 'fetches pages a user asks Perplexity to browse', citationRelevant: true },
  { token: 'Google-Extended', vendor: 'Google', purpose: 'Gemini training and grounding (does not affect Google Search or AI Overviews)', citationRelevant: true },
  { token: 'CCBot', vendor: 'Common Crawl', purpose: 'dataset widely used to train LLMs', citationRelevant: false },
  { token: 'Bytespider', vendor: 'ByteDance', purpose: 'trains ByteDance/TikTok LLMs', citationRelevant: false },
  { token: 'Amazonbot', vendor: 'Amazon', purpose: 'trains Amazon/Alexa AI', citationRelevant: false },
  { token: 'Applebot-Extended', vendor: 'Apple', purpose: 'trains Apple Intelligence (opt-out only; does not affect Siri/Spotlight answers)', citationRelevant: false },
  { token: 'meta-externalagent', vendor: 'Meta', purpose: 'trains Meta AI models', citationRelevant: false },
];

function robotsVerdict({ robotsTxt }) {
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

  const groups = parseRobotsGroups(robotsTxt.content);
  const blocked = [];
  const partial = [];

  for (const bot of AI_CRAWLERS) {
    // RFC 9309: longest matching rule wins, Allow wins a tie, "*" fallback, all groups for the bot merge.
    const verdict = evaluateAccess(groups, bot.token, '/');
    if (!verdict.allowed) {
      blocked.push({ ...bot, viaWildcard: verdict.viaWildcard });
    } else if (bot.citationRelevant) {
      const paths = partialRestrictions(groups, bot.token);
      if (paths.length) partial.push({ token: bot.token, paths });
    }
  }

  // Only a blocked CITATION-RELEVANT crawler fails this check — blocking a
  // training-only bot (CCBot, Bytespider, Amazonbot, meta-externalagent) is
  // a normal, even recommended, choice that doesn't affect whether this
  // site's pages can be cited in a live AI answer, and is reported
  // separately below rather than counted against the score.
  const blockedCitationRelevant = blocked.filter((b) => b.citationRelevant);
  const blockedTrainingOnly = blocked.filter((b) => !b.citationRelevant);
  const pass = blockedCitationRelevant.length === 0;
  const wildcardNote = blockedCitationRelevant.some((b) => b.viaWildcard)
    ? ' Some are blocked only because the "User-agent: *" group disallows everything and the bot has no group of its own.'
    : '';
  const partialNote = partial.length
    ? ` Note: parts of the site are closed to ${[...new Set(partial.map((p) => p.token))].slice(0, 3).join(', ')}${partial.length > 3 ? ' and others' : ''} (${[...new Set(partial.flatMap((p) => p.paths))].slice(0, 3).join(', ')}) — not penalized, but those pages cannot be cited.`
    : '';

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
      ? `robots.txt does not block any of the ${AI_CRAWLERS.filter((b) => b.citationRelevant).length} live-citation-relevant AI crawlers checked (e.g. ChatGPT-User, OAI-SearchBot, Claude-SearchBot, PerplexityBot).${trainingOnlyNote}${partialNote}`
      : `robots.txt blocks ${blockedCitationRelevant.length} AI crawler${blockedCitationRelevant.length > 1 ? 's' : ''} relevant to live citation: ${blockedCitationRelevant
          .map((b) => `${b.token} (${b.vendor} — ${b.purpose})`)
          .join(', ')}.${wildcardNote}${trainingOnlyNote}${partialNote}`,
    recommendation: pass
      ? 'No action needed.'
      : `Add an "Allow: /" group (or remove the site-wide Disallow) for ${blockedCitationRelevant
          .map((b) => b.token)
          .join(', ')} in robots.txt if you want your content crawled, cited, or answered by AI engines.`,
  };
};


// robots.txt says what the site asks bots to do; the probe shows what the network edge (CDN/WAF) actually does.
// Advisory: it never changes pass/score, because a request from our server is not from the vendor's own IP range
// and a WAF that verifies bots by IP can block the probe while letting the real bot in.
export default function aiCrawlerAccess(pageData) {
  const result = robotsVerdict(pageData);
  const probe = pageData.botProbe;
  if (!probe || !probe.checked) return result;
  const base = result.message;
  const blocked = probe.bots.filter((b) => b.blocked);
  if (!blocked.length) {
    return { ...result, message: `${base} A live request using each of ${probe.bots.map((b) => b.token).join(', ')} user-agents was served normally (no firewall/CDN block seen).` };
  }
  const names = blocked.map((b) => `${b.token} (${b.challenged ? 'challenge page' : `status code ${b.status}`})`).join(', ');
  return {
    ...result,
    message: `${base} Firewall/CDN signal: a live request using the ${names} user-agent${blocked.length > 1 ? 's were' : ' was'} blocked while a normal request was served. Not scored, because a real bot comes from the vendor's own IP range and may be let through.`,
    recommendation: result.passed
      ? `Check your CDN/WAF (Cloudflare bot fight mode, security plugins) allows ${blocked.map((b) => b.token).join(', ')}; robots.txt allows them but the network edge may not.`
      : result.recommendation,
  };
};
