// Pure, deterministic generator — no LLM call. There's nothing to ground:
// directive syntax is fixed, and the only real input is which headers the
// security-headers agent found missing on the live site. The implementer
// (server/implementers/backend.js) splices this block between a human-placed
// `# SEOAI:SECURITY-HEADERS:START/END` marker pair inside the site's real
// nginx server {} block — this generator never decides *where* it goes.

import { fetchResponseHeaders } from '../agents/lib/page-content.js';
import { siteOriginFor } from '../agents/lib/site-domain.js';

export const meta = {
  id: 'security-headers',
  name: 'Security Headers Generator',
  description: 'Drafts the nginx security-headers block for exactly the headers currently missing on the live site.',
  recommendationTags: [],
};

// `always` is deliberately added even though the company's own CI/CD master
// template (ci-cd-deployment-master-guide/templates/website/nginx/static.conf)
// omits it — without it, nginx drops add_header on error/redirect responses,
// which is exactly when a security header matters most.
//
// content-security-policy uses Report-Only: a wrong enforcing CSP can break
// every script/style on the site the instant a PR merges, and there's no
// universally-safe default policy. Report-Only logs violations without
// blocking anything, so it's safe to auto-draft; promoting it to enforcing
// is a deliberate follow-up a human makes after confirming the report shows
// no unexpected violations.
//
// strict-transport-security omits `preload` — submitting to the browser
// preload list is a one-way commitment (very hard to reverse), not something
// that should happen via an auto-drafted PR.
const DIRECTIVE_BY_KEY = {
  'x-frame-options': 'add_header X-Frame-Options "SAMEORIGIN" always;',
  'x-content-type-options': 'add_header X-Content-Type-Options "nosniff" always;',
  'referrer-policy': 'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
  'strict-transport-security': 'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
  'content-security-policy': 'add_header Content-Security-Policy-Report-Only "default-src \'self\'; report-uri /csp-report" always;',
};

const ALL_KEYS = Object.keys(DIRECTIVE_BY_KEY);

// params: { missingHeaders?: string[] } — the check keys the security-headers
// agent found absent. Falls back to the full set if absent/empty, since
// re-adding an already-present header via this bounded marker region is
// idempotent (nginx's last `add_header` for a name wins per-context), not
// harmful.
export async function generate({ params }) {
  const requested = Array.isArray(params?.missingHeaders) && params.missingHeaders.length
    ? params.missingHeaders.filter((key) => DIRECTIVE_BY_KEY[key])
    : ALL_KEYS;
  const headersIncluded = ALL_KEYS.filter((key) => requested.includes(key));

  const nginxBlock = headersIncluded.map((key) => DIRECTIVE_BY_KEY[key]).join('\n');

  return {
    content: { headersIncluded, nginxBlock, missingHeaders: params?.missingHeaders || [] },
    summary: `Security-headers nginx block for ${headersIncluded.length} missing header(s): ${headersIncluded.join(', ')}.`,
  };
}

// Side-effect-free re-verification (server/generators/lib/verification-layer.js).
// Headers are site-wide (nginx server {} block), so the site's own public
// origin is the checkable target — same fallback fix-verification.js's own
// RESPONSE_HEADER check already uses for this generator (`target = page ||
// siteOrigin`). already_resolved only once every header this recommendation
// named is now actually present in a live response — re-fetches rather than
// trusting the params captured at detection time.
export async function verifyCurrentState(rec, { site } = {}) {
  if (!site) return { decision: 'still_valid', reason: 'no-site-context', evidence: null };
  const target = rec.params?.page || rec.page || siteOriginFor(site);
  if (!target) return { decision: 'still_valid', reason: 'no-checkable-target', evidence: null };

  const wanted = Array.isArray(rec.params?.missingHeaders) && rec.params.missingHeaders.length
    ? rec.params.missingHeaders
    : ALL_KEYS;
  const res = await fetchResponseHeaders(target);
  if (!res.ok) return { decision: 'still_valid', reason: 'unreachable', evidence: { target, error: res.error } };

  const stillMissing = wanted.filter((name) => !res.headers.get(name));
  if (stillMissing.length === 0) {
    return { decision: 'already_resolved', reason: 'headers-already-present', evidence: { target, checked: wanted } };
  }
  return { decision: 'still_valid', reason: 'headers-still-missing', evidence: { target, stillMissing } };
}
