// Is a pasted link the client's Google Business Profile? Same rules as the server (server/routes/lib/project-connect.js
// parseBusinessProfile), so the screen can say what is wrong BEFORE anything is saved.
//   'empty'   nothing typed
//   'ok'      a profile link (share.google, maps.app.goo.gl, g.page, google.com/maps/…, …)
//   'list'    Google's page listing ALL their profiles (business.google.com/locations): not one profile
//   'website' a link, but not Google (usually their own website)
//   'invalid' not a link at all
const HOST_RE = /^(www\.|maps\.)?google\.[a-z.]{2,6}$|^(maps\.app\.goo\.gl|goo\.gl|g\.page|g\.co|share\.google|business\.google\.com)$/i;

export function classifyProfileLink(raw) {
  const text = String(raw || '').trim();
  if (!text) return 'empty';
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`); } catch { return 'invalid'; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return 'invalid';
  const host = u.hostname.toLowerCase();
  if (host === 'business.google.com' && /^\/(locations|dashboard)?\/?$/i.test(u.pathname)) return 'list';
  if (!HOST_RE.test(host)) return 'website';
  if (/^(www\.)?google\.[a-z.]{2,6}$/i.test(host) && !/^\/maps(\/|$)/.test(u.pathname)) return 'website';
  return 'ok';
}

// What to tell the client about each answer.
export const PROFILE_LINK_HELP = {
  list: 'That is your list of profiles, not your profile link. On your business’s profile, click Share profile, then Copy link.',
  website: 'That is not your Google profile link (it looks like a website). On your business’s profile on Google, click Share profile, then Copy link.',
  invalid: 'That does not look like a link. On your business’s profile on Google, click Share profile, then Copy link, and paste it here.',
};
