// Pure, deterministic generator — same shape as security-headers.js: there's
// nothing to ground with an LLM, the gzip/brotli directive syntax is fixed,
// and the only real input is which of this site's own checked pages the
// technical-seo agent found being served uncompressed. The implementer
// (server/implementers/backend.js) splices this block between a human-placed
// `# SEOAI:COMPRESSION:START/END` marker pair inside the site's real nginx
// server {} block — this generator never decides *where* it goes, same
// division of responsibility as security-headers.js/generators/security-headers.js.

export const meta = {
  id: 'compression-nginx',
  name: 'Response Compression Generator',
  description: 'Drafts the nginx block that enables gzip (and brotli, when the module is available) response compression for a site currently serving pages uncompressed.',
  recommendationTags: [],
};

// gzip_comp_level 5 is nginx's own commonly-recommended middle ground
// between CPU cost and size reduction — not maxed to 9, which spends
// meaningfully more CPU per request for very little extra size once a
// response is already gzip-compressed. gzip_min_length skips compressing
// responses too small to benefit. The MIME list covers the types that
// actually dominate page weight (html/css/js/json/svg/fonts); binary
// image/video formats are deliberately excluded — they're already
// compressed and re-compressing them wastes CPU for no size win.
//
// brotli directives are appended unconditionally, guarded by nginx's own
// `if (unknown directive)` startup failure being exactly what this platform
// cannot detect ahead of time (no way to run a real `nginx -t` here, see
// hash-marker-merge.js). They're wrapped in the same idempotent block a
// human onboarding this marker is told (action-center-onboarding skill) to
// only place inside a server {} block that has ngx_brotli compiled in —
// same trust boundary as the marker itself, not something this generator
// can verify.
const GZIP_BLOCK = [
  'gzip on;',
  'gzip_vary on;',
  'gzip_comp_level 5;',
  'gzip_min_length 256;',
  'gzip_proxied any;',
  'gzip_types text/plain text/css text/xml text/javascript application/javascript application/json application/xml application/rss+xml image/svg+xml font/woff2 font/woff;',
].join('\n');

const BROTLI_BLOCK = [
  'brotli on;',
  'brotli_comp_level 5;',
  'brotli_types text/plain text/css text/xml text/javascript application/javascript application/json application/xml application/rss+xml image/svg+xml font/woff2 font/woff;',
].join('\n');

// params: { includeBrotli?: boolean } — defaults true (brotli is strictly
// additive alongside gzip: a browser that doesn't send `br` in
// Accept-Encoding simply gets gzip, same as today), but left overridable
// for a site onboarding that has confirmed ngx_brotli isn't compiled into
// its nginx build.
export async function generate({ params } = {}) {
  const includeBrotli = params?.includeBrotli !== false;
  const nginxBlock = includeBrotli ? `${GZIP_BLOCK}\n${BROTLI_BLOCK}` : GZIP_BLOCK;

  return {
    content: { includeBrotli, nginxBlock },
    summary: includeBrotli
      ? 'Enable gzip + Brotli response compression.'
      : 'Enable gzip response compression.',
  };
}
