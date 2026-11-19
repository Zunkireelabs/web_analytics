// robots.txt evaluation per RFC 9309 (the Robots Exclusion Protocol).
//
// What the older per-check parsers got wrong, and this gets right:
//   - Allow rules count. "Disallow: /" + "Allow: /" is open, not closed.
//   - The longest (most specific) matching rule wins; on a tie, Allow wins.
//   - "*" and "$" work inside rule paths.
//   - Every group that names a bot applies to it together, not just the first one.
//   - A bot with no group of its own falls back to the "*" group.

export function parseRobotsGroups(content) {
  const lines = String(content || '')
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

    const ruleMatch = line.match(/^(allow|disallow):\s*(.*)$/i);
    if (ruleMatch) {
      current.rules.push({ type: ruleMatch[1].toLowerCase(), path: ruleMatch[2].trim() });
      sawRuleSinceAgent = true;
    }
  }
  return groups;
}

// The rules that apply to one bot: all groups naming it, else all "*" groups.
export function rulesFor(groups, botToken) {
  const token = String(botToken).toLowerCase();
  const named = groups.filter((g) => g.agents.includes(token));
  const applicable = named.length ? named : groups.filter((g) => g.agents.includes('*'));
  return { rules: applicable.flatMap((g) => g.rules), viaWildcard: named.length === 0 && applicable.length > 0, hasGroup: applicable.length > 0 };
}

// Does one rule path match the URL path? Supports "*" and a trailing "$".
function ruleMatches(rulePath, urlPath) {
  if (rulePath === '') return false; // "Disallow:" with no path blocks nothing
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(urlPath);
}

// { allowed, rule } for one bot on one path.
export function evaluateAccess(groups, botToken, urlPath = '/') {
  const { rules, viaWildcard, hasGroup } = rulesFor(groups, botToken);
  let best = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.path, urlPath)) continue;
    const len = rule.path.length;
    if (!best || len > best.len || (len === best.len && rule.type === 'allow' && best.type === 'disallow')) {
      best = { type: rule.type, path: rule.path, len };
    }
  }
  return {
    allowed: !best || best.type === 'allow',
    rule: best ? { type: best.type, path: best.path } : null,
    viaWildcard,
    hasGroup,
  };
}

// Disallow rules that restrict part of the site (not the homepage) for this bot, e.g. "/blog/".
export function partialRestrictions(groups, botToken) {
  const { rules } = rulesFor(groups, botToken);
  return rules
    .filter((r) => r.type === 'disallow' && r.path && r.path !== '/' && r.path !== '/*')
    .map((r) => r.path);
}
