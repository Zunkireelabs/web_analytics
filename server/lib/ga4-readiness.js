// Where a project's GA4 actually is, in the five states a person needs to tell apart. "Analytics connected" alone meant only the
// first one, which is how three projects looked ready while their sites carried no tracking tag at all.
//
//   not-connected            no GA4 property is connected: nothing can be read and nothing can be installed
//   reporting-connected      the property is connected (reports can be read) but its measurement ID (G-...) is not known yet
//   measurement-id-known     the ID is known; no install has been attempted or merged yet            -> "installation pending"
//   installed-not-verified   an install change was merged but its live check has not passed yet
//   installation-verified    a live check found the exact tracking ID on the site
//
// Pure: callers pass what they already hold. `install` is the latest analytics-install verification outcome for the project, or null.
import { isMeasurementId, isPropertyId } from './ga4-measurement-id.js';

export const GA4_STATE = Object.freeze({
  NOT_CONNECTED: 'not-connected',
  REPORTING_CONNECTED: 'reporting-connected',
  INSTALLATION_PENDING: 'installation-pending',
  INSTALLED_NOT_VERIFIED: 'installed-not-verified',
  INSTALLATION_VERIFIED: 'installation-verified',
});

export function ga4Readiness(site, install = null) {
  const propertyConnected = isPropertyId(site?.ga4_property_id);
  const measurementIdKnown = isMeasurementId(site?.ga4_measurement_id);
  const base = { propertyConnected, measurementIdKnown };
  if (!propertyConnected && !measurementIdKnown) return { ...base, state: GA4_STATE.NOT_CONNECTED, label: 'GA4 not connected', needs: 'Connect this project\'s Google Analytics property.' };
  if (!measurementIdKnown) return { ...base, state: GA4_STATE.REPORTING_CONNECTED, label: 'GA4 reporting connected, measurement ID missing', needs: 'The measurement ID (G-…) is not stored. SuperRank looks it up from the connected property; if it cannot be found it asks for exactly what is missing.' };
  if (install === 'verified-fixed') return { ...base, state: GA4_STATE.INSTALLATION_VERIFIED, label: 'GA4 installation verified', needs: null };
  if (install === 'pending' || install === 'awaiting-deployment' || install === 'unreachable') return { ...base, state: GA4_STATE.INSTALLED_NOT_VERIFIED, label: 'GA4 installed, not yet verified', needs: null };
  return { ...base, state: GA4_STATE.INSTALLATION_PENDING, label: 'GA4 installation pending', needs: null };
}
