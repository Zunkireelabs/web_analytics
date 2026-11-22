import { runMarkerSetup, markerSetupEnabled } from './marker-setup.js';
import { getSiteById, getSearchPerformanceRange } from '../../store/read.js';
import { getFileContent, getBranchSha, createBranch, commitFilesAtomic, openPullRequest, listOpenPullRequestsForBranch } from '../../github/client.js';
import { ownDomains, filterOwnDomainPages, siteOriginFor } from '../../agents/lib/site-domain.js';
import { filterByScope } from '../../agents/lib/site-scope.js';
import { MARKER_MERGE_TYPES } from '../backend.js';

// The real-world wiring of the markers-only setup PR (marker-setup.js): which pages, which GitHub calls. Used by the CLI script and by
// the baseline route. Pages = the site's own top Search Console pages (inside its path scope) plus every page it has mapped in
// url_file_map.pages, so a page with no traffic yet still gets its template's markers.
const PAGE_LIMIT = 300;

export async function listSetupPages(site) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const gsc = site.gsc_property
    ? filterByScope(filterOwnDomainPages(await getSearchPerformanceRange(site.id, start, end, 'page', PAGE_LIMIT), ownDomains(site)), site).map((p) => p.dim_value)
    : [];
  const origin = siteOriginFor(site);
  const mapped = origin ? Object.keys(site.url_file_map?.pages || {}).map((path) => { try { return new URL(path, origin).href; } catch { return null; } }).filter(Boolean) : [];
  return [...new Set([...gsc, ...mapped])];
}

export async function setupMarkersForSite(siteOrId, { open = false } = {}) {
  const site = typeof siteOrId === 'object' ? siteOrId : await getSiteById(siteOrId);
  if (!site) return { status: 'no-site' };
  if (!markerSetupEnabled(site)) return { status: 'disabled' };
  return runMarkerSetup(site, {
    pages: await listSetupPages(site),
    markerTypes: [...MARKER_MERGE_TYPES],
    getFile: getFileContent,
    getBranchSha,
    createBranch,
    commitFiles: commitFilesAtomic,
    openPr: openPullRequest,
    findOpenPr: async (s, branch) => (await listOpenPullRequestsForBranch(s, branch))[0] || null,
    open,
  });
}
