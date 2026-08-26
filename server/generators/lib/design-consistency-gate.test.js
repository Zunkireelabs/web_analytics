import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkDesignConsistency } from './design-consistency-gate.js';

describe('checkDesignConsistency', () => {
  test('plain prose with no styling at all is clean', () => {
    const result = checkDesignConsistency({ headline: 'Welcome', body: 'This is a normal paragraph of content.' });
    assert.equal(result.clean, true);
    assert.deepEqual(result.issues, []);
  });

  test('an inline style attribute is flagged, with the dotted path to where it was found', () => {
    const result = checkDesignConsistency({ body: '<div style="color: red; font-size: 20px">Hi</div>' });
    assert.equal(result.clean, false);
    assert.equal(result.issues[0].patternId, 'inline-style');
    assert.equal(result.issues[0].path, 'body');
  });

  test('a raw hex color value is flagged even with no HTML around it', () => {
    const result = checkDesignConsistency({ body: 'Use background #ff00aa for emphasis.' });
    assert.equal(result.clean, false);
    assert.equal(result.issues[0].patternId, 'raw-color-value');
  });

  test('a raw rgb()/rgba() color value is flagged', () => {
    const result = checkDesignConsistency({ body: 'background: rgba(20, 30, 40, 0.5);' });
    assert.equal(result.clean, false);
    assert.equal(result.issues[0].patternId, 'raw-color-value');
  });

  test('a real site class name mentioned in prose is NOT flagged — this is not a class allowlist check', () => {
    const result = checkDesignConsistency({ body: 'The button uses the class="text-2xl font-bold" style from the homepage.' });
    assert.equal(result.clean, true);
  });

  test('walks nested arrays/objects and reports the full dotted/indexed path', () => {
    const result = checkDesignConsistency({ items: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: '<p style="color:blue">A2</p>' }] });
    assert.equal(result.clean, false);
    assert.equal(result.issues[0].path, 'items[1].answer');
  });

  test('a plain string (not wrapped in an object) is also walked', () => {
    const result = checkDesignConsistency('<span style="margin:0">x</span>');
    assert.equal(result.clean, false);
  });

  test('null/undefined content does not throw', () => {
    assert.equal(checkDesignConsistency(null).clean, true);
    assert.equal(checkDesignConsistency(undefined).clean, true);
  });
});
