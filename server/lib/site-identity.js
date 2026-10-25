// Guards the one way this instance's `.env` can silently orphan a client's
// entire history.
//
// getOrCreateSite() (server/db.js) finds its site row by the PAIR
// (gsc_property, ga4_property_id) and inserts a new one when that pair
// doesn't match. Both identifiers come straight from `.env`, so editing
// either one turns a lookup miss into an INSERT: a second site row for the
// same real website, with a new id and no history. Every snapshot, finding,
// draft and report stays attached to the old id while the pipeline writes
// to the new one, so the dashboard reads a site that looks brand new —
// years of data apparently gone, with nothing logged and no error.
//
// This is not hypothetical: switching a property from a domain-level
// `sc-domain:example.com` to the URL-prefix `https://example.com/` (the
// normal fix for a domain property that reports foreign subdomains) changes
// GSC_PROPERTY and nothing else, which is exactly the shape that triggers it.
//
// The right tool for that switch is updateSiteConnection({ siteId, ... }),
// which UPDATEs the existing row in place and keeps its id — so this helper
// exists to turn a silent fork into a loud error that names that path.

// An identifier is only evidence of "same site" when it's actually set.
// createClientSite() inserts rows with gsc_property and ga4_property_id
// both NULL (they're attached later via updateSiteConnection), and two
// such rows must never be treated as the same site as each other, or as a
// match for a configured property.
function sameIdentifier(a, b) {
  return Boolean(a) && Boolean(b) && a === b;
}

// Does an existing site row look like THIS site under a changed property?
//
// Deliberately matches on EITHER identifier rather than requiring both: the
// dangerous case is precisely the one where the two no longer agree, so
// requiring agreement would skip every row worth refusing over. A genuinely
// different client shares neither identifier (verified against the live
// rows: three sites, no overlap on either column), so this can't fire on a
// legitimate second tenant.
export function findSiteIdentityConflict({ gscProperty, ga4PropertyId, rows }) {
  for (const row of rows || []) {
    const gscMatches = sameIdentifier(row.gsc_property, gscProperty);
    const ga4Matches = sameIdentifier(row.ga4_property_id, ga4PropertyId);
    // Both match => it IS the configured row; getOrCreateSite returns it
    // before ever reaching this check. Neither match => unrelated site.
    // Exactly one match => same site, one identifier rewritten in .env.
    if (gscMatches !== ga4Matches) {
      return {
        site: row,
        matchedOn: ga4Matches ? 'ga4_property_id' : 'gsc_property',
        changed: ga4Matches ? 'gsc_property' : 'ga4_property_id',
      };
    }
  }
  return null;
}

// Phrased to be actionable from a cron log with no other context: which row,
// what changed, and the exact command that does it safely. Values are echoed
// because both are non-secret identifiers already present in `.env`.
export function siteIdentityConflictMessage(conflict, { gscProperty, ga4PropertyId }) {
  const { site, matchedOn, changed } = conflict;
  const configured = changed === 'gsc_property' ? gscProperty : ga4PropertyId;
  return [
    `Refusing to create a second site row for what looks like site ${site.id} (${site.name}).`,
    `Matched the existing row on ${matchedOn}, but ${changed} differs:`,
    `  existing: ${site[changed] ?? '(unset)'}`,
    `  .env:     ${configured}`,
    'Creating a new row here would leave every existing snapshot, finding, draft and',
    `report attached to site ${site.id} while the pipeline wrote to a new, empty site.`,
    '',
    'If this change is intended, update the existing row in place instead so its id',
    'and all its history are preserved:',
    `  node server/scripts/connect-site.js --site-id ${site.id} \\`,
    `    --${changed === 'gsc_property' ? 'gsc-property' : 'ga4-property-id'} '${configured}'`,
    '',
    'If it was not intended, restore the previous value in .env.',
  ].join('\n');
}
