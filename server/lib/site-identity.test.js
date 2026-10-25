import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findSiteIdentityConflict, siteIdentityConflictMessage } from './site-identity.js';

// Shaped after the live rows this guard has to not misfire on: one site whose
// property is about to change, plus unrelated tenants sharing neither
// identifier.
const ZUNKIREE = {
  id: 1,
  name: 'Zunkiree Labs',
  gsc_property: 'sc-domain:zunkireelabs.com',
  ga4_property_id: '296921613',
};
const OTHER_TENANT_A = {
  id: 8862,
  name: 'Admizz Education',
  gsc_property: 'sc-domain:admizzeducation.com',
  ga4_property_id: '483837192',
};
const OTHER_TENANT_B = {
  id: 8864,
  name: 'Chayceproperties',
  gsc_property: 'sc-domain:chayceproperties.com',
  ga4_property_id: '553570513',
};
const ALL = [ZUNKIREE, OTHER_TENANT_A, OTHER_TENANT_B];

describe('findSiteIdentityConflict', () => {
  test('catches the domain-property → URL-prefix switch that orphans history', () => {
    // The exact change being made to this instance: GSC_PROPERTY edited,
    // GA4_PROPERTY_ID untouched. Without the guard this inserts site #4.
    const conflict = findSiteIdentityConflict({
      gscProperty: 'https://zunkireelabs.com/',
      ga4PropertyId: '296921613',
      rows: ALL,
    });
    assert.equal(conflict?.site.id, 1);
    assert.equal(conflict.matchedOn, 'ga4_property_id');
    assert.equal(conflict.changed, 'gsc_property');
  });

  test('catches the mirror case — a changed GA4 property under the same GSC property', () => {
    const conflict = findSiteIdentityConflict({
      gscProperty: 'sc-domain:zunkireelabs.com',
      ga4PropertyId: '999999999',
      rows: ALL,
    });
    assert.equal(conflict?.site.id, 1);
    assert.equal(conflict.matchedOn, 'gsc_property');
    assert.equal(conflict.changed, 'ga4_property_id');
  });

  test('a genuinely new tenant is not a conflict — onboarding must still work', () => {
    assert.equal(
      findSiteIdentityConflict({
        gscProperty: 'sc-domain:brand-new-client.com',
        ga4PropertyId: '111111111',
        rows: ALL,
      }),
      null
    );
  });

  test('a fresh database is not a conflict — first-run bootstrap must still insert', () => {
    assert.equal(
      findSiteIdentityConflict({ gscProperty: 'sc-domain:example.com', ga4PropertyId: '1', rows: [] }),
      null
    );
    assert.equal(
      findSiteIdentityConflict({ gscProperty: 'sc-domain:example.com', ga4PropertyId: '1', rows: undefined }),
      null
    );
  });

  test('both identifiers matching is not a conflict — that row is simply the configured site', () => {
    // getOrCreateSite returns on its own SELECT before reaching the guard, so
    // this only asserts the guard would not contradict it.
    assert.equal(
      findSiteIdentityConflict({
        gscProperty: ZUNKIREE.gsc_property,
        ga4PropertyId: ZUNKIREE.ga4_property_id,
        rows: ALL,
      }),
      null
    );
  });

  test('unconnected sites never match, however many share a NULL property', () => {
    // createClientSite() inserts gsc_property/ga4_property_id as NULL. Two
    // such rows must not read as "the same site", and must not swallow the
    // configured property by matching NULL against it.
    const pending = [
      { id: 20, name: 'Pending One', gsc_property: null, ga4_property_id: null },
      { id: 21, name: 'Pending Two', gsc_property: null, ga4_property_id: null },
    ];
    assert.equal(
      findSiteIdentityConflict({ gscProperty: 'sc-domain:new.com', ga4PropertyId: '42', rows: pending }),
      null
    );
    // And an undefined/absent env value must not match a NULL column either.
    assert.equal(
      findSiteIdentityConflict({ gscProperty: undefined, ga4PropertyId: undefined, rows: pending }),
      null
    );
  });

  test('reports the first conflicting row rather than scanning past it', () => {
    const conflict = findSiteIdentityConflict({
      gscProperty: 'sc-domain:admizzeducation.com',
      ga4PropertyId: 'changed',
      rows: ALL,
    });
    assert.equal(conflict?.site.id, 8862);
  });
});

describe('siteIdentityConflictMessage', () => {
  test('names the site, both values, and the command that preserves history', () => {
    const env = { gscProperty: 'https://zunkireelabs.com/', ga4PropertyId: '296921613' };
    const msg = siteIdentityConflictMessage(findSiteIdentityConflict({ ...env, rows: ALL }), env);

    assert.match(msg, /site 1 \(Zunkiree Labs\)/);
    assert.match(msg, /sc-domain:zunkireelabs\.com/); // the existing value
    assert.match(msg, /https:\/\/zunkireelabs\.com\//); // the new one from .env
    // The whole point of the error: it has to hand over the safe path.
    assert.match(msg, /connect-site\.js --site-id 1/);
    assert.match(msg, /--gsc-property/);
    assert.doesNotMatch(msg, /--ga4-property-id/);
  });

  test('switches to the GA4 flag when that is the identifier that changed', () => {
    const env = { gscProperty: 'sc-domain:zunkireelabs.com', ga4PropertyId: '999999999' };
    const msg = siteIdentityConflictMessage(findSiteIdentityConflict({ ...env, rows: ALL }), env);
    assert.match(msg, /--ga4-property-id '999999999'/);
    assert.doesNotMatch(msg, /--gsc-property/);
  });

  test('renders an unset existing value without printing "null"', () => {
    const conflict = {
      site: { id: 5, name: 'Half Connected', gsc_property: 'sc-domain:half.com', ga4_property_id: null },
      matchedOn: 'gsc_property',
      changed: 'ga4_property_id',
    };
    const msg = siteIdentityConflictMessage(conflict, { gscProperty: 'sc-domain:half.com', ga4PropertyId: '7' });
    assert.match(msg, /existing: \(unset\)/);
    assert.doesNotMatch(msg, /existing: null/);
  });
});
