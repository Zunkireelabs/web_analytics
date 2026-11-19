import { test } from 'node:test';
import assert from 'node:assert/strict';
import { themeColorFromHtml, dominantSvgColor } from './brand-color-discovery.js';

test('theme-color is read when it is a real colour', () => {
  assert.equal(themeColorFromHtml('<meta name="theme-color" content="#3F6839">'), '#3f6839');
});
test('missing, white, black or grey theme-color gives null', () => {
  for (const h of ['', '<meta name="theme-color" content="#ffffff">', '<meta name="theme-color" content="#000">', '<meta name="theme-color" content="#888888">', '<meta name="theme-color" content="red">']) {
    assert.equal(themeColorFromHtml(h), null);
  }
});
test('the logo colour is the most-used real fill, ignoring white, black and grey', () => {
  const svg = '<svg><path fill="#fff"/><path fill="#111111"/><path fill="#C8A96E"/><path fill="#c8a96e"/><path fill="#0d1282"/></svg>';
  assert.equal(dominantSvgColor(svg), '#c8a96e');
  assert.equal(dominantSvgColor('<svg><path fill="#000"/></svg>'), null);
});
