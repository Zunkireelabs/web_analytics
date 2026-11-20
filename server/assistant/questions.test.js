import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { staticAnswer, suggestedQuestions, STATIC_ANSWERS, QUESTION_GROUPS } from './questions.js';
import { classifyIntent, composeWeek, handleMessage } from './assistant.js';
import { invokeCapability } from './capabilities.js';

describe('the top 15 questions', () => {
  test('there are exactly 15, in four groups, no duplicates', () => {
    const all = QUESTION_GROUPS.flatMap((g) => g.questions);
    assert.equal(all.length, 15);
    assert.equal(new Set(all).size, 15);
    assert.equal(QUESTION_GROUPS.length, 4);
    assert.equal(suggestedQuestions().total, 15);
  });
  test('the five quick ones are all among the 15', () => {
    const all = new Set(QUESTION_GROUPS.flatMap((g) => g.questions));
    for (const q of suggestedQuestions().quick) assert.ok(all.has(q), q);
  });
  test('every question has an answer path: a fixed answer or a data intent', () => {
    for (const q of QUESTION_GROUPS.flatMap((g) => g.questions)) {
      const hasFixed = Boolean(staticAnswer(q));
      const intent = classifyIntent(q);
      assert.ok(hasFixed || intent !== 'unknown' || /AI visibility|competitor|traffic/.test(q), `no path for: ${q}`);
    }
  });
});

describe('fixed plain-English answers', () => {
  test('exact questions and natural wordings resolve', () => {
    assert.match(staticAnswer('What is AEO?'), /answer engine/);
    assert.match(staticAnswer('whats geo'), /describe your business/);
    assert.match(staticAnswer('What does "on stage" mean?'), /private copy/);
    assert.match(staticAnswer('explain pull request'), /package of changes/);
    assert.match(staticAnswer('What happens when I approve?'), /one commit/);
  });
  test('a data question is not answered with a fixed text', () => {
    assert.equal(staticAnswer('What is waiting for me?'), null);
    assert.equal(staticAnswer('Is my AI visibility improving?'), null);
  });
  test('no fixed answer names a client, a URL or a number', () => {
    for (const a of Object.values(STATIC_ANSWERS)) { assert.doesNotMatch(a, /https?:|\.com|\.io|\d/); }
  });
  test('handleMessage answers a fixed question without reading any site data', async () => {
    const r = await handleMessage({ ctx: { siteId: 1, role: 'tenant_member' }, message: 'What is AEO?', deps: {} });
    assert.equal(r.data.fixed, true);
    assert.match(r.message, /answer engine/);
  });
});

describe('week and broken questions reach the right intent', () => {
  test('intents', () => {
    assert.equal(classifyIntent('What changed on my site this week?'), 'week');
    assert.equal(classifyIntent('Is anything broken?'), 'failures');
    assert.equal(classifyIntent('What did the agents do today?'), 'agent_work');
    assert.equal(classifyIntent('What is waiting for me?'), 'findings');
  });
  test('week summary reads only this site and says what went live', async () => {
    let seen;
    const db = async (sql, params) => { seen = params; return { rows: [{ action_type: 'meta-title', n: 3 }, { action_type: 'faq', n: 1 }] }; };
    const r = await invokeCapability('get_week_summary', { siteId: 9, role: 'tenant_member' }, {}, { db });
    assert.deepEqual(seen, [9]);
    assert.equal(r.data.total, 4);
    assert.match(composeWeek(r.data), /4 changes went live in the last 7 days: 3 meta title, 1 faq/);
    assert.match(composeWeek({ total: 0, byType: [] }), /Nothing has gone live/);
  });
  test('get_suggested_questions is open to every role', async () => {
    const r = await invokeCapability('get_suggested_questions', { siteId: 1, role: 'tenant_member' });
    assert.equal(r.data.total, 15);
  });
});
