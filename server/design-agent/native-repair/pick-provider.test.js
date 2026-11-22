import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pickProvider } from './agent-loop.js';

const KEYS = ['NATIVE_REPAIR_PROVIDER', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'LLM_OPENAI_PAUSED'];
describe('native repair provider choice', () => {
  let saved;
  beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); KEYS.forEach((k) => delete process.env[k]); });
  afterEach(() => { KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))); });

  test('a real OpenAI key is used normally', () => {
    process.env.OPENAI_API_KEY = 'sk-real'; process.env.ANTHROPIC_API_KEY = 'a';
    assert.equal(pickProvider(), 'openai');
  });
  test('LLM_OPENAI_PAUSED sends the run straight to Claude (no wasted 429)', () => {
    process.env.OPENAI_API_KEY = 'sk-real'; process.env.ANTHROPIC_API_KEY = 'a'; process.env.LLM_OPENAI_PAUSED = 'true';
    assert.equal(pickProvider(), 'anthropic');
  });
  test('paused WITHOUT an Anthropic key changes nothing (nothing to fall back to)', () => {
    process.env.OPENAI_API_KEY = 'sk-real'; process.env.LLM_OPENAI_PAUSED = 'true';
    assert.equal(pickProvider(), 'openai');
  });
  test('an explicitly pinned provider is respected', () => {
    process.env.NATIVE_REPAIR_PROVIDER = 'openai'; process.env.LLM_OPENAI_PAUSED = 'true'; process.env.ANTHROPIC_API_KEY = 'a';
    assert.equal(pickProvider(), 'openai');
  });
});
