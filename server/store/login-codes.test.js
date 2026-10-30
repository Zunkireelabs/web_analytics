import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, normalizeCode, CODE_MINUTES, MAX_ATTEMPTS } from './login-codes.js';

describe('sign-in code rules', () => {
  test('a code is always exactly six digits, leading zeros kept', () => {
    for (let i = 0; i < 500; i++) assert.match(generateCode(), /^\d{6}$/);
  });
  test('what a person types is cleaned of spaces and dashes before it is checked', () => {
    assert.equal(normalizeCode('482 913'), '482913');
    assert.equal(normalizeCode('482-913'), '482913');
    assert.equal(normalizeCode(null), '');
  });
  test('the limits are the ones the email promises', () => {
    assert.equal(CODE_MINUTES, 10);
    assert.equal(MAX_ATTEMPTS, 5);
  });
});
