import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  textClassPx, isSectionScaleTextClass, maxTextPx, isFixedHeightClass, isFixedHeightOnly,
} from './text-scale.js';

describe('textClassPx', () => {
  test('reads named Tailwind scales', () => {
    assert.equal(textClassPx('text-sm'), 14);
    assert.equal(textClassPx('text-3xl'), 30);
    assert.equal(textClassPx('text-5xl'), 48);
  });

  test('reads arbitrary px and rem values — the notation every old guard was blind to', () => {
    assert.equal(textClassPx('text-[50px]'), 50);
    assert.equal(textClassPx('text-[28px]'), 28);
    assert.equal(textClassPx('text-[3.5rem]'), 56);
  });

  test('sees through responsive and state prefixes', () => {
    assert.equal(textClassPx('md:text-[50px]'), 50);
    assert.equal(textClassPx('lg:text-4xl'), 36);
    assert.equal(textClassPx('group-hover:text-2xl'), 24);
  });

  test('a text-COLOR is never read as a size', () => {
    assert.equal(textClassPx('text-gray-600'), null);
    assert.equal(textClassPx('text-zunkiree-600'), null);
  });

  test('non-size utilities and unparseable arbitrary values are "cannot tell", not zero', () => {
    assert.equal(textClassPx('font-bold'), null);
    assert.equal(textClassPx('leading-tight'), null);
    assert.equal(textClassPx('text-[var(--h1)]'), null);
    assert.equal(textClassPx('text-[2vw]'), null);
    assert.equal(textClassPx(''), null);
    assert.equal(textClassPx(null), null);
  });
});

describe('isSectionScaleTextClass', () => {
  test('treats both notations by rendered size, not by spelling', () => {
    assert.equal(isSectionScaleTextClass('text-3xl'), true);
    assert.equal(isSectionScaleTextClass('md:text-[50px]'), true);
    assert.equal(isSectionScaleTextClass('text-[36px]'), true);
  });

  test('ordinary in-article subheading scale is left alone', () => {
    assert.equal(isSectionScaleTextClass('text-2xl'), false);
    assert.equal(isSectionScaleTextClass('text-[28px]'), false);
    assert.equal(isSectionScaleTextClass('text-base'), false);
  });

  test('a class that sets no size is never section scale', () => {
    assert.equal(isSectionScaleTextClass('font-bold'), false);
    assert.equal(isSectionScaleTextClass('text-gray-600'), false);
  });
});

describe('maxTextPx', () => {
  test('judges a responsive ramp by its TOP size, where the defect actually shows', () => {
    // admizzeducation.com's real FAQ question class.
    assert.equal(maxTextPx('text-[28px] sm:text-[36px] md:text-[50px] font-bold leading-[1.15]'), 50);
  });

  test('mixed notations compare on one scale', () => {
    assert.equal(maxTextPx('text-lg md:text-4xl'), 36);
  });

  test('null when the string sets no size at all', () => {
    assert.equal(maxTextPx('font-bold tracking-tight text-gray-600'), null);
    assert.equal(maxTextPx(''), null);
  });
});

describe('isFixedHeightClass / isFixedHeightOnly', () => {
  test('recognises arbitrary, numeric and keyword heights', () => {
    assert.equal(isFixedHeightClass('h-[70px]'), true);
    assert.equal(isFixedHeightClass('h-12'), true);
    assert.equal(isFixedHeightClass('h-screen'), true);
    assert.equal(isFixedHeightClass('md:h-[70px]'), true);
  });

  test('padding, margin and min-height are not fixed heights', () => {
    assert.equal(isFixedHeightClass('py-16'), false);
    assert.equal(isFixedHeightClass('my-12'), false);
    assert.equal(isFixedHeightClass('min-h-screen'), false);
  });

  test('isFixedHeightOnly distinguishes a pure measurement mistake from real spacing', () => {
    assert.equal(isFixedHeightOnly('h-[70px]'), true, "admizz's stored spacing.section");
    assert.equal(isFixedHeightOnly('py-16 md:py-24'), false);
    assert.equal(isFixedHeightOnly('h-[70px] py-4'), false, 'carries real spacing too — not a pure mistake');
    assert.equal(isFixedHeightOnly(''), false);
  });
});
