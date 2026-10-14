import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPreconditions, registerPrecondition, clearPreconditions,
  registeredPreconditionIds, isPreconditionsEnforcing, PRECONDITION_SEVERITY,
  registerBuiltinPreconditions, structuralFitCheck, fixSuppressedCheck, productKnowledgeCheck,
} from './preconditions.js';

// The built-in checks reach for the repo and the database, so the registry
// is cleared and populated with fakes. The real checks' own behaviour is
// covered by the modules they delegate to (expand-content-structural-fit,
// fix-suppressions, tenant-context), which is the point of delegating.
beforeEach(() => clearPreconditions());

const pass = (id) => ({ id, run: async () => ({ ok: true }) });
const fail = (id, reason = id) => ({ id, run: async () => ({ ok: false, reason, detail: `${id} detail` }) });
const cannotRun = (id) => ({ id, run: async () => null });

describe('registry', () => {
  test('re-registering an id replaces it rather than stacking a second copy', async () => {
    registerPrecondition(pass('a'));
    registerPrecondition(fail('a'));

    assert.deepEqual(registeredPreconditionIds(), ['a']);
    assert.equal((await checkPreconditions({})).ok, false);
  });

  test('a check with no id or no run is refused at registration, not at run time', () => {
    assert.throws(() => registerPrecondition({ run: async () => ({ ok: true }) }));
    assert.throws(() => registerPrecondition({ id: 'x' }));
  });
});

describe('checkPreconditions', () => {
  test('nothing registered, or nothing applicable, is a pass', async () => {
    assert.equal((await checkPreconditions({})).ok, true);

    registerPrecondition({ ...pass('a'), appliesTo: () => false });
    const out = await checkPreconditions({});
    assert.equal(out.ok, true);
    assert.deepEqual(out.checked, []);
  });

  test('every applicable check passing is a pass, and says which ran', async () => {
    registerPrecondition(pass('a'));
    registerPrecondition(pass('b'));

    const out = await checkPreconditions({});
    assert.equal(out.ok, true);
    assert.deepEqual(out.checked.sort(), ['a', 'b']);
  });

  test('"could not run" is NOT a refusal — the central safety property', async () => {
    // A check that cannot see the tenant must not be able to stop the
    // tenant's work. Treating "I could not look" as "it is broken" would
    // take a site's output to zero the moment GitHub had a bad minute.
    registerPrecondition(cannotRun('a'));

    const out = await checkPreconditions({});
    assert.equal(out.ok, true);
    assert.deepEqual(out.skipped, [{ id: 'a' }]);
    assert.deepEqual(out.checked, []);
  });

  test('a check that THROWS is also treated as could-not-run, with the error recorded', async () => {
    registerPrecondition({ id: 'a', run: async () => { throw new Error('repo unreachable'); } });

    const out = await checkPreconditions({});
    assert.equal(out.ok, true);
    assert.equal(out.skipped[0].error, 'repo unreachable');
  });

  test('a check whose applicability test throws is skipped, not treated as a blocker', async () => {
    registerPrecondition({ id: 'a', appliesTo: () => { throw new Error('bad ctx'); }, run: async () => ({ ok: false, reason: 'x' }) });
    assert.equal((await checkPreconditions({})).ok, true);
  });

  test('one failure refuses, and carries the machine-readable reason', async () => {
    registerPrecondition(pass('a'));
    registerPrecondition(fail('b', 'no-prose-region'));

    const out = await checkPreconditions({});
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no-prose-region');
    assert.deepEqual(out.failures.map((f) => f.id), ['b']);
  });

  test('ALL checks run even after one has failed, so the whole list is reported', async () => {
    // Fixing only the first reason would send the draft straight back here.
    let bRan = false;
    registerPrecondition(fail('a'));
    registerPrecondition({ id: 'b', run: async () => { bRan = true; return { ok: false, reason: 'b', detail: 'b detail' }; } });

    const out = await checkPreconditions({});
    assert.equal(bRan, true);
    assert.equal(out.failures.length, 2);
    assert.match(out.detail, /a detail/);
    assert.match(out.detail, /b detail/);
  });

  test('an advisory failure is reported but does not refuse', async () => {
    // 'proposed' product knowledge exists for exactly this case: refusing
    // outright would mean a product tenant whose admin has not finished the
    // form ships nothing at all.
    registerPrecondition({ ...fail('soft'), severity: PRECONDITION_SEVERITY.ADVISORY });

    const out = await checkPreconditions({});
    assert.equal(out.ok, true);
    assert.deepEqual(out.advisories.map((a) => a.id), ['soft']);
  });

  test('advisories are still reported alongside a real refusal', async () => {
    registerPrecondition({ ...fail('soft'), severity: PRECONDITION_SEVERITY.ADVISORY });
    registerPrecondition(fail('hard'));

    const out = await checkPreconditions({});
    assert.equal(out.ok, false);
    assert.deepEqual(out.failures.map((f) => f.id), ['hard']);
    assert.deepEqual(out.advisories.map((a) => a.id), ['soft']);
  });

  test('a check receives the whole context so it can decide applicability itself', async () => {
    const seen = [];
    registerPrecondition({ id: 'a', appliesTo: (ctx) => ctx.actionType === 'expand-content', run: async (ctx) => { seen.push(ctx.pageUrl); return { ok: true }; } });

    await checkPreconditions({ actionType: 'meta-title', pageUrl: '/a' });
    await checkPreconditions({ actionType: 'expand-content', pageUrl: '/b' });

    assert.deepEqual(seen, ['/b']);
  });
});

describe('isPreconditionsEnforcing', () => {
  test('off unless explicitly turned on', () => {
    assert.equal(isPreconditionsEnforcing({}), false);
    assert.equal(isPreconditionsEnforcing({ PRECONDITION_CHECKS_ENABLED: 'yes' }), false);
    assert.equal(isPreconditionsEnforcing({ PRECONDITION_CHECKS_ENABLED: 'true' }), true);
  });
});

describe('the built-in checks', () => {
  test('all three are registered by registerBuiltinPreconditions', () => {
    assert.deepEqual(registerBuiltinPreconditions().sort(), ['design-completeness', 'fix-suppressed', 'product-knowledge', 'structural-fit', 'tsx-component-contract']);
  });

  test('structural-fit applies only to prose action types, and only with a real page', () => {
    const site = { id: 1 };
    assert.equal(structuralFitCheck.appliesTo({ actionType: 'expand-content', site, pageUrl: '/a' }), true);
    assert.equal(structuralFitCheck.appliesTo({ actionType: 'faq', site, pageUrl: '/a' }), true);
    // A metadata-only fix writes no prose, so a page with no prose region is
    // irrelevant to it.
    assert.equal(structuralFitCheck.appliesTo({ actionType: 'meta-title', site, pageUrl: '/a' }), false);
    assert.equal(structuralFitCheck.appliesTo({ actionType: 'expand-content', site }), false);
  });

  test('fix-suppressed applies wherever a page can be named, however it was named', () => {
    assert.equal(fixSuppressedCheck.appliesTo({ siteId: 1, generatorId: 'meta-title', pageUrl: '/a' }), true);
    assert.equal(fixSuppressedCheck.appliesTo({ siteId: 1, generatorId: 'meta-title', params: { page: '/a' } }), true);
    assert.equal(fixSuppressedCheck.appliesTo({ siteId: 1, generatorId: 'meta-title' }), false);
    assert.equal(fixSuppressedCheck.appliesTo({ siteId: 1, pageUrl: '/a' }), false);
  });

  test('product-knowledge applies only to a product tenant writing copy, and is advisory', () => {
    assert.equal(productKnowledgeCheck.severity, PRECONDITION_SEVERITY.ADVISORY);
    assert.equal(productKnowledgeCheck.appliesTo({ site: { property_type: 'product' }, actionType: 'landing-page' }), true);
    assert.equal(productKnowledgeCheck.appliesTo({ site: { property_type: 'website' }, actionType: 'landing-page' }), false);
    // A technical fix needs no product facts.
    assert.equal(productKnowledgeCheck.appliesTo({ site: { property_type: 'product' }, actionType: 'canonical' }), false);
  });
});
