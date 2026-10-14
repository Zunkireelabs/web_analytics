// Multi-tenant SEO growth rule (2026-09-10): every generator must first
// understand THIS tenant's own business/industry before steering topic or
// subtopic choice — dynamically, per site_id, never a hardcoded assumption
// about any one tenant. Two real sources, most specific wins:
//   1. site_seo_policy.target_industries_json — an explicit owner-set list
//      (e.g. Zunkiree's own Education/Healthcare/Real Estate/Hospitality/
//      Agencies rule, see 155_site_seo_policy.sql). Optional per site.
//   2. site_profiles.industry — inferred generically for every tenant from
//      that tenant's own real GSC queries (agents/clustering.py / migration
//      080), already dynamic and already excludes nothing tenant-specific.
// Returns null (not a fabricated guess) when neither source has data for
// this site — callers must then skip the industry steer, not invent one.
export function tenantIndustries(seoPolicy, siteProfile) {
  if (seoPolicy?.target_industries?.length) return seoPolicy.target_industries;
  if (siteProfile?.industry) return [String(siteProfile.industry).trim()].filter(Boolean);
  return null;
}
