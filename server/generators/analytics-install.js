// Pure, deterministic generator — no LLM call, nothing to ground beyond the
// two real inputs: which provider (trust-compliance.js's own tracker
// detection already tells us GA4/Facebook Pixel is genuinely absent) and the
// site's own real GA4 measurement ID / Pixel ID. That ID can never be
// invented (same no-fabrication rule as every other generator here) — if the
// caller doesn't already have it, the draft ships with a PLACEHOLDER_NOTE
// and placeholderFields, same contract as open-graph.js/schema.js: blocked
// from auto-publish until a human edits the draft with the site's real ID.
// The implementer (server/implementers/backend.js) splices the resulting
// <script> block into <head> via the head-scoped marker mechanism
// (server/implementers/lib/marker-merge.js's HEAD_SCOPED_FIELDS).

export const meta = {
  id: 'analytics-install',
  name: 'Analytics/Pixel Install Script Generator',
  description: 'Drafts the Google Analytics (GA4) or Meta/Facebook Pixel install script for a site missing it, using the site\'s own real tracking ID.',
  recommendationTags: [],
};

const PLACEHOLDER_NOTE = '[NEEDS INPUT — not verifiable from real site data]';

const PROVIDERS = {
  ga4: {
    label: 'Google Analytics (GA4)',
    idPattern: /^G-[A-Z0-9]+$/i,
    idHint: 'a GA4 measurement ID (e.g. "G-XXXXXXXXXX")',
    script: (id) => `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n<script>\n  window.dataLayer = window.dataLayer || [];\n  function gtag(){dataLayer.push(arguments);}\n  gtag('js', new Date());\n  gtag('config', '${id}');\n</script>`,
  },
  'facebook-pixel': {
    label: 'Meta/Facebook Pixel',
    idPattern: /^\d{10,20}$/,
    idHint: 'a Facebook Pixel ID (a numeric ID, e.g. "123456789012345")',
    script: (id) => `<script>\n  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?\n  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;\n  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;\n  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,\n  document,'script','https://connect.facebook.net/en_US/fbevents.js');\n  fbq('init', '${id}');\n  fbq('track', 'PageView');\n</script>`,
  },
};

// params: { provider: 'ga4' | 'facebook-pixel', trackingId?: string, page?: string }
export async function generate({ params }) {
  const { provider, trackingId, page } = params || {};
  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) throw Object.assign(new Error(`provider must be one of: ${Object.keys(PROVIDERS).join(', ')}`), { status: 400 });

  const idValid = typeof trackingId === 'string' && providerConfig.idPattern.test(trackingId.trim());
  const resolvedId = idValid ? trackingId.trim() : PLACEHOLDER_NOTE;
  const placeholderFields = idValid ? [] : ['trackingId'];

  const script = idValid
    ? providerConfig.script(resolvedId)
    : `<!-- ${PLACEHOLDER_NOTE}: replace with ${providerConfig.idHint} before publishing -->`;

  return {
    content: { provider, page: page || null, trackingId: resolvedId, script, placeholderFields },
    summary: `${providerConfig.label} install script${idValid ? '' : ' (needs real tracking ID before it can publish)'}`,
  };
}
