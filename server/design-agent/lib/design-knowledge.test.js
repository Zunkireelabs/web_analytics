import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageFamilyOf, designSignature, buildDesignLesson, mergeDesignContext, rankDesignKnowledge,
  formatDesignKnowledge, isDesignPattern, designIssues,
} from './design-knowledge.js';

describe('pageFamilyOf — the tenant\'s own word for a kind of page', () => {
  test('uses the first path segment, singular, not a fixed vocabulary', () => {
    assert.equal(pageFamilyOf('https://a.com/features/voice'), 'feature');
    assert.equal(pageFamilyOf('https://a.com/solutions/crm'), 'solution');
    assert.equal(pageFamilyOf('https://a.com/case-studies/x'), 'case-study');
    assert.equal(pageFamilyOf('https://a.com/servicios/x'), 'servicio');
    assert.equal(pageFamilyOf('/blog/post'), 'blog');
  });
  test('Feature and Solution are different families even though the URL regex files both under service', () => {
    assert.notEqual(pageFamilyOf('https://a.com/features/x'), pageFamilyOf('https://a.com/solutions/x'));
  });
  test('home and unparseable input do not throw', () => {
    assert.equal(pageFamilyOf('https://a.com/'), 'home');
    assert.equal(typeof pageFamilyOf(undefined), 'string');
  });
});

describe('buildDesignLesson', () => {
  test('a fix lesson records reason, correction, evidence, files and baseline', () => {
    const l = buildDesignLesson({
      kind: 'fix', patternId: 'bare-unstyled-markup', pageUrl: 'https://a.com/features/x', pageType: 'service',
      detail: 'h2 had no classes', correction: 'wrap headings in the site heading classes', files: ['src/a.tsx', 'src/a.tsx'],
      validation: { passed: true, attempts: 2 }, baseline: { impressions: 120 }, draftId: 5, generatorId: 'landing-page',
    });
    assert.equal(l.kind, 'fix');
    assert.equal(l.signature, 'design:feature:typography:bare-unstyled-markup');
    assert.equal(l.context.family, 'feature');
    assert.equal(l.context.component, 'typography');
    assert.deepEqual(l.context.files, ['src/a.tsx']);
    assert.equal(l.context.baseline.impressions, 120);
    assert.equal(l.sourceRef, 'draft:5');
    assert.ok(l.rootCause);
    assert.equal(l.fixPattern, 'wrap headings in the site heading classes');
  });
  test('an anti-pattern keeps what was tried and has no reusable fix pattern', () => {
    const l = buildDesignLesson({ kind: 'anti-pattern', patternId: 'render-deviation', pageUrl: 'https://a.com/blog/x', correction: 'bumped h2 to text-3xl' });
    assert.equal(l.fixPattern, null);
    assert.match(l.fixStrategy, /^Do not repeat:/);
    assert.deepEqual(l.context.triedFix, ['bumped h2 to text-3xl']);
  });
  test('the signature separates page families so a Feature lesson is not a Solution lesson', () => {
    const a = buildDesignLesson({ kind: 'fix', patternId: 'structure-section-order', pageUrl: 'https://a.com/features/x' });
    const b = buildDesignLesson({ kind: 'fix', patternId: 'structure-section-order', pageUrl: 'https://a.com/solutions/x' });
    assert.notEqual(a.signature, b.signature);
  });
  test('an unknown pattern still builds a lesson rather than throwing', () => {
    assert.ok(buildDesignLesson({ kind: 'fix', patternId: 'nope' }).signature.includes('nope'));
  });
});

describe('mergeDesignContext', () => {
  test('evidence, files and tried fixes accumulate without duplicates; newest validation wins; baseline is kept', () => {
    const m = mergeDesignContext(
      { evidence: ['a'], files: ['f1'], triedFix: ['x'], baseline: { impressions: 10 }, validation: { passed: false } },
      { evidence: ['a', 'b'], files: ['f2'], triedFix: ['x', 'y'], baseline: null, validation: { passed: true } },
    );
    assert.deepEqual(m.evidence, ['a', 'b']);
    assert.deepEqual(m.files, ['f1', 'f2']);
    assert.deepEqual(m.triedFix, ['x', 'y']);
    assert.equal(m.baseline.impressions, 10, 'a later lesson with no baseline must not erase the earlier one');
    assert.equal(m.validation.passed, true);
  });
  test('a recorded impact is never overwritten by a later merge', () => {
    assert.deepEqual(mergeDesignContext({ impact: { x: 1 } }, { impact: { x: 2 } }).impact, { x: 1 });
  });
});

describe('rankDesignKnowledge / formatDesignKnowledge', () => {
  const row = (id, ctx, over = {}) => ({ id, lessonKind: 'fix', confidence: 0.5, designContext: ctx, rootCause: 'why', fixStrategy: 'do this', ...over });
  test('same pattern and family outranks an unrelated lesson', () => {
    const r = rankDesignKnowledge([
      row(1, { patternId: 'other', family: 'blog', component: 'color' }),
      row(2, { patternId: 'structure-section-order', family: 'feature', component: 'page-structure' }),
    ], { patternIds: ['structure-section-order'], family: 'feature' });
    assert.equal(r[0].id, 2);
  });
  test('with a known job, a lesson that matches nothing is not shown', () => {
    assert.deepEqual(rankDesignKnowledge([row(1, { patternId: 'x', family: 'blog' })], { patternIds: ['y'], family: 'feature' }), []);
  });
  test('formats what worked and what did not, and is null with nothing to say', () => {
    assert.equal(formatDesignKnowledge([]), null);
    const txt = formatDesignKnowledge([row(1, {}), row(2, {}, { lessonKind: 'anti-pattern', fixStrategy: 'Do not repeat: bumped h2' })]);
    assert.match(txt, /What worked: do this/);
    assert.match(txt, /did NOT hold/);
    assert.match(txt, /- bumped h2/);
  });
  test('design pattern helpers', () => {
    assert.equal(isDesignPattern('structure-section-count'), true);
    assert.equal(isDesignPattern('todo-marker'), false);
    assert.deepEqual(designIssues([{ patternId: 'todo-marker' }, { patternId: 'inline-style' }]).map((i) => i.patternId), ['inline-style']);
  });
});
