import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveDesignLesson, findDesignKnowledge, captureBaseline, recordDesignFix, recordDesignFailure,
  recordDesignIssues, recordKnowledgeReuse, attachImpactToLessons,
} from './design-knowledge.js';
import { buildDesignLesson } from '../design-agent/lib/design-knowledge.js';

const fakeDb = (script = []) => {
  const calls = [];
  const queryFn = async (sql, params) => { calls.push({ sql, params }); const next = script.shift(); return next || { rows: [], rowCount: 0 }; };
  return { calls, queryFn };
};
const lesson = (over = {}) => buildDesignLesson({ kind: 'fix', patternId: 'bare-unstyled-markup', pageUrl: 'https://a.com/features/x', draftId: 3, ...over });

describe('saveDesignLesson', () => {
  test('refuses a lesson with no tenant — a design lesson must never be a wildcard', async () => {
    const db = fakeDb();
    assert.equal(await saveDesignLesson(null, lesson(), db), null);
    assert.equal(db.calls.length, 0);
  });
  test('inserts a new site-scoped design row', async () => {
    const db = fakeDb([{ rows: [] }, { rows: [{ id: 42 }] }]);
    assert.equal(await saveDesignLesson(7, lesson(), db), 42);
    const insert = db.calls[1];
    assert.match(insert.sql, /INSERT INTO agent_fix_memory/);
    assert.match(insert.sql, /'design'/);
    assert.equal(insert.params[0], 7);
    assert.equal(insert.params.includes('draft:3'), true);
  });
  test('reinforces an existing lesson instead of duplicating it, merging context', async () => {
    const db = fakeDb([{ rows: [{ id: 9, design_context: { evidence: ['old'], files: ['f'] } }] }, { rows: [{ id: 9 }] }]);
    assert.equal(await saveDesignLesson(7, lesson({ detail: 'new evidence' }), db), 9);
    assert.match(db.calls[1].sql, /UPDATE agent_fix_memory/);
    const merged = JSON.parse(db.calls[1].params[1]);
    assert.ok(merged.evidence.includes('old') && merged.evidence.includes('new evidence'));
  });
  test('fix and anti-pattern lessons for the same signature are separate rows', async () => {
    const db = fakeDb([{ rows: [] }, { rows: [{ id: 1 }] }]);
    await saveDesignLesson(7, lesson({ kind: 'anti-pattern' }), db);
    assert.equal(db.calls[0].params[1], 'anti-pattern');
  });
  test('a database failure never throws into the caller', async () => {
    const queryFn = async () => { throw new Error('boom'); };
    assert.equal(await saveDesignLesson(7, lesson(), { queryFn }), null);
  });
});

describe('findDesignKnowledge', () => {
  const row = (id, ctx, extra = {}) => ({ id, lesson_kind: 'fix', problem_signature: 's', symptoms: 'x', root_cause: 'r', fix_strategy: 'f', fix_pattern: null, confidence: '0.6', occurrence_count: 1, status: 'candidate', design_context: ctx, ...extra });
  test('queries strictly this site and the design category — no wildcard rows', async () => {
    const db = fakeDb([{ rows: [] }]);
    await findDesignKnowledge(7, {}, db);
    assert.match(db.calls[0].sql, /category = 'design' AND site_id = \$1/);
    assert.doesNotMatch(db.calls[0].sql, /site_id IS NULL/);
    assert.deepEqual(db.calls[0].params, [7]);
  });
  test('returns nothing without a site', async () => {
    const db = fakeDb();
    assert.deepEqual(await findDesignKnowledge(null, {}, db), []);
    assert.equal(db.calls.length, 0);
  });
  test('ranks by the job in hand', async () => {
    const db = fakeDb([{ rows: [row(1, { family: 'blog', patternId: 'a' }), row(2, { family: 'feature', patternId: 'b' })] }]);
    const out = await findDesignKnowledge(7, { family: 'feature' }, db);
    assert.deepEqual(out.map((r) => r.id), [2]);
  });
  test('a lookup failure is an empty list, not a crash', async () => {
    assert.deepEqual(await findDesignKnowledge(7, {}, { queryFn: async () => { throw new Error('x'); } }), []);
  });
});

describe('baseline and impact', () => {
  test('captureBaseline reads the 28 days before the fix', async () => {
    let seen;
    const out = await captureBaseline(7, 'https://a.com/p', {
      now: new Date('2026-10-08T10:00:00Z'),
      totalsFn: async (...a) => { seen = a; return { impressions: 500, clicks: 20 }; },
    });
    assert.deepEqual(seen, [7, 'https://a.com/p', '2026-09-10', '2026-10-07']);
    assert.equal(out.impressions, 500);
    assert.ok(out.capturedAt);
  });
  test('a page with no impressions yields no baseline (none is not zero)', async () => {
    assert.equal(await captureBaseline(7, 'https://a.com/p', { totalsFn: async () => null }), null);
    assert.equal(await captureBaseline(7, null), null);
  });
  test('recordDesignFix stores the baseline on the lesson', async () => {
    const db = fakeDb([{ rows: [] }, { rows: [{ id: 5 }] }]);
    await recordDesignFix(7, { patternId: 'inline-style', pageUrl: 'https://a.com/p', draftId: 2 }, { ...db, totalsFn: async () => ({ impressions: 77 }) });
    const ctx = JSON.parse(db.calls[1].params.at(-1));
    assert.equal(ctx.baseline.impressions, 77);
  });
  test('an explicit null baseline (a net-new page) is respected, not re-queried', async () => {
    let called = false;
    const db = fakeDb([{ rows: [] }, { rows: [{ id: 5 }] }]);
    await recordDesignFix(7, { patternId: 'inline-style', baseline: null }, { ...db, totalsFn: async () => { called = true; return {}; } });
    assert.equal(called, false);
  });
  test('measured impact is attached to the lessons of that draft, for that site', async () => {
    const db = fakeDb([{ rowCount: 2 }]);
    assert.equal(await attachImpactToLessons(7, 3, { delta: { clicks: 4 } }, db), 2);
    assert.match(db.calls[0].sql, /source_ref = \$2/);
    assert.deepEqual(db.calls[0].params.slice(0, 2), [7, 'draft:3']);
  });
  test('attaching impact with nothing to attach is a no-op', async () => {
    const db = fakeDb();
    assert.equal(await attachImpactToLessons(7, null, { a: 1 }, db), 0);
    assert.equal(await attachImpactToLessons(7, 3, null, db), 0);
    assert.equal(db.calls.length, 0);
  });
});

describe('recordDesignIssues / recordKnowledgeReuse', () => {
  test('records only the design issues from a mixed set', async () => {
    const db = fakeDb();
    const queryFn = async (sql, params) => { db.calls.push({ sql, params }); return sql.includes('INSERT') ? { rows: [{ id: db.calls.length }] } : { rows: [] }; };
    const ids = await recordDesignIssues(7, 'anti-pattern', [{ patternId: 'todo-marker' }, { patternId: 'inline-style', detail: 'd' }], { generatorId: 'g' }, { queryFn });
    assert.equal(ids.length, 1);
  });
  test('reuse outcomes flow back only for fix lessons (an anti-pattern is not a reusable fix)', async () => {
    const seen = [];
    await recordKnowledgeReuse(
      [{ id: 1, lessonKind: 'fix' }, { id: 2, lessonKind: 'anti-pattern' }], 'success',
      { siteId: 7, generatorId: 'g', recordFn: async (a) => { seen.push(a.memoryRefId); } },
    );
    assert.deepEqual(seen, [1]);
  });
  test('a failing reuse write does not throw', async () => {
    await recordKnowledgeReuse([{ id: 1, lessonKind: 'fix' }], 'failure', { recordFn: async () => { throw new Error('x'); } });
  });
});
