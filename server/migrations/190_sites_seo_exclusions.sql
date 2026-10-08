-- Two explicit "leave this alone" lists for the GSC URL audit (see
-- server/agents/gsc-url-audit.js), both deliberately per-site columns rather
-- than hardcoded constants: the hosts and URLs involved are tenant facts, and
-- a constant in the repo would apply one tenant's decisions to every other.
--
-- WHY THESE ARE SEPARATE FROM additional_own_domains (migration 123)
--
-- additional_own_domains answers "is this page ours?" — it WIDENS the
-- own-domain filter so a hero product on its own subdomain gets counted and
-- worked on. These two columns answer the opposite question, "has someone
-- already decided we are deliberately not touching this?", and they NARROW
-- what becomes agent work. Collapsing them would make "this is ours" and
-- "leave this alone" the same flag, which is exactly wrong for a host like a
-- login-walled internal tool: it is unquestionably ours, and must never be
-- SEO work.
--
-- seo_ignored_hosts
--   Hostnames that are real, known, and permanently out of scope — an
--   unrelated client project on a subdomain of the same root domain, or an
--   internal admin tool. Distinct from "not ours" (which additional_own_domains
--   already handles by omission) in that it is a RECORDED decision: the audit
--   can report "27 URLs on a host nobody has triaged" without also re-reporting
--   every host somebody already looked at and consciously excluded. Without
--   this, the only way to silence a known-excluded host is to stop running the
--   audit, and a permanent alert nobody can clear is an alert everybody learns
--   to ignore.
--
-- seo_tombstoned_urls
--   URLs on the site's OWN domain that were intentionally deleted and must
--   stay 404. This one is load-bearing rather than cosmetic, because this
--   platform does not merely report: technical-seo.js emits a
--   missing-page-create action, and the Action Center can apply it as a real
--   PR. A deliberately removed page looks identical to an accidentally
--   deleted one from the outside — same 404, same inbound links, same GSC
--   impressions decaying — so without a recorded decision the system can
--   helpfully recreate a page somebody deliberately removed, and keep
--   recreating it after every manual revert. Compared on hostname + path with
--   the trailing slash normalised away, the same way sitemap-diff.js's
--   normalizeForCompare does, so '/x' and '/x/' are one decision and not two.
--
-- Both default to empty, so every existing site keeps today's behaviour until
-- a decision is actually recorded. Empty means "nothing excluded yet", never
-- "exclude everything" — the audit treats an empty list as a no-op filter.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS seo_ignored_hosts TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS seo_tombstoned_urls TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN sites.seo_ignored_hosts IS
  'Hostnames permanently out of SEO scope for this site (unrelated projects on a shared root domain, internal admin tools). A recorded exclusion decision, so the GSC URL audit can distinguish an untriaged host from one somebody already excluded on purpose. Narrows agent work; contrast additional_own_domains, which widens it.';

COMMENT ON COLUMN sites.seo_tombstoned_urls IS
  'URLs on this site''s own domain that were intentionally deleted and must stay 404. Stops the missing-page-create generator recreating a deliberately removed page, which from the outside is indistinguishable from an accidental deletion. Compared on hostname + path with the trailing slash normalised away.';
