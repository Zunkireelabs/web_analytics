// Where the app lives, for links that are EMAILED or handed to a browser later (confirm your email,
// the staff review link). Built from APP_BASE_URL when it is set, otherwise from the address the request
// arrived on.
//
// The setting matters whenever the app sits behind something that rewrites the address it sees: a
// reverse proxy in production, or the dev server on a laptop (which makes the API see its own port, so
// a link built from the request would open the API instead of the app). Set it to the public address,
// e.g. https://app.superrank.si, with no trailing slash.
export function appOrigin(req) {
  const fixed = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  return fixed || `${req.protocol}://${req.get('host')}`;
}
