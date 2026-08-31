import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { correctBodyTypography } from './profile-extract.js';

// The real classes and computed styles captured from zunkireelabs.com on
// 2026-08-31. The eyebrow is the site's most consistent body-role paragraph —
// every section has one above its heading — which is exactly why the model
// picked it and why no prompt wording could have prevented that.
const EYEBROW = 'text-xs uppercase tracking-widest text-zunkiree-600 font-medium mb-6';
const REAL_BODY = 'text-lg text-gray-600 leading-relaxed';

const eyebrowSample = (text = 'AI-First Technology Company') => ({
  role: 'body',
  classes: EYEBROW,
  text,
  style: { fontSize: '12px', color: 'rgb(235, 22, 0)', textTransform: 'uppercase', letterSpacing: '2.4px' },
});

const bodySample = (classes = REAL_BODY) => ({
  role: 'body',
  classes,
  text: 'Zunkiree Labs builds AI infrastructure for teams that need it to actually work in production.',
  style: { fontSize: '18px', color: 'rgb(75, 85, 99)', textTransform: 'none', letterSpacing: 'normal' },
});

describe('correctBodyTypography', () => {
  test('replaces an eyebrow pick with the real body class', () => {
    const samples = [eyebrowSample(), eyebrowSample('Our Platform'), eyebrowSample('Why Us'), bodySample()];
    const { body, corrected } = correctBodyTypography(EYEBROW, samples);
    assert.equal(body, REAL_BODY);
    assert.equal(corrected, true);
  });

  test('leaves a correct pick alone', () => {
    const { body, corrected } = correctBodyTypography(REAL_BODY, [eyebrowSample(), bodySample()]);
    assert.equal(body, REAL_BODY);
    assert.equal(corrected, false);
  });

  test('picks the most frequent body-like class, not merely the first', () => {
    const samples = [
      eyebrowSample(),
      bodySample('text-sm text-gray-500'),
      bodySample(REAL_BODY), bodySample(REAL_BODY), bodySample(REAL_BODY),
    ];
    assert.equal(correctBodyTypography(EYEBROW, samples).body, REAL_BODY);
  });

  test('returns null when every sample is a label, making the profile unusable', () => {
    // Deliberate: validateDesignProfile requires typography.body, so a null
    // here means every generator falls back to its plain default. Shipping no
    // styling is recoverable; shipping all prose as tiny uppercase text is not.
    const { body, corrected } = correctBodyTypography(EYEBROW, [eyebrowSample(), eyebrowSample('Our Platform')]);
    assert.equal(body, null);
    assert.equal(corrected, true);
  });

  test('a small-but-not-uppercase caption is still rejected as body copy', () => {
    const caption = {
      role: 'body',
      classes: 'text-xs text-gray-400',
      text: 'Photo by someone on Pexels',
      style: { fontSize: '12px', textTransform: 'none', letterSpacing: 'normal' },
    };
    assert.equal(correctBodyTypography('text-xs text-gray-400', [caption]).body, null);
  });

  test('wide letter-spacing alone marks a label', () => {
    const tracked = {
      role: 'body',
      classes: 'tracking-widest text-gray-700',
      text: 'A fairly long line of text that is nonetheless a styled label treatment',
      style: { fontSize: '16px', textTransform: 'none', letterSpacing: '3px' },
    };
    assert.equal(correctBodyTypography('tracking-widest text-gray-700', [tracked, bodySample()]).body, REAL_BODY);
  });

  test('no samples at all leaves the model\'s pick untouched', () => {
    // Nothing to check against is not evidence the pick is wrong.
    const { body, corrected } = correctBodyTypography(REAL_BODY, []);
    assert.equal(body, REAL_BODY);
    assert.equal(corrected, false);
  });
});
