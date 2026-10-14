import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const { createFailureRecoveryRouter } = await import(resolve('./failure-recovery-router.js'));

function neutralDeps(overrides = {}) {
  return {
    classifyFailureFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', errorCode: 'UNCLASSIFIED_FAILURE', message: 'x', recoverable: false }),
    shouldRetryFn: () => false,
    detectCapabilityGapsFn: async () => [],
    decisionEngineFn: { decide: async () => ({ action: 'investigate_further' }) },
    ...overrides,
  };
}

describe('routeFailure — retryable failures never reach the later stages', () => {
  test('EXTERNAL_SERVICE-shaped failure routes to retry without touching capability-gap or decision-engine', async () => {
    let gapCalls = 0, decisionCalls = 0;
    const router = createFailureRecoveryRouter(neutralDeps({
      shouldRetryFn: () => true,
      detectCapabilityGapsFn: async () => { gapCalls++; return []; },
      decisionEngineFn: { decide: async () => { decisionCalls++; return {}; } },
    }));
    const result = await router.routeFailure({ siteId: 1, generatorId: 'x', attempt: 1 });
    assert.equal(result.route, 'retry');
    assert.equal(gapCalls, 0);
    assert.equal(decisionCalls, 0);
  });
});

describe('routeFailure — capability-gap clustering', () => {
  test('routes to capability-gap when a matching cluster exists for this generator', async () => {
    const gap = { generatorId: 'expand-content', affectedCount: 5, summary: 'x', status: 'detected' };
    const router = createFailureRecoveryRouter(neutralDeps({
      detectCapabilityGapsFn: async () => [gap],
    }));
    const result = await router.routeFailure({ siteId: 1, generatorId: 'expand-content', attempt: 4 });
    assert.equal(result.route, 'capability-gap');
    assert.equal(result.capabilityGap, gap);
  });

  test('does not match a cluster for a different generator', async () => {
    const gap = { generatorId: 'expand-content', affectedCount: 5, summary: 'x', status: 'detected' };
    const router = createFailureRecoveryRouter(neutralDeps({
      detectCapabilityGapsFn: async () => [gap],
    }));
    const result = await router.routeFailure({ siteId: 1, generatorId: 'blog-outline', attempt: 4 });
    assert.equal(result.route, 'decision-engine');
  });
});

describe('routeFailure — decision-engine as last resort', () => {
  test('falls through to decision-engine when no retry and no cluster applies', async () => {
    let receivedSituation = null;
    const router = createFailureRecoveryRouter(neutralDeps({
      decisionEngineFn: { decide: async (siteId, situation) => { receivedSituation = situation; return { action: 'investigate_further' }; } },
    }));
    const result = await router.routeFailure({ siteId: 7, generatorId: 'faq', attempt: 4 });
    assert.equal(result.route, 'decision-engine');
    assert.equal(result.decision.action, 'investigate_further');
    assert.match(receivedSituation, /faq/);
  });
});
