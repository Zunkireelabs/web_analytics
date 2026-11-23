import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runStreamingChat, cleanHistory, MAX_TOOL_TURNS, FRIENDLY_ERROR, EMPTY_ANSWER } from './chat-stream.js';
import { runTool, toolDefs } from './chat-tools.js';

const ctx = { siteId: 7, userId: 1, role: 'tenant_member' };

// A fake conversation store + persona, so nothing here touches a database or a model.
function fakeDeps(over = {}) {
  const saved = [];
  const deps = {
    staticAnswer: () => null,
    handleMessage: async () => ({ deferred: true }),
    resolvePersona: async () => ({ systemPrompt: 'PERSONA' }),
    createConversation: async () => ({ id: 99 }),
    getConversation: async () => null,
    getRecentMessages: async () => [],
    saveMessage: async (...a) => { saved.push(a); },
    buildRecommendations: async () => ({ items: [] }),
    toolDefs: () => [{ type: 'function', function: { name: 'get_pr_activity' } }],
    ...over,
  };
  return { deps, saved };
}
const collect = () => { const events = []; return { events, emit: (e) => events.push(e) }; };
const types = (events) => events.map((e) => e.type);

describe('layer 1: no model call', () => {
  test('a fixed answer arrives at once and never reaches the model', async () => {
    const { deps } = fakeDeps({ staticAnswer: () => 'AEO means…', streamChat: async () => { throw new Error('model must not be called'); } });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'what is AEO?', emit, deps });
    assert.deepEqual(types(events), ['delta', 'final']);
    assert.equal(events[1].message, 'AEO means…');
  });

  test('a record-backed answer (handleMessage) is sent as is, with its actions, and the model is never called', async () => {
    const { deps } = fakeDeps({
      handleMessage: async () => ({ message: 'No pull request was opened today.', actions: [{ id: 'x', label: 'Y' }], data: { period: 'today' } }),
      streamChat: async () => { throw new Error('model must not be called'); },
    });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'any PR today?', emit, deps });
    assert.deepEqual(types(events), ['delta', 'final']);
    assert.deepEqual(events[1].actions, [{ id: 'x', label: 'Y' }]);
    assert.equal(events[1].data.period, 'today');
  });

  test('handleMessage is asked to defer the AI path rather than run it', async () => {
    let seen;
    const { deps } = fakeDeps({ handleMessage: async (a) => { seen = a.deps.deferAi; return { deferred: true }; }, streamChat: async () => ({ text: 'ok', toolCalls: [] }) });
    await runStreamingChat({ ctx, message: 'why did traffic drop', emit: () => {}, deps });
    assert.equal(seen, true);
  });
});

describe('layer 2: the streamed AI answer', () => {
  test('streams words, saves the conversation, and finishes with the whole answer', async () => {
    const { deps, saved } = fakeDeps({
      streamChat: async ({ onText, system, messages }) => {
        assert.match(system, /PERSONA/);
        assert.match(system, /Plain text only/);
        assert.deepEqual(messages, [{ role: 'user', content: 'hello' }]);
        onText('Hi'); onText(' there');
        return { text: 'Hi there', toolCalls: [] };
      },
    });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'hello', emit, deps });
    assert.deepEqual(types(events), ['delta', 'delta', 'final']);
    assert.equal(events[2].message, 'Hi there');
    assert.equal(events[2].data.conversationId, 99);
    assert.deepEqual(saved.map((s) => [s[1], s[2]]), [['user', 'hello'], ['assistant', 'Hi there']]);
  });

  test('looks things up mid-answer: status, tool result handed back, then the answer', async () => {
    const calls = [];
    const turns = [
      { text: '', toolCalls: [{ id: 't1', name: 'get_pr_activity', args: { period: 'today' } }] },
      { text: 'Nothing went out today.', toolCalls: [] },
    ];
    const { deps } = fakeDeps({
      runTool: async (name, args) => ({ content: JSON.stringify({ opened: [] }), cited: [] }),
      streamChat: async ({ messages, onText }) => {
        calls.push(messages.map((m) => m.role));
        const t = turns.shift();
        if (t.text) onText(t.text);
        return t;
      },
    });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'anything go out lately', emit, deps });
    assert.deepEqual(types(events), ['status', 'delta', 'final']);
    assert.match(events[0].text, /pull requests/);
    assert.deepEqual(calls[1], ['user', 'assistant', 'tool'], 'the second turn sees the lookup and its result');
    assert.equal(events[2].message, 'Nothing went out today.');
  });

  test('text said before a lookup stays, and the next words start a new paragraph', async () => {
    const turns = [
      { text: 'Let me check.', toolCalls: [{ id: 't1', name: 'get_needs_you', args: {} }] },
      { text: 'Two things are waiting.', toolCalls: [] },
    ];
    const { deps } = fakeDeps({
      runTool: async () => ({ content: '{}', cited: [] }),
      streamChat: async ({ onText }) => { const t = turns.shift(); onText(t.text); return t; },
    });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'q', emit, deps });
    assert.equal(events.at(-1).message, 'Let me check.\n\nTwo things are waiting.');
  });

  test('earlier messages of the conversation are sent, minus a leading assistant turn', async () => {
    let sent;
    const { deps } = fakeDeps({
      getConversation: async () => ({ id: 5 }),
      getRecentMessages: async () => [{ role: 'assistant', content: 'old answer' }, { role: 'user', content: 'first q' }, { role: 'assistant', content: 'first a' }],
      streamChat: async ({ messages }) => { sent = messages; return { text: 'ok', toolCalls: [] }; },
    });
    await runStreamingChat({ ctx, message: 'follow up', conversationId: 5, emit: () => {}, deps });
    assert.deepEqual(sent.map((m) => [m.role, m.content]), [['user', 'first q'], ['assistant', 'first a'], ['user', 'follow up']]);
  });

  test('the model cannot loop forever: the last allowed turn offers no tools', async () => {
    let turns = 0; let lastToolCount = null;
    const { deps } = fakeDeps({
      runTool: async () => ({ content: '{}', cited: [] }),
      streamChat: async ({ tools, onText }) => {
        turns += 1; lastToolCount = tools.length;
        if (tools.length) return { text: '', toolCalls: [{ id: `c${turns}`, name: 'get_needs_you', args: {} }] };
        onText('Here is what I have.'); return { text: 'Here is what I have.', toolCalls: [] };
      },
    });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'q', emit, deps });
    assert.equal(turns, MAX_TOOL_TURNS + 1);
    assert.equal(lastToolCount, 0);
    assert.equal(events.at(-1).type, 'final');
  });

  test('findings come back with a Generate-draft action only when the Action Center can really draft them', async () => {
    const turns = [{ text: '', toolCalls: [{ id: 't', name: 'get_findings', args: {} }] }, { text: 'Two issues.', toolCalls: [] }];
    const { deps } = fakeDeps({
      runTool: async () => ({ content: '{}', cited: [{ id: 'f1', whyItMatters: 'a', evidence: {} }, { id: 'f2', whyItMatters: 'b', evidence: {} }] }),
      buildRecommendations: async () => ({ items: [{ id: 'f1', generatorId: 'faq', params: { page: '/x' }, tag: 'FAQ', source: 'geo' }] }),
      streamChat: async ({ onText }) => { const t = turns.shift(); if (t.text) onText(t.text); return t; },
    });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'what should I fix', emit, deps });
    const cited = events.at(-1).data.citedFindings;
    assert.equal(cited.find((f) => f.id === 'f1').actionable.generatorId, 'faq');
    assert.equal(cited.find((f) => f.id === 'f2').actionable, null);
  });

  test('an empty model reply becomes a plain sentence, not a blank bubble', async () => {
    const { deps } = fakeDeps({ streamChat: async () => ({ text: '', toolCalls: [] }) });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'q', emit, deps });
    assert.equal(events.at(-1).message, EMPTY_ANSWER);
  });
});

describe('failure and stopping', () => {
  test('the model failing yields one friendly error, no leaked detail', async () => {
    const { deps } = fakeDeps({ streamChat: async () => { throw new Error('401 invalid api key sk-secret'); } });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'q', emit, deps });
    assert.deepEqual(types(events), ['error']);
    assert.equal(events[0].message, FRIENDLY_ERROR);
    assert.doesNotMatch(JSON.stringify(events), /sk-secret/);
  });

  test('a failure after some words says so, so the screen keeps what was shown', async () => {
    const { deps } = fakeDeps({ streamChat: async ({ onText }) => { onText('Partly'); throw new Error('dropped'); } });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'q', emit, deps });
    assert.equal(events.at(-1).type, 'error');
    assert.equal(events.at(-1).partial, true);
  });

  test('a closed chat stops the work quietly', async () => {
    const controller = new AbortController();
    const { deps } = fakeDeps({ streamChat: async () => { controller.abort(); throw new Error('aborted'); } });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'q', emit, signal: controller.signal, deps });
    assert.deepEqual(events, []);
  });
});

describe('cleanHistory', () => {
  test('drops empty rows and leading assistant turns', () => {
    assert.deepEqual(cleanHistory([{ role: 'assistant', content: 'a' }, { role: 'user', content: '' }, { role: 'user', content: 'q' }]), [{ role: 'user', content: 'q' }]);
  });
});

describe('tools stay inside the caller\'s project and read-only', () => {
  test('no tool takes a site id, and none can change anything', () => {
    for (const t of toolDefs()) {
      const props = Object.keys(t.function.parameters.properties || {});
      assert.ok(!props.some((p) => /site|tenant|client/i.test(p)), `${t.function.name} must not take a site id`);
      assert.doesNotMatch(t.function.name, /^(approve|confirm|run|push|open|delete|update|submit|save|generate)/);
    }
  });

  test('capability tools run with the session\'s own project, never a model-supplied one', async () => {
    let seen;
    const r = await runTool('get_pr_activity', { period: 'today', siteId: 999 }, ctx, { invokeCapability: async (name, c, args) => { seen = { name, siteId: c.siteId }; return { ok: true, data: { opened: [] } }; } });
    assert.deepEqual(seen, { name: 'get_pr_activity', siteId: 7 });
    assert.equal(r.content, JSON.stringify({ opened: [] }));
  });

  test('a refused or failing tool tells the model so, it does not throw', async () => {
    const refused = await runTool('get_needs_you', {}, ctx, { invokeCapability: async () => ({ ok: false, remedy: 'not allowed' }) });
    assert.match(refused.content, /not allowed/);
    const broken = await runTool('get_needs_you', {}, ctx, { invokeCapability: async () => { throw new Error('db down: password=abc'); } });
    assert.match(broken.content, /failed just now/);
    assert.doesNotMatch(broken.content, /password/);
    assert.match((await runTool('nonsense', {}, ctx)).content, /unknown tool/);
  });

  test('long results are cut so one lookup cannot flood the model', async () => {
    const r = await runTool('get_needs_you', {}, ctx, { invokeCapability: async () => ({ ok: true, data: { blob: 'x'.repeat(20000) } }) });
    assert.ok(r.content.length < 6200);
    assert.match(r.content, /shortened/);
  });
});

describe('data tools', () => {
  test('findings: most important first, no agent names for a client, with how old the analysis is', async () => {
    const getLatestFindings = async () => [
      { agentId: 'technical-seo', createdAt: '2026-11-21T00:00:00Z', findings: [{ id: 'low1', priority: 'low', whyItMatters: 'minor' }, { id: 'hi1', priority: 'high', whyItMatters: 'major', evidence: { page: '/a' } }] },
      { agentId: 'opportunity', createdAt: '2026-11-22T00:00:00Z', findings: [{ id: 'med1', priority: 'medium', whyItMatters: 'mid' }] },
    ];
    const client = await runTool('get_findings', { limit: 2 }, ctx, { getLatestFindings });
    const data = JSON.parse(client.content);
    assert.deepEqual(data.findings.map((f) => f.id), ['hi1', 'med1']);
    assert.equal(data.asOf, '2026-11-21T00:00:00.000Z');
    assert.equal(data.totalFindings, 3);
    assert.ok(!client.content.includes('technical-seo'), 'a client never sees agent names');
    assert.deepEqual(client.cited.map((f) => f.id), ['hi1', 'med1']);
    assert.deepEqual(client.cited[0].evidence, { page: '/a' });
    const admin = JSON.parse((await runTool('get_findings', {}, { ...ctx, role: 'platform_admin' }, { getLatestFindings })).content);
    assert.equal(admin.findings[0].agent, 'technical-seo');
  });

  test('traffic: ends on the newest day with data (as the Overview does) and compares with the same-length window before', async () => {
    const asked = [];
    const r = await runTool('get_traffic', { days: 7 }, ctx, {
      getScreenDataRange: async () => ({ freshest: '2026-11-19' }),
      getRangeTotals: async (siteId, start, end) => { asked.push([siteId, start, end]); return { clicks: asked.length === 1 ? 70 : 35, impressions: 1000, avg_position: '8.5', users: 20, sessions: 30 }; },
    });
    assert.deepEqual(asked, [[7, '2026-11-13', '2026-11-19'], [7, '2026-11-06', '2026-11-12']]);
    const data = JSON.parse(r.content);
    assert.equal(data.recent.clicks, 70);
    assert.equal(data.previous.clicks, 35);
    assert.equal(data.recent.avgPosition, 8.5);
  });

  test('traffic and queries say so plainly when no search data exists yet', async () => {
    const none = { getScreenDataRange: async () => ({ freshest: null }) };
    assert.match((await runTool('get_traffic', {}, ctx, none)).content, /No search data/);
    assert.match((await runTool('get_top_queries', {}, ctx, none)).content, /No search data/);
  });

  test('top queries are limited and clamped', async () => {
    let asked;
    const r = await runTool('get_top_queries', { days: 500, limit: 99 }, ctx, {
      getScreenDataRange: async () => ({ freshest: '2026-11-19' }),
      getSearchPerformanceRange: async (siteId, start, end, dim, limit) => { asked = { siteId, dim, limit }; return [{ dim_value: 'seo', clicks: '5', impressions: '100', avg_position: '4.2' }]; },
    });
    assert.deepEqual(asked, { siteId: 7, dim: 'query', limit: 20 });
    assert.deepEqual(JSON.parse(r.content).queries, [{ query: 'seo', clicks: 5, impressions: 100, avgPosition: 4.2 }]);
    assert.equal(JSON.parse(r.content).days, 90);
  });
});

describe('closing the chat mid-answer', () => {
  test('a half-written answer is never saved or sent, even if the provider returns it as complete', async () => {
    const controller = new AbortController();
    const { deps, saved } = fakeDeps({ streamChat: async ({ onText }) => { onText('Half an ans'); controller.abort(); return { text: 'Half an ans', toolCalls: [] }; } });
    const { events, emit } = collect();
    await runStreamingChat({ ctx, message: 'q', emit, signal: controller.signal, deps });
    assert.deepEqual(saved.map((s) => s[1]), ['user'], 'only the question is saved, no assistant message');
    assert.ok(!events.some((e) => e.type === 'final'), 'no final answer is sent');
  });
});
