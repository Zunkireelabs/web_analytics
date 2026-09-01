import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSvgDimensions, classifyAvatarAspectGap } from './avatar-aspect-check.js';

const SQUARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle r="10"/></svg>';
const WIDE_WORDMARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="6571" height="900" viewBox="0 0 4928.25 675.000002"><rect width="581" height="585"/></svg>';
const WIDTH_HEIGHT_ONLY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path d="M0 0"/></svg>';
const NO_DIMENSIONS_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

test('parseSvgDimensions reads the root viewBox, ignoring nested element width/height', () => {
  assert.deepEqual(parseSvgDimensions(SQUARE_SVG), { width: 200, height: 200 });
  assert.deepEqual(parseSvgDimensions(WIDE_WORDMARK_SVG), { width: 4928.25, height: 675.000002 });
});

test('parseSvgDimensions falls back to root width/height attributes when there is no viewBox', () => {
  assert.deepEqual(parseSvgDimensions(WIDTH_HEIGHT_ONLY_SVG), { width: 64, height: 64 });
});

test('parseSvgDimensions returns null when neither viewBox nor width/height is present', () => {
  assert.equal(parseSvgDimensions(NO_DIMENSIONS_SVG), null);
});

test('parseSvgDimensions returns null for non-string/non-SVG input', () => {
  assert.equal(parseSvgDimensions(null), null);
  assert.equal(parseSvgDimensions('<png>not svg</png>'), null);
});

test('classifyAvatarAspectGap: contain fit never gaps, regardless of aspect ratio', () => {
  assert.equal(classifyAvatarAspectGap({ expectedFit: 'contain', dimensions: { width: 4928, height: 675 } }), null);
  assert.equal(classifyAvatarAspectGap({ expectedFit: 'contain', dimensions: null }), null);
});

test('classifyAvatarAspectGap: circular-cover with a square image is fine', () => {
  assert.equal(classifyAvatarAspectGap({ expectedFit: 'circular-cover', dimensions: { width: 200, height: 200 } }), null);
});

test('classifyAvatarAspectGap: circular-cover with a wide wordmark is a fatal gap — the exact zunkireelabs-web incident shape', () => {
  const gap = classifyAvatarAspectGap({ expectedFit: 'circular-cover', dimensions: { width: 4928.25, height: 675 } });
  assert.equal(gap.severity, 'fatal');
  assert.match(gap.reason, /circular object-cover frame/);
});

test('classifyAvatarAspectGap: circular-cover with unknown dimensions is unverified, not silently fine', () => {
  const gap = classifyAvatarAspectGap({ expectedFit: 'circular-cover', dimensions: null });
  assert.equal(gap.severity, 'unverified');
});

test('classifyAvatarAspectGap: circular-cover tolerates a near-square image', () => {
  assert.equal(classifyAvatarAspectGap({ expectedFit: 'circular-cover', dimensions: { width: 220, height: 200 } }), null);
});
