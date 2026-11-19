// Hreflang validation. Static rules read the tags on this page; the network rules use `hreflangProbe`
// (fetchPage.js), which fetched up to 6 alternates once each. Without a probe only the static rules run.
const LANG_CODE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

function norm(u) {
  try { const x = new URL(u); x.hash = ''; return x.toString().replace(/\/$/, ''); } catch { return null; }
}

export default function hreflang({ $, finalUrl, hreflangProbe }) {
  const tags = $('link[rel="alternate"][hreflang]');

  if (tags.length === 0) {
    return {
      id: 'hreflang',
      title: 'Hreflang Usage',
      category: 'seo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'No hreflang tags found (not applicable for single-language sites).',
      recommendation: 'If you serve multiple languages/regions, add hreflang tags to indicate alternate versions.',
    };
  }

  const list = hreflangProbe?.tags || tags.map((_, el) => {
    const raw = ($(el).attr('href') || '').trim();
    return { lang: ($(el).attr('hreflang') || '').trim(), raw, href: raw, absolute: /^https?:\/\//i.test(raw) };
  }).get();

  const errors = [];
  const warnings = [];

  const badCodes = list.filter((t) => !LANG_CODE.test(t.lang)).map((t) => t.lang || '(empty)');
  if (badCodes.length) errors.push(`invalid language/region code${badCodes.length > 1 ? 's' : ''}: ${[...new Set(badCodes)].slice(0, 4).join(', ')}`);

  const byLang = new Map();
  for (const t of list) {
    const k = t.lang.toLowerCase();
    byLang.set(k, new Set([...(byLang.get(k) || []), norm(t.href) || t.raw]));
  }
  const conflicting = [...byLang].filter(([, urls]) => urls.size > 1).map(([l]) => l);
  const sameValueTwice = list.length !== new Set(list.map((t) => `${t.lang.toLowerCase()}|${norm(t.href) || t.raw}`)).size;
  if (conflicting.length) errors.push(`the same code points at different URLs: ${conflicting.slice(0, 4).join(', ')}`);
  else if (sameValueTwice) errors.push('duplicate hreflang values');

  const relative = list.filter((t) => !t.absolute);
  if (relative.length) errors.push(`${relative.length} hreflang URL${relative.length > 1 ? 's are' : ' is'} not fully qualified (use https://...)`);

  const me = norm(finalUrl);
  if (me && !list.some((t) => norm(t.href) === me)) errors.push('this page does not list itself (self-referencing hreflang is required)');

  if (!list.some((t) => t.lang.toLowerCase() === 'x-default')) warnings.push('no x-default fallback');

  let probeNote = '';
  if (hreflangProbe) {
    const probed = hreflangProbe.probed || [];
    const noBack = probed.filter((p) => p.returnsLink === false).map((p) => p.lang);
    const unreachable = probed.filter((p) => !p.error && p.status >= 400).map((p) => `${p.lang} (${p.status})`);
    const redirected = probed.filter((p) => p.redirectedTo).map((p) => p.lang);
    const noindexed = probed.filter((p) => p.noindex).map((p) => p.lang);
    const canonElsewhere = probed.filter((p) => p.canonicalElsewhere).map((p) => p.lang);
    if (noBack.length) errors.push(`no return link from: ${noBack.slice(0, 4).join(', ')} (hreflang must be reciprocal or Google ignores it)`);
    if (unreachable.length) errors.push(`alternate returns an error: ${unreachable.slice(0, 4).join(', ')}`);
    if (redirected.length) errors.push(`alternate redirects instead of serving the page: ${redirected.slice(0, 4).join(', ')}`);
    if (noindexed.length) errors.push(`alternate is noindex: ${noindexed.slice(0, 4).join(', ')}`);
    if (canonElsewhere.length) errors.push(`alternate's canonical points to another URL: ${canonElsewhere.slice(0, 4).join(', ')}`);
    const unchecked = probed.filter((p) => p.error).length;
    probeNote = ` Checked ${probed.length - unchecked} alternate page${probed.length - unchecked === 1 ? '' : 's'}${hreflangProbe.capped ? ' (first 6 only)' : ''}${unchecked ? `; ${unchecked} could not be fetched` : ''}.`;
  }

  const bad = errors.length;
  return {
    id: 'hreflang',
    title: 'Hreflang Usage',
    category: 'seo',
    passed: bad === 0,
    score: bad === 0 ? 3 : bad <= 2 ? 1 : 0,
    maxScore: 3,
    message: bad === 0
      ? `${list.length} hreflang tag(s), valid, self-referencing and reciprocal.${warnings.length ? ` Note: ${warnings.join('; ')}.` : ''}${probeNote}`
      : `Hreflang problems: ${errors.join('; ')}.${warnings.length ? ` Also: ${warnings.join('; ')}.` : ''}${probeNote}`,
    recommendation: bad === 0
      ? (warnings.length ? 'Consider adding an x-default hreflang for visitors whose language you do not serve.' : 'No action needed.')
      : 'Fix the listed hreflang problems: every language version must list itself and all others with full URLs, each alternate must link back, and alternates must be indexable, not redirect, and be canonical to themselves.',
  };
};
