import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, getConfiguredProviders } from './index.js';

// configured() reads process.env live on every call (no module-load-time
// caching in any provider file), so these tests can freely toggle env vars
// between cases. Every var this suite touches is saved/restored around each
// test so it never leaks into another test file's run in the same process.
const ENV_KEYS = [
  'OPENAI_API_KEY', 'AI_RECOMMENDATION_ENABLED',
  'ANTHROPIC_API_KEY', 'AI_RECOMMENDATION_ANTHROPIC_ENABLED',
  'PERPLEXITY_API_KEY', 'AI_RECOMMENDATION_PERPLEXITY_ENABLED',
];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('PROVIDERS', () => {
  test('lists exactly openai, anthropic, perplexity, in that order', () => {
    assert.deepEqual(PROVIDERS.map((p) => p.id), ['openai', 'anthropic', 'perplexity']);
  });
});

describe('getConfiguredProviders — gating', () => {
  test('nothing configured when no env vars are set at all', () => {
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), []);
  });

  test('only OpenAI configured (today\'s default/only-supported deployment shape) returns exactly [openai]', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.AI_RECOMMENDATION_ENABLED = 'true';
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), ['openai']);
  });

  test('OpenAI key alone, without the master enable flag, is NOT configured', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), []);
  });

  test('Anthropic key present but its own dedicated flag missing stays disabled', () => {
    process.env.AI_RECOMMENDATION_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    // AI_RECOMMENDATION_ANTHROPIC_ENABLED deliberately left unset
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), []);
  });

  test('Anthropic dedicated flag true but no real key stays disabled', () => {
    process.env.AI_RECOMMENDATION_ENABLED = 'true';
    process.env.AI_RECOMMENDATION_ANTHROPIC_ENABLED = 'true';
    // ANTHROPIC_API_KEY deliberately left unset
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), []);
  });

  test('Anthropic fully configured (key + master flag + dedicated flag) is enabled', () => {
    process.env.AI_RECOMMENDATION_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_RECOMMENDATION_ANTHROPIC_ENABLED = 'true';
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), ['anthropic']);
  });

  test('Perplexity without its key stays disabled even with both flags true', () => {
    process.env.AI_RECOMMENDATION_ENABLED = 'true';
    process.env.AI_RECOMMENDATION_PERPLEXITY_ENABLED = 'true';
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), []);
  });

  test('Perplexity fully configured is enabled', () => {
    process.env.AI_RECOMMENDATION_ENABLED = 'true';
    process.env.PERPLEXITY_API_KEY = 'pplx-test';
    process.env.AI_RECOMMENDATION_PERPLEXITY_ENABLED = 'true';
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), ['perplexity']);
  });

  test('enabling OpenAI never silently enables Anthropic/Perplexity just because their keys happen to be set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.AI_RECOMMENDATION_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; // key present, but no AI_RECOMMENDATION_ANTHROPIC_ENABLED
    process.env.PERPLEXITY_API_KEY = 'pplx-test'; // key present, but no AI_RECOMMENDATION_PERPLEXITY_ENABLED
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), ['openai']);
  });

  test('all three configured returns all three, in PROVIDERS order', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.AI_RECOMMENDATION_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_RECOMMENDATION_ANTHROPIC_ENABLED = 'true';
    process.env.PERPLEXITY_API_KEY = 'pplx-test';
    process.env.AI_RECOMMENDATION_PERPLEXITY_ENABLED = 'true';
    assert.deepEqual(getConfiguredProviders().map((p) => p.id), ['openai', 'anthropic', 'perplexity']);
  });
});
