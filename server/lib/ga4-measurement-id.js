// GA4 has TWO identifiers that are routinely confused:
//   property ID     a number ("561094281"): connects SuperRank to the property so it can READ reports.
//   measurement ID  "G-XXXXXXXXXX": the tag ID that must be written into the website to COLLECT data.
// A connected property therefore says nothing about whether a tag is installed or whether the measurement ID is known.
//
// This module finds the measurement ID through the already-connected property: the property's WEB DATA STREAM carries it
// (webStreamData.measurementId). It never invents an ID and never creates a stream: the platform credential only holds the
// read-only analytics scope, and creating a stream is a change to the client's Google account that needs their authorisation.
//
// Result statuses (what the caller should do):
//   present            the site already stores a well-formed ID; nothing to do
//   found              a stream matching the site's own domain gave an ID (saved when `save` is true)
//   no-property        no GA4 property is connected: the client must connect one
//   no-web-stream      the property has no web stream: someone with edit access must create one (we cannot with read-only access)
//   ambiguous          web streams exist but none is provably this site's: a person must pick; we never guess
//   permission-denied  the credential cannot read the property's streams: the client must grant access
//   unavailable        a temporary failure (network, quota): try again later, not a client problem
import { google } from 'googleapis';
import { getGoogleAuth } from '../auth/google.js';
import { updateSiteAnalyticsIds } from '../db.js';

export const MEASUREMENT_ID_RE = /^G-[A-Z0-9]{4,}$/i;
export const isMeasurementId = (v) => typeof v === 'string' && MEASUREMENT_ID_RE.test(v.trim());
// The property ID is all digits; a value that is not is never a usable property reference.
export const isPropertyId = (v) => /^\d+$/.test(String(v ?? '').trim());

const bare = (v) => String(v || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^sc-domain:/, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');

function failureStatus(err) {
  const code = Number(err?.code ?? err?.status ?? err?.response?.status);
  if (code === 401 || code === 403) return 'permission-denied';
  if (code === 404) return 'no-property'; // the stored property id does not exist for this credential
  return 'unavailable';
}

/**
 * @param {object} site    row from `sites`
 * @param {object} [deps]  { admin } injectable Analytics Admin client (tests)
 * @returns {Promise<{status:string, measurementId?:string, streams?:object[], detail?:string}>}
 */
export async function discoverMeasurementId(site, { admin = null } = {}) {
  if (isMeasurementId(site?.ga4_measurement_id)) return { status: 'present', measurementId: site.ga4_measurement_id.trim() };
  if (!isPropertyId(site?.ga4_property_id)) return { status: 'no-property', detail: 'No GA4 property is connected to this project.' };

  let streams;
  try {
    const client = admin || google.analyticsadmin({ version: 'v1beta', auth: getGoogleAuth(site) });
    const out = [];
    let pageToken;
    do {
      const { data } = await client.properties.dataStreams.list({ parent: `properties/${String(site.ga4_property_id).trim()}`, pageSize: 50, pageToken });
      out.push(...(data.dataStreams || []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    streams = out;
  } catch (err) {
    const status = failureStatus(err);
    return { status, detail: status === 'permission-denied' ? 'The connected Google account cannot read this GA4 property\'s data streams.' : status === 'no-property' ? 'The stored GA4 property was not found for the connected Google account.' : 'Google Analytics could not be reached; this will be tried again.' };
  }

  const web = streams
    .filter((s) => (!s.type || s.type === 'WEB_DATA_STREAM') && isMeasurementId(s.webStreamData?.measurementId))
    .map((s) => ({ measurementId: s.webStreamData.measurementId.trim(), domain: bare(s.webStreamData.defaultUri), name: s.displayName || null }));
  if (!web.length) return { status: 'no-web-stream', streams: [], detail: 'The GA4 property has no web data stream, so there is no measurement ID yet. Someone with edit access to the property needs to create one.' };

  // Only a stream whose address IS this site counts. A lone stream on another address is a different website's tag; using it would
  // send this site's visitors into someone else's report.
  const want = bare(site.website_domain);
  const matches = want ? web.filter((s) => s.domain === want) : [];
  const distinct = [...new Set(matches.map((m) => m.measurementId))];
  if (distinct.length === 1) return { status: 'found', measurementId: distinct[0], streams: web, detail: 'Found on the connected property\'s web data stream for this site\'s own domain.' };
  return { status: 'ambiguous', streams: web, detail: matches.length ? 'More than one web data stream matches this site\'s domain.' : 'No web data stream on the property matches this site\'s domain.' };
}

/** Resolve the ID for a site: stored, else discovered (and then saved). Never throws. */
export async function ensureMeasurementId(site, { admin = null, save = true, saveFn = updateSiteAnalyticsIds } = {}) {
  let result;
  try { result = await discoverMeasurementId(site, { admin }); } catch (err) { return { status: 'unavailable', detail: 'Measurement ID discovery failed.' }; }
  if (result.status === 'found' && save && site?.id != null) {
    try { await saveFn({ siteId: site.id, ga4MeasurementId: result.measurementId }); } catch { return { ...result, saved: false }; }
    return { ...result, saved: true };
  }
  return result;
}

// What a person should be told, per status. One place, so the dashboard card, the run summary and the refusal all say the same thing.
export function needsInputMessage(status) {
  switch (status) {
    case 'no-property': return 'Needs input: connect this project\'s Google Analytics (GA4) property so its measurement ID can be found.';
    case 'no-web-stream': return 'Needs input: the connected GA4 property has no web data stream. Create one for this website in Google Analytics (or send us the G-… measurement ID).';
    case 'ambiguous': return 'Needs input: could not tell which GA4 web data stream belongs to this website. Send us the G-… measurement ID to use.';
    case 'permission-denied': return 'Needs input: the connected Google account cannot read this GA4 property\'s data streams. Grant it access (or send us the G-… measurement ID).';
    default: return null; // 'unavailable' is temporary, never a client request
  }
}
