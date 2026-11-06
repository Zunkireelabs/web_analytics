import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import nodeCron from 'node-cron';
import { pipelineCronExpressions, schedulePipelineCron, pipelineOwnsMorning, runShipJob } from './cron.js';
import { pipelineConfig } from './config.js';

const quiet = { log: () => {}, error: () => {}, warn: () => {} };
const fakeCron = () => { const jobs = []; return { jobs, validate: nodeCron.validate, schedule: (expr, fn, opts) => jobs.push({ expr, fn, opts }) }; };

describe('pipeline cron schedule (Asia/Kathmandu)', () => {
  test('defaults: start 05:30, live design 07:45, hourly guard 08:20-10:20, ship 11:00', () => {
    assert.deepEqual(pipelineCronExpressions(pipelineConfig({})), { start: '30 5 * * *', resume: '45 7 * * *', guard: '20 8-10 * * *', ship: '0 11 * * *' });
  });
  test('OFF by default: nothing is scheduled and the legacy lanes keep the morning', () => {
    const c = fakeCron();
    assert.deepEqual(schedulePipelineCron({ cron: c, locked: async () => {}, config: pipelineConfig({}), log: quiet }), { scheduled: false });
    assert.equal(c.jobs.length, 0);
    assert.equal(pipelineOwnsMorning({}, c), false);
  });
  test('enabled: four schedules, every one pinned to the pipeline timezone', () => {
    const c = fakeCron(); const env = { DAILY_PIPELINE_ENABLED: 'true' };
    const r = schedulePipelineCron({ cron: c, locked: async () => {}, config: pipelineConfig(env), log: quiet });
    assert.equal(r.scheduled, true);
    assert.deepEqual(c.jobs.map((j) => j.expr), ['30 5 * * *', '45 7 * * *', '20 8-10 * * *', '0 11 * * *']);
    for (const j of c.jobs) assert.deepEqual(j.opts, { timezone: 'Asia/Kathmandu' });
    assert.equal(pipelineOwnsMorning(env, c), true);
  });
  test('an invalid setting never strands the day: the pipeline is not scheduled AND the legacy lanes are NOT told to stand down', () => {
    const c = fakeCron(); const env = { DAILY_PIPELINE_ENABLED: 'true', PIPELINE_START_CRON: 'not a cron' };
    const r = schedulePipelineCron({ cron: c, locked: async () => {}, config: pipelineConfig(env), log: quiet });
    assert.equal(r.invalid, true); assert.equal(c.jobs.length, 0);
    assert.equal(pipelineOwnsMorning(env, c), false);
  });
});

describe('the 11:00 job', () => {
  test('ships prepared work first, then drains the shared queues (drain-only), then the learning update', async () => {
    const order = [];
    await runShipJob({ config: pipelineConfig({}), log: quiet,
      shipPrepared: async () => { order.push('prepared'); return { results: [] }; },
      drainSharedQueues: async () => { order.push('drain'); }, learningUpdate: async () => { order.push('learning'); } });
    assert.deepEqual(order, ['prepared', 'drain', 'learning']);
  });
  test('when the ship guard refuses (before 11:00 / prepared-only off) nothing else runs', async () => {
    const order = [];
    const r = await runShipJob({ config: pipelineConfig({}), log: quiet,
      shipPrepared: async () => ({ skipped: 'before 11:00' }),
      drainSharedQueues: async () => { order.push('drain'); }, learningUpdate: async () => { order.push('learning'); } });
    assert.deepEqual(order, []); assert.equal(r.shipped.skipped, 'before 11:00');
  });
  test('a failing drain does not cost the learning update, and neither hides the shipped result', async () => {
    const order = [];
    const r = await runShipJob({ config: pipelineConfig({}), log: quiet,
      shipPrepared: async () => ({ results: [{ siteId: 1, shipped: 2 }] }),
      drainSharedQueues: async () => { throw new Error('boom'); }, learningUpdate: async () => { order.push('learning'); return { ok: 1 }; } });
    assert.deepEqual(order, ['learning']); assert.equal(r.shipped.results[0].shipped, 2); assert.equal(r.drained, null);
  });
});
