-- Adds the outcome autoHealFileMapping now reports for a URL on a
-- registered NON-PRIMARY own-domain (e.g. edgex.zunkireelabs.com, when the
-- site's primary website_domain is zunkireelabs.com) — see
-- url-file-map.js's resolveHostScope. Distinct from 'foreign-domain' (a
-- hostname the site never registered as its own at all, still refused
-- outright) and from 'ambiguous' (real evidence existed but conflicted):
-- this is neither — the repo evidence-gathering tiers (filename/sibling/
-- directory-index/permalink) are only trustworthy for the site's PRIMARY
-- hostname, since they cannot tell which hostname a shared repo's routes
-- are meant to serve on a multi-domain site. A non-primary hostname's pages
-- resolve ONLY via an explicit url_file_map.hosts[hostname] entry, never
-- auto-discovered.
ALTER TABLE capability_repairs DROP CONSTRAINT IF EXISTS capability_repairs_outcome_check;
ALTER TABLE capability_repairs ADD CONSTRAINT capability_repairs_outcome_check
  CHECK (outcome IN ('repaired', 'ambiguous', 'foreign-domain', 'not-found', 'requires-explicit-host-config'));
