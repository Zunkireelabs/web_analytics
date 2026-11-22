import { resolveFile } from './url-file-map.js';
import { urlInScope } from '../../agents/lib/site-scope.js';

// A page this site may set markers up for: inside its path scope and mapped to a repo file. Null otherwise.
export function pageInScopeAndMapped(site, page) {
  if (!urlInScope(site, page)) return null;
  const file = resolveFile(site, page);
  return file ? { page, file } : null;
}
