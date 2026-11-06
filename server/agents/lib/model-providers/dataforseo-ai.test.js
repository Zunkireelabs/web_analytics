import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as provider from './dataforseo-ai.js';

// What this adapter exists to get right: a citation is a FACT read from real structured sources, not something a
// second model is asked to infer; an engine that showed no AI answer is a measurement, not an error; and no paid
// call happens without an explicit opt-in and a site to bill it to.

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'AI_CITATION_TRACKING_ENABLED', 'AI_CITATION_ENGINES']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});
function enable(engines) {
  process.env.DATAFORSEO_LOGIN = 'u';
  process.env.DATAFORSEO_PASSWORD = 'p';
  process.env.AI_CITATION_TRACKING_ENABLED = 'true';
  if (engines) process.env.AI_CITATION_ENGINES = engines;
}
const ok = (items, costUsd = 0.004) => ({ ok: true, costUsd, body: { tasks: [{ result: [{ items }] }] } });
function spy(result) {
  const calls = [];
  return { calls, dataforseoCall: async (args) => { calls.push(args); return result; } };
}

describe('opt-in', () => {
  test('it is off until its own switch is set, even with DataForSEO credentials present', () => {
    process.env.DATAFORSEO_LOGIN = 'u';
    process.env.DATAFORSEO_PASSWORD = 'p';
    delete process.env.AI_CITATION_TRACKING_ENABLED;
    assert.equal(provider.configured(), false);
    process.env.AI_CITATION_TRACKING_ENABLED = 'true';
    assert.equal(provider.configured(), true);
  });

  test('it is off without credentials, however the switch is set', () => {
    process.env.AI_CITATION_TRACKING_ENABLED = 'true';
    delete process.env.DATAFORSEO_LOGIN;
    assert.equal(provider.configured(), false);
  });

  test('asking while switched off throws instead of spending', async () => {
    delete process.env.AI_CITATION_TRACKING_ENABLED;
    await assert.rejects(() => provider.ask('q', { siteId: 1 }), /not true/);
  });

  test('a missing siteId throws, so no paid call is unattributed', async () => {
    enable();
    await assert.rejects(() => provider.ask('q', {}), /siteId/);
  });

  test('an unrecognised engine list falls back to one engine, never to all of them', () => {
    enable('nonsense,alsonothing');
    assert.deepEqual(provider.enabledEngines(), ['google_ai_overview']);
  });

  test('the engine list is honoured and filtered to known engines', () => {
    enable('chatgpt,gemini,bogus');
    assert.deepEqual(provider.enabledEngines(), ['chatgpt', 'gemini']);
  });
});

describe('reading a Google AI Overview', () => {
  const overviewItems = [
    { type: 'organic', url: 'https://other.com/x' },
    {
      type: 'ai_overview',
      items: [{ text: 'Teeth whitening in Pokhara costs around NPR 8,000.', references: [{ url: 'https://ourclinic.com/whitening' }] }],
      references: [{ url: 'https://rival.com/prices' }],
    },
  ];

  test('it reads the answer text and the real cited sources', async () => {
    enable('google_ai_overview');
    const deps = spy(ok(overviewItems));
    const out = await provider.ask('teeth whitening cost pokhara', { siteId: 3, deps });
    assert.equal(out.engine, 'google_ai_overview');
    assert.match(out.raw, /costs around NPR 8,000/);
    assert.deepEqual(out.citedDomains, ['ourclinic.com', 'rival.com']);
    assert.match(out.raw, /Sources:/);
  });

  test('a SERP with no AI Overview is an empty answer, not a failure', async () => {
    enable('google_ai_overview');
    const out = await provider.ask('q', { siteId: 3, deps: spy(ok([{ type: 'organic', url: 'https://a.com' }])) });
    assert.equal(out.empty, true);
    assert.equal(out.raw, '');
    assert.deepEqual(out.citedDomains, []);
  });

  test('the overview is requested explicitly, since Google loads it separately', async () => {
    enable('google_ai_overview');
    const deps = spy(ok([]));
    await provider.ask('q', { siteId: 3, locationCode: 2524, deps });
    assert.equal(deps.calls[0].body[0].load_async_ai_overview, true);
    assert.equal(deps.calls[0].body[0].location_code, 2524);
  });
});

describe('reading a scraped assistant answer', () => {
  test('it reads text and sources from an assistant answer', async () => {
    enable('chatgpt');
    const items = [{
      text: 'For dental implants in Pokhara, consider these clinics.',
      sections: [{ text: 'Our Clinic is well reviewed.', links: [{ url: 'https://ourclinic.com/implants' }] }],
      annotations: [{ url: 'https://rival.com/implants' }],
    }];
    const out = await provider.ask('best dental implants pokhara', { siteId: 3, deps: spy(ok(items)) });
    assert.equal(out.model, 'chatgpt');
    assert.match(out.raw, /consider these clinics/);
    assert.deepEqual(out.citedDomains.sort(), ['ourclinic.com', 'rival.com']);
  });

  test('it asks with live web access, which is how a real session behaves', async () => {
    enable('chatgpt');
    const deps = spy(ok([]));
    await provider.ask('q', { siteId: 3, deps });
    assert.equal(deps.calls[0].body[0].web_search, true);
    assert.equal(deps.calls[0].job, 'ai-citation-tracking');
    assert.equal(deps.calls[0].siteId, 3);
  });

  test('a budget refusal says so plainly rather than looking like a provider fault', async () => {
    enable('chatgpt');
    const deps = spy({ ok: false, reason: 'budget_refused', spentUsd: 2, budgetUsd: 2 });
    await assert.rejects(() => provider.ask('q', { siteId: 3, deps }), /monthly provider budget/);
  });

  test('an unknown engine is refused before any call', async () => {
    enable();
    const deps = spy(ok([]));
    await assert.rejects(() => provider.ask('q', { siteId: 3, engine: 'bard', deps }), /Unknown AI engine/);
    assert.equal(deps.calls.length, 0);
  });
});

describe('askAll across engines', () => {
  test('it returns one result per enabled engine', async () => {
    enable('chatgpt,gemini');
    const results = await provider.askAll('q', { siteId: 3, deps: spy(ok([{ text: 'answer' }])) });
    assert.deepEqual(results.map((r) => r.engine), ['chatgpt', 'gemini']);
  });

  test('one engine failing does not hide the others', async () => {
    // Both engines here are assistant scrapers, so one fixture shape fits both; mixing in the AI Overview would need
    // its own differently-shaped response and would be testing the parsers, not the failure handling.
    enable('chatgpt,gemini');
    let n = 0;
    const deps = { dataforseoCall: async () => { n += 1; return n === 1 ? { ok: false, reason: 'failed', error: 'HTTP 500' } : ok([{ text: 'answer' }]); } };
    const results = await provider.askAll('q', { siteId: 3, deps });
    assert.match(results[0].error, /HTTP 500/);
    assert.match(results[1].raw, /answer/);
  });

  test('a budget refusal stops the remaining engines instead of retrying per engine', async () => {
    enable('chatgpt,gemini,google_ai_overview');
    const deps = spy({ ok: false, reason: 'budget_refused', spentUsd: 2, budgetUsd: 2 });
    const results = await provider.askAll('q', { siteId: 3, deps });
    assert.equal(results.length, 1);
    assert.equal(deps.calls.length, 1);
  });
});

describe('extraction is a fact, not an inference', () => {
  const ctx = { companyName: 'Our Clinic', domain: 'ourclinic.com', competitorDomains: ['rival.com', 'other.com'] };

  test('a citation of our own domain counts as mentioned', async () => {
    const out = await provider.extract('Some answer.\n\nSources:\nhttps://ourclinic.com/whitening', ctx);
    assert.equal(out.mentioned, true);
    assert.equal(out.approximatePosition, 1);
  });

  test('being named in the prose counts even without a citation', async () => {
    const out = await provider.extract('Our Clinic is a good option.', ctx);
    assert.equal(out.mentioned, true);
    assert.equal(out.approximatePosition, null, 'not cited, so there is no position to report');
  });

  test('not being there at all is reported honestly', async () => {
    const out = await provider.extract('Try these other places.\n\nSources:\nhttps://rival.com/a', ctx);
    assert.equal(out.mentioned, false);
    assert.equal(out.approximatePosition, null);
  });

  test('the position is where our citation falls among the sources', async () => {
    const out = await provider.extract('a\n\nSources:\nhttps://rival.com/a\nhttps://other.com/b\nhttps://ourclinic.com/c', ctx);
    assert.equal(out.approximatePosition, 3);
  });

  test('a subdomain of our domain still counts as us', async () => {
    const out = await provider.extract('a\n\nSources:\nhttps://clinic.ourclinic.com/x', ctx);
    assert.equal(out.mentioned, true);
  });

  test('only competitors that were really cited are listed', async () => {
    const out = await provider.extract('a\n\nSources:\nhttps://rival.com/a\nhttps://unrelated.com/b', ctx);
    assert.deepEqual(out.competitorsMentioned, ['rival.com']);
  });

  test('tone is left unjudged rather than invented', async () => {
    const out = await provider.extract('Our Clinic is the best.', ctx);
    assert.equal(out.sentiment, null);
    assert.equal(out.recommendationStrength, null);
  });

  test('extraction needs no credentials and no second model call', async () => {
    delete process.env.AI_CITATION_TRACKING_ENABLED;
    const out = await provider.extract('a\n\nSources:\nhttps://ourclinic.com/x', ctx);
    assert.equal(out.mentioned, true);
  });

  test('empty or junk input does not throw', async () => {
    for (const input of ['', null, undefined]) {
      const out = await provider.extract(input, ctx);
      assert.equal(out.mentioned, false);
      assert.deepEqual(out.citedDomains, []);
    }
  });
});
