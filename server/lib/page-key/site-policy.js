import { establishEquivalence } from './equivalence.js';

// What a site itself says about its URLs, from evidence only (redirects and canonical tags), never from a guess:
//   www            'bare' | 'www' | 'distinct' | 'unknown'   which host the other redirects to
//   scheme         'https' | 'distinct' | 'unknown'
//   trailingSlash  'add' | 'strip' | 'distinct' | 'unknown'  decided per site because sites disagree (one adds it, one strips it)
// The canonical page key may fold variants together only along a dimension whose value is not 'distinct' or 'unknown', and always
// INTO the form the site redirects to.
export async function deriveSiteUrlPolicy({ domain, samplePages = [] }, { fetchPage }) {
  const policy = { domain, www: 'unknown', scheme: 'unknown', trailingSlash: 'unknown', evidence: [] };
  const note = (dimension, r) => policy.evidence.push({ dimension, equivalent: r.equivalent, basis: r.basis, detail: r.detail, finalA: r.evidence?.finalA, finalB: r.evidence?.finalB });

  const w = await establishEquivalence(`https://www.${domain}/`, `https://${domain}/`, { fetchPage }); note('www', w);
  if (w.equivalent) policy.www = String(w.evidence.finalA || '').includes('://www.') ? 'www' : 'bare';
  else if (w.evidence.finalA && w.evidence.finalB) policy.www = 'distinct';

  const sch = await establishEquivalence(`http://${domain}/`, `https://${domain}/`, { fetchPage }); note('scheme', sch);
  if (sch.equivalent) policy.scheme = 'https';
  else if (sch.evidence.finalA && sch.evidence.finalB) policy.scheme = 'distinct';

  // trailing slash: test the sample pages; every tested page must agree, or the site is 'distinct'
  const verdicts = [];
  for (const page of samplePages.slice(0, 3)) {
    let u; try { u = new URL(page); } catch { continue; }
    if (u.pathname === '/') continue;
    const bare = u.pathname.replace(/\/+$/, '');
    const a = `${u.origin}${bare}/${u.search}`; const b = `${u.origin}${bare}${u.search}`;
    const r = await establishEquivalence(a, b, { fetchPage }); note('trailingSlash', r);
    if (!r.equivalent) { verdicts.push(r.evidence.finalA && r.evidence.finalB ? 'distinct' : 'unknown'); continue; }
    const final = String(r.evidence.finalA || r.evidence.finalB || '');
    verdicts.push(new URL(final).pathname.endsWith('/') ? 'add' : 'strip');
  }
  if (verdicts.length) policy.trailingSlash = verdicts.every((v) => v === verdicts[0]) ? verdicts[0] : 'distinct';
  return policy;
}
