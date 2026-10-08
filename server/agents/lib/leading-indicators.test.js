import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ctrDecaySignal, positionDriftSignal, coverageChurnSignal, capabilityGapSignal,
  profileStalenessSignal, leadingIndicatorsFor, isLeadingIndicatorsEnabled,
  PAGE_ONE_CEILING, MIN_IMPRESSIONS_FOR_CTR_DECAY,
} from './leading-indicators.js';

describe('ctrDecaySignal', () => {
  test('impressions up while clicks flat is the signal', () => {
    // The most useful indicator here: by the time position moves, the loss
    // is already realised.
    const s = ctrDecaySignal({
      before: { impressions: 1000, clicks: 50 },
      after: { impressions: 1500, clicks: 50 },
    });
    assert.ok(s);
    assert.equal(s.family, 'ctr-decay-leading');
    assert.equal(s.leading, true);
    assert.match(s.detail, /impressions \+50%/);
    assert.match(s.detail, /5\.0% → 3\.3%/);
  });

  test('clicks keeping pace with impressions is not decay', () => {
    assert.equal(ctrDecaySignal({
      before: { impressions: 1000, clicks: 50 },
      after: { impressions: 1500, clicks: 75 },
    }), null);
  });

  test('flat impressions are not decay however bad the CTR', () => {
    assert.equal(ctrDecaySignal({
      before: { impressions: 1000, clicks: 50 },
      after: { impressions: 1000, clicks: 40 },
    }), null);
  });

  test('a low-impression page is noise, not evidence', () => {
    assert.equal(ctrDecaySignal({
      before: { impressions: 50, clicks: 5 },
      after: { impressions: MIN_IMPRESSIONS_FOR_CTR_DECAY - 1, clicks: 5 },
    }), null);
  });

  test('a page that never converted impressions is a different problem, not decay', () => {
    // Claiming decay here would be wrong: nothing decayed, it never worked.
    assert.equal(ctrDecaySignal({
      before: { impressions: 1000, clicks: 0 },
      after: { impressions: 2000, clicks: 0 },
    }), null);
  });

  test('missing windows produce nothing rather than throwing', () => {
    assert.equal(ctrDecaySignal({}), null);
    assert.equal(ctrDecaySignal(), null);
    assert.equal(ctrDecaySignal({ before: { impressions: 0, clicks: 0 }, after: { impressions: 900, clicks: 1 } }), null);
  });
});

describe('positionDriftSignal', () => {
  test('a slide from 3 to 7 inside page one is the signal', () => {
    // Still "ranking on page one", so no existing threshold fires — this is
    // the drift that gets noticed a quarter late.
    const s = positionDriftSignal({ before: { avgPosition: 3.1 }, after: { avgPosition: 7.4 } });
    assert.ok(s);
    assert.equal(s.family, 'position-drift-leading');
    assert.match(s.detail, /3\.1 → 7\.4/);
  });

  test('drift past page one is left to the existing position-erosion family', () => {
    // Counting it here too would inflate corroboration and let one
    // phenomenon clear the act bar on its own.
    assert.equal(positionDriftSignal({ before: { avgPosition: 8 }, after: { avgPosition: PAGE_ONE_CEILING + 5 } }), null);
    assert.equal(positionDriftSignal({ before: { avgPosition: 12 }, after: { avgPosition: 20 } }), null);
  });

  test('a small wobble is not drift, and improvement is never a warning', () => {
    assert.equal(positionDriftSignal({ before: { avgPosition: 3 }, after: { avgPosition: 4 } }), null);
    assert.equal(positionDriftSignal({ before: { avgPosition: 7 }, after: { avgPosition: 3 } }), null);
  });

  test('a missing position produces nothing', () => {
    assert.equal(positionDriftSignal({ before: {}, after: { avgPosition: 5 } }), null);
  });
});

describe('coverageChurnSignal', () => {
  test('a verdict that keeps changing is the signal', () => {
    const s = coverageChurnSignal({ verdictHistory: ['opportunity', 'covered', 'opportunity'] });
    assert.ok(s);
    assert.equal(s.family, 'coverage-churn-leading');
    assert.match(s.detail, /changed 2 times/);
  });

  test('a stable verdict, or one change, is not churn', () => {
    assert.equal(coverageChurnSignal({ verdictHistory: ['covered', 'covered', 'covered'] }), null);
    assert.equal(coverageChurnSignal({ verdictHistory: ['opportunity', 'covered'] }), null);
  });

  test('too little history produces nothing', () => {
    assert.equal(coverageChurnSignal({ verdictHistory: ['covered'] }), null);
    assert.equal(coverageChurnSignal({}), null);
  });
});

describe('capabilityGapSignal', () => {
  test('repeated blocked attempts on one surface is the signal', () => {
    // Predictive of the ABSENCE of work, which no traffic metric can show —
    // the page never changes, so nothing moves to notice.
    const s = capabilityGapSignal({ blockedAttempts: 3, generatorIds: ['expand-content', 'expand-content', 'faq'] });
    assert.ok(s);
    assert.match(s.detail, /3 generation attempt\(s\) blocked/);
    assert.match(s.detail, /expand-content, faq/);
  });

  test('one blocked attempt is not a pattern', () => {
    assert.equal(capabilityGapSignal({ blockedAttempts: 1 }), null);
    assert.equal(capabilityGapSignal({}), null);
  });
});

describe('profileStalenessSignal', () => {
  const now = new Date('2026-10-07T00:00:00Z');

  test('a profile older than the window is the signal', () => {
    const s = profileStalenessSignal({ profileDerivedAt: '2026-01-01T00:00:00Z', now });
    assert.ok(s);
    assert.equal(s.family, 'design-staleness-leading');
    assert.match(s.detail, /days ago/);
  });

  test('a recent profile is fine, and no profile date produces nothing', () => {
    assert.equal(profileStalenessSignal({ profileDerivedAt: '2026-10-01T00:00:00Z', now }), null);
    assert.equal(profileStalenessSignal({}), null);
    assert.equal(profileStalenessSignal({ profileDerivedAt: 'not a date', now }), null);
  });
});

describe('leadingIndicatorsFor', () => {
  test('nothing happening produces no signals and no families', () => {
    const out = leadingIndicatorsFor({});
    assert.deepEqual(out.signals, []);
    assert.equal(out.families.size, 0);
  });

  test('one indicator yields exactly ONE family, so it can never clear the act bar alone', () => {
    // This is the design, not a limitation: a single leading indicator is a
    // suspicion. MIN_CORROBORATION_TO_ACT is 2, and only agreement between
    // independent families is grounds to act.
    const out = leadingIndicatorsFor({
      before: { impressions: 1000, clicks: 50 }, after: { impressions: 1600, clicks: 50 },
    });
    assert.equal(out.signals.length, 1);
    assert.equal(out.families.size, 1);
  });

  test('two independent indicators agreeing yields two families', () => {
    const out = leadingIndicatorsFor({
      before: { impressions: 1000, clicks: 50, avgPosition: 3.0 },
      after: { impressions: 1600, clicks: 50, avgPosition: 6.5 },
    });
    assert.equal(out.families.size, 2);
    assert.deepEqual([...out.families].sort(), ['ctr-decay-leading', 'position-drift-leading']);
  });

  test('every signal is marked leading, so a consumer can tell them from measured decline', () => {
    const out = leadingIndicatorsFor({
      before: { impressions: 1000, clicks: 50, avgPosition: 3.0 },
      after: { impressions: 1600, clicks: 50, avgPosition: 6.5 },
      verdictHistory: ['opportunity', 'covered', 'opportunity'],
    });
    assert.ok(out.signals.every((s) => s.leading === true));
    assert.ok(out.signals.every((s) => s.family && s.source && s.detail));
  });

  test('a malformed row does not break the sweep for the rest of the page', () => {
    const out = leadingIndicatorsFor({
      // A getter that throws stands in for any malformed row shape.
      get verdictHistory() { throw new Error('bad row'); },
      before: { impressions: 1000, clicks: 50, avgPosition: 3.0 },
      after: { impressions: 1600, clicks: 50, avgPosition: 6.5 },
    });
    assert.equal(out.families.size, 2);
  });
});

describe('isLeadingIndicatorsEnabled', () => {
  test('off unless explicitly turned on', () => {
    assert.equal(isLeadingIndicatorsEnabled({}), false);
    assert.equal(isLeadingIndicatorsEnabled({ LEADING_INDICATORS_ENABLED: 'true' }), true);
  });
});
