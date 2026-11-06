// The ONE definition of "which project is eligible, and where is it in its life". Shared by the Agent Factory, the Master Agent and
// the admin instance view, so they cannot disagree about whether a project is running.
//
// isSchedulable mirrors job.js listConnectedSites (a test pins that they stay equal): an active project is scheduled when it is a
// product, or has both Search Console and Analytics connected.

export const LIFECYCLE = Object.freeze(['requested', 'provisioning', 'connecting', 'baselining', 'active', 'paused', 'offboarding', 'removed']);

export function isSchedulable(site) {
  if (!site || site.status !== 'active') return false;
  if (site.property_type === 'product') return true;
  return Boolean(site.gsc_property && site.ga4_property_id);
}

// Pure. What the project's lifecycle IS, from the site row alone (the stored value is a record of the last reconcile, not the truth).
export function deriveLifecycle(site) {
  if (!site) return 'removed';
  if (site.status === 'soft_deleted') return 'removed';
  if (site.status && site.status !== 'active') return 'paused';
  const connected = site.property_type === 'product' || Boolean(site.gsc_property && site.ga4_property_id);
  if (!connected) return 'connecting';
  if (!site.onboarded_at && site.property_type !== 'product') return 'baselining';
  return 'active';
}
