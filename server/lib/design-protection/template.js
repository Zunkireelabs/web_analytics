// WHICH TEMPLATE IS THIS PAGE? Design is judged against the page's OWN template, never against "a blog" in general and never against another client.
// Identity comes from the Design Agent's layout survey (profile.layoutGroups: pages grouped by the template they really share). A page the survey did not
// group falls back to its captured page type plus its first path segment; a page with neither has NO template, and no baseline can be assumed for it.
import { layoutGroupFor } from '../../design-agent/lib/layout-groups.js';

const pathOf = (url) => { try { return new URL(url, 'https://placeholder.invalid').pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '') || '/'; } catch { return null; } };
const firstSegment = (url) => (pathOf(url) || '').split('/').filter(Boolean)[0] || '';

/**
 * Pure. @returns {{key:string, source:'layout-group'|'page-type', sampleUrl:string|null, memberUrls:string[]} | null}
 * `pageType` is optional (the caller's classification of the page); without a layout group and without a type there is no template.
 */
export function templateKeyFor(profile, pageUrl, { pageType = null } = {}) {
  if (!pageUrl) return null;
  const group = layoutGroupFor(profile, pageUrl);
  if (group) {
    const members = (group.members || []).filter(Boolean);
    const id = group.id ?? group.key ?? pathOf(group.sample) ?? members[0];
    return { key: `group:${id}`, source: 'layout-group', sampleUrl: group.sample || members[0] || null, memberUrls: members };
  }
  const captured = (profile?.pages || []).find((p) => pathOf(p.url) === pathOf(pageUrl));
  const type = captured?.pageType || pageType;
  if (!type) return null;
  const seg = firstSegment(pageUrl);
  const peers = (profile?.pages || []).filter((p) => p.pageType === type && firstSegment(p.url) === seg).map((p) => p.url);
  return { key: `type:${type}:${seg || '/'}`, source: 'page-type', sampleUrl: peers[0] || null, memberUrls: peers };
}

/** Pure. Up to `max` live pages of the SAME template to measure, the page being changed excluded. Never a page of another template. */
export function referencePagesFor(template, { excludeUrl = null, max = 3 } = {}) {
  if (!template) return [];
  const seen = new Set(); const out = [];
  for (const u of [template.sampleUrl, ...(template.memberUrls || [])]) {
    const p = u && pathOf(u);
    if (!p || seen.has(p) || (excludeUrl && p === pathOf(excludeUrl))) continue;
    seen.add(p); out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Pure. Remove the content of platform-written marker blocks (<!-- SEOAI:NAME:START --> ... <!-- SEOAI:NAME:END -->) from HTML.
 * Their typography came from our own previous output, so measuring it as "what the site looks like" taught the baseline the platform's own mistakes
 * (2026-11-25: Zunkiree's baseline held Tailwind classes from earlier SEOAI:FAQ blocks). The markers themselves stay.
 */
export function stripPlatformMarkers(html) {
  return String(html ?? '').replace(/(<!--\s*SEOAI:([A-Z0-9_-]+):START\s*-->)[\s\S]*?(<!--\s*SEOAI:\2:END\s*-->)/gi, '$1$3');
}

/** Pure. The live pages (as the profile knows them: paths or URLs) that make up a template key's baseline sample. Inverse of templateKeyFor. */
export function urlsForTemplateKey(profile, key, { max = 3 } = {}) {
  const k = String(key || '');
  if (k.startsWith('group:')) {
    const id = k.slice(6);
    const g = (profile?.layoutGroups?.groups || []).find((x) => String(x.id ?? x.key ?? pathOf(x.sample) ?? x.members?.[0]) === id);
    return g ? referencePagesFor({ sampleUrl: g.sample, memberUrls: g.members }, { max }) : [];
  }
  const m = k.match(/^type:([^:]+):(.*)$/);
  if (!m) return [];
  const seg = m[2] === '/' ? '' : m[2];
  const peers = (profile?.pages || []).filter((p) => p.pageType === m[1] && firstSegment(p.url) === seg).map((p) => p.url);
  return referencePagesFor({ sampleUrl: peers[0], memberUrls: peers }, { max });
}

/** Pure. Make profile paths absolute against the project's own live origin. Another origin's URL is dropped, never fetched. */
export function absoluteUrls(urls, origin) {
  if (!origin) return [];
  const out = [];
  for (const u of urls || []) {
    try { const abs = new URL(u, origin); if (abs.origin === new URL(origin).origin) out.push(abs.href); } catch { /* unusable */ }
  }
  return out;
}
