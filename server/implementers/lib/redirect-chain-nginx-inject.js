// Collapses a multi-hop nginx redirect down to a single hop, when the
// intermediate hop is defined as an exact, unambiguous rule in the site's
// own tracked nginx config (site.url_file_map.siteRoot.nginxConfig — the
// same file security-headers.js/soft-404-inject.js already patch). Same
// "exact-match-or-refuse, never guess" discipline as soft-404-inject.js:
// if the source path isn't found as exactly one of the two recognized
// redirect-rule shapes, or its current target doesn't match what the real
// observed hop said, this refuses rather than editing a config it can't
// be sure it understood. Which system owns a chain's intermediate hop
// varies wildly by tenant (nginx, a CDN, a CMS, DNS) — this only ever
// claims the nginx case, and only when it's provably this exact shape.
//
// Two recognized shapes, the two standard ways nginx expresses "redirect
// this exact path":
//   location = /old-path/ { return 301 /mid-path/; }
//   rewrite ^/old-path/?$ /mid-path/ permanent;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findLocationReturnRule(content, sourcePath) {
  const escaped = escapeRegExp(sourcePath);
  // location = <path> { ... return <code> <target>; ... } — non-greedy body,
  // no nested braces assumed (a redirect-only location block never needs
  // one), matching soft-404-inject.js's own "no need to handle arbitrary
  // nesting" scope.
  const re = new RegExp(`(location\\s*=\\s*${escaped}\\s*\\{[^{}]*?return\\s+(301|302)\\s+)([^\\s;]+)(\\s*;[^{}]*\\})`, 'g');
  return { re, kind: 'location-return' };
}

function findRewriteRule(content, sourcePath) {
  const escaped = escapeRegExp(sourcePath);
  // nginx `rewrite` directives write their source as a REGEX, not a literal
  // path (e.g. `^/old-path/?$`) — [^\s]* after the literal path tolerates
  // whatever regex syntax (`/?`, `$`, …) the site wrote around it, rather
  // than trying to parse nginx's own regex dialect.
  const re = new RegExp(`(rewrite\\s+\\^?${escaped}[^\\s]*\\s+)([^\\s;]+)(\\s+(?:permanent|redirect)\\s*;)`, 'g');
  return { re, kind: 'rewrite' };
}

// Returns the single matching rule's {kind, target, match} across both
// shapes, or a refusal reason if zero or more than one match was found
// (across BOTH shapes combined — a source path should only ever be handled
// one way).
function locateRule(content, sourcePath) {
  const candidates = [findLocationReturnRule(content, sourcePath), findRewriteRule(content, sourcePath)];
  const matches = [];
  for (const { re, kind } of candidates) {
    let m;
    // eslint has no opinion here; this file has no lint config of its own
    // to satisfy — a plain while-exec loop over a global regex.
    while ((m = re.exec(content)) !== null) {
      matches.push({ kind, target: kind === 'location-return' ? m[3] : m[2], index: m.index, fullMatch: m[0], groups: m });
    }
  }
  if (matches.length === 0) return { ok: false, reason: 'no-match' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous-match' };
  return { ok: true, rule: matches[0] };
}

// currentHopTarget: the actual next hop this platform OBSERVED via a real
// redirect walk (agents/redirect-chain.js) — the patch only proceeds if the
// live config's target still matches that observation, otherwise the
// config has changed since detection and this refuses rather than
// overwriting a possibly-already-fixed or now-different rule.
export function patchRedirectChain(content, sourcePath, currentHopTarget, finalTarget) {
  const located = locateRule(content, sourcePath);
  if (!located.ok) {
    return {
      ok: false,
      reason: located.reason,
      error: located.reason === 'ambiguous-match'
        ? `Found more than one redirect rule for "${sourcePath}" — refusing to guess which one is the real chain.`
        : `Could not find an exact "location = ${sourcePath} { return ...; }" or "rewrite ${sourcePath} ...;" rule for this path — the redirect may be defined elsewhere (a CDN, a CMS, DNS), which this platform can't see or edit.`,
    };
  }

  const { rule } = located;
  const normalizedTarget = rule.target.replace(/\/+$/, '') || '/';
  const normalizedObserved = String(currentHopTarget).replace(/\/+$/, '') || '/';
  if (normalizedTarget !== normalizedObserved) {
    return {
      ok: false, reason: 'stale',
      error: `The live rule for "${sourcePath}" now points at "${rule.target}", not "${currentHopTarget}" this platform observed — the config has changed since detection.`,
    };
  }
  if (normalizedTarget === String(finalTarget).replace(/\/+$/, '')) {
    return { ok: false, reason: 'already-resolved', error: `"${sourcePath}" already points directly at the final destination — nothing left to collapse.` };
  }

  const m = rule.groups;
  const before = m[0];
  const after = rule.kind === 'location-return' ? `${m[1]}${finalTarget}${m[4]}` : `${m[1]}${finalTarget}${m[3]}`;
  const newContent = content.slice(0, m.index) + after + content.slice(m.index + before.length);

  return { ok: true, newContent, before, after, rule: rule.kind };
}
