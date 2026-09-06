-- recommendationPageKey (server/agents/lib/recommendation-coordinator.js) now
-- keys content-integrity-repair recommendations by {page, fixType}, not page
-- alone — a page can have more than one independent defect (visual-quality.js,
-- new in this same change), and without fixType in the key a second distinct
-- defect on the same page would collide onto one row. Every row already
-- carries its own real fixType in `params` (the exact value that produced it),
-- so this backfills the SAME real fact already on each row — never invents
-- one. Without this, the next detection run that re-finds an existing
-- pre-migration row's defect would compute the new key, fail to match the
-- old-format `page` value, insert a duplicate, AND incorrectly mark the
-- original row 'superseded' (closeStaleRecommendations reads "not in this
-- run's detected keys" as "no longer found" — a false negative here, not a
-- real resolution). Idempotent: the `NOT LIKE` guard means re-running this
-- migration (or applying it to a database where some rows already got a
-- fresh, already-suffixed page from a later detection run) changes nothing.
UPDATE recommendations
   SET page = page || '::' || (params->>'fixType')
 WHERE recommendation_type = 'content-integrity-repair'
   AND params->>'fixType' IS NOT NULL
   AND page NOT LIKE '%::' || (params->>'fixType');
