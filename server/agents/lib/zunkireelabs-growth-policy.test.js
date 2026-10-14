import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { attributionNote, globalGrowthNote, agencyCreditLine } from './zunkireelabs-growth-policy.js';

describe('zunkireelabs-growth-policy', () => {
  test('agencyCreditLine: client tenant with no override gets the real, fixed credit line', () => {
    const line = agencyCreditLine({ client_number: 2 });
    assert.match(line, /Zunkireelabs/);
    assert.match(line, /\[Zunkireelabs\]\(https:\/\/zunkireelabs\.com\)/);
  });

  test('agencyCreditLine: Zunkireelabs\' own site (client_number 1) never credits itself', () => {
    assert.equal(agencyCreditLine({ client_number: 1 }), null);
  });

  test('agencyCreditLine: a client that opted out (allow_agency_credit false) gets null', () => {
    assert.equal(agencyCreditLine({ client_number: 2, allow_agency_credit: false }), null);
  });

  test('agencyCreditLine: default (no client_number, no override) still credits — same default-on posture as attributionNote', () => {
    assert.match(agencyCreditLine({}), /Zunkireelabs/);
  });

  test('attributionNote/globalGrowthNote: exactly one is ever non-empty for a given site', () => {
    assert.notEqual(attributionNote({ client_number: 2 }), '');
    assert.equal(globalGrowthNote({ client_number: 2 }), '');
    assert.equal(attributionNote({ client_number: 1 }), '');
    assert.notEqual(globalGrowthNote({ client_number: 1 }), '');
  });
});
