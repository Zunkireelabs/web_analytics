// WHERE a visible fix is judged. The platform renders a draft into a real page of the client's site before it ships (style-fidelity-gate.js). That has always been the
// LIVE page. But a client with a stage branch gets visible fixes on the stage site first (lib/pr-routing.js), and the stage site can carry design the live site does not
// have yet: MOBILISE's FAQ band, the new blog layout and their CSS exist only on dev-web.mobilise.agency until stage is promoted. Judged on the live page, a block that
// matches the stage design could only look "unstyled", and a block built for the live page would be judged against a design the PR is not going to land in.
//
// So, when the site records its stage site (url_file_map.siteRoot.stageUrl) and routes visible fixes through a stage branch, the SAME path on the stage site is used,
// if it answers. Anything else (no stage URL, no stage branch, the page is not on stage, stage is down) falls back to the live page: the check never gets weaker for it.
export function stageBranchOf(site) {
  const stage = String(site?.pr_target_branch || '').trim();
  const prod = String(site?.repo_default_branch || 'main').trim();
  return stage && stage !== prod ? stage : null;
}

const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

/**
 * @returns {Promise<{ url: string, source: 'stage'|'live', reason?: string }>}
 */
export async function resolveStylePageUrl(site, pageUrl, { fetchFn = fetch, timeoutMs = 8000 } = {}) {
  const live = { url: pageUrl, source: 'live' };
  const stageUrl = site?.url_file_map?.siteRoot?.stageUrl;
  if (!stageUrl || !stageBranchOf(site)) return { ...live, reason: 'no-stage-site' };
  const stageOrigin = originOf(stageUrl);
  if (!stageOrigin) return { ...live, reason: 'stage-url-invalid' };
  let u; try { u = new URL(pageUrl); } catch { return { ...live, reason: 'page-url-invalid' }; }
  if (u.origin === stageOrigin) return { url: pageUrl, source: 'stage' };
  const candidate = `${stageOrigin}${u.pathname}${u.search}`;
  try {
    const res = await fetchFn(candidate, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (res && res.status < 400) return { url: candidate, source: 'stage' };
    return { ...live, reason: `not-on-stage (${res?.status})` };
  } catch (err) {
    return { ...live, reason: `stage-unreachable (${String(err.message || err).slice(0, 60)})` };
  }
}
