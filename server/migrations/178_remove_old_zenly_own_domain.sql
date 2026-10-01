-- zenly.zunkireelabs.com now permanently redirects (308) to zennly.io, the
-- product's own domain. It was registered as one of zunkireelabs's
-- additional_own_domains (migration 123) back when the booking product was
-- hosted on that subdomain; the filter exists so a `sc-domain:` Search
-- Console property counts that subdomain's pages as the site's own. With the
-- redirect in place no page lives there any more, and the product's traffic
-- belongs to zennly.io — a separate site — so keeping the entry would only
-- leave a dead hostname in zunkireelabs's own-domain set.
--
-- Guarded and idempotent: it only touches a site whose array actually
-- contains that exact hostname, removes only that one element, and is a no-op
-- everywhere else and on every re-run. Previously ingested rows are not
-- touched — this narrows the filter going forward, it deletes no history.
UPDATE sites
   SET additional_own_domains = array_remove(additional_own_domains, 'zenly.zunkireelabs.com')
 WHERE 'zenly.zunkireelabs.com' = ANY(additional_own_domains);
