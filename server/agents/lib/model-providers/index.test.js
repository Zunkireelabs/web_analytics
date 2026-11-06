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
  test('lists the real-answer provider first, then the model-API providers', () => {
    // dataforseo-ai observes the assistant products themselves; the other three ask a model what it recalls when
    // asked cold. Order here is display-only, but the real measurement leads.
    assert.deepEqual(PROVIDERS.map((p) => p.id), ['dataforseo-ai', 'openai', 'anthropic', 'perplexity']);
  });

  test('every provider implements the same contract', () => {
    for (const p of PROVIDERS) {
      assert.equal(typeof p.id, 'string', 'id');
      for (const fn of ['configured', 'ask', 'extract']) {
        assert.equal(typeof p[fn], 'function', `${p.id}.${fn}`);
      }
    }
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

describe('openai probe — web search', () => {
  test('textFromResponse appends cited source URLs so a citation of the own domain is visible', async () => {
    const { textFromResponse } = await import('./openai.js');
    const res = {
      output_text: 'Top agencies include Acme.',
      output: [{ content: [{ annotations: [{ type: 'url_citation', url: 'https://zunkireelabs.com/' }, { type: 'url_citation', url: 'https://zunkireelabs.com/' }, { type: 'other' }] }] }],
    };
    assert.equal(textFromResponse(res), 'Top agencies include Acme.\n\nSources:\nhttps://zunkireelabs.com/');
    assert.equal(textFromResponse({ output_text: ' plain ' }), 'plain');
    assert.equal(textFromResponse(null), '');
  });
});
