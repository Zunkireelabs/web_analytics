import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpServer } from './index.js';

// The property that matters most: a tool that SPENDS MONEY must not be reachable by a read-only token, and every
// paid tool must announce its cost in its own description so an assistant can tell the difference before calling it.

const toolsFor = (level) => buildMcpServer(1, level, 1)._registeredTools || {};

const PAID = ['research_market_competitors', 'research_competitor_keywords', 'research_competitor_pages'];
const FREE = [
  'get_market_competitors', 'get_competitor_footprint', 'get_competitor_movement',
  'get_growth_opportunities', 'get_rank_movement', 'get_rank_history',
  'list_tracked_keywords', 'get_provider_spend',
];

describe('who can spend money', () => {
  test('a read-only token gets every stored-data research tool', () => {
    const names = Object.keys(toolsFor('read_only'));
    for (const name of FREE) assert.ok(names.includes(name), `read_only should have ${name}`);
  });

  test('a read-only token cannot reach any paid research tool', () => {
    const names = Object.keys(toolsFor('read_only'));
    for (const name of PAID) assert.ok(!names.includes(name), `read_only must NOT have ${name}`);
  });

  test('the ai_actions tier still cannot spend', () => {
    const names = Object.keys(toolsFor('ai_actions'));
    for (const name of PAID) assert.ok(!names.includes(name), `ai_actions must NOT have ${name}`);
  });

  test('the automation tier and above can', () => {
    for (const level of ['automation', 'admin']) {
      const names = Object.keys(toolsFor(level));
      for (const name of PAID) assert.ok(names.includes(name), `${level} should have ${name}`);
    }
  });

  test('keyword tracking sits with the paid tier, because it commits future spend', () => {
    assert.ok(!Object.keys(toolsFor('read_only')).includes('track_keyword'));
    assert.ok(Object.keys(toolsFor('automation')).includes('track_keyword'));
  });
});

describe('an assistant can tell what a tool will cost', () => {
  const tools = toolsFor('automation');

  test('every paid tool says so in capitals, up front', () => {
    for (const name of PAID) {
      const description = tools[name]?.description || '';
      assert.match(description, /COSTS MONEY/, name);
      assert.match(description, /get_provider_spend/, `${name} should point at the spend check`);
    }
  });

  test('every free research tool says it costs nothing', () => {
    for (const name of FREE.filter((n) => n !== 'get_provider_spend')) {
      assert.match(tools[name]?.description || '', /no cost|Costs nothing/i, name);
    }
  });

  test('the keyword tracker explains its ceiling rather than failing silently', () => {
    assert.match(tools.track_keyword?.description || '', /cap_reached/);
  });

  test('tools that report a null position explain what null means', () => {
    assert.match(tools.get_rank_movement?.description || '', /position null/);
    assert.match(tools.get_rank_movement?.description || '', /never treat it as position 0/);
  });

  test('the competitor list explains that organic competitors are not rivals', () => {
    assert.match(tools.get_market_competitors?.description || '', /directories, publishers/);
  });

  test('movement explains why null is not "no change"', () => {
    assert.match(tools.get_competitor_movement?.description || '', /not the same as no change/);
  });
});

describe('registration is sane', () => {
  test('no research tool name collides with an existing tool', () => {
    const names = Object.keys(toolsFor('admin'));
    assert.equal(new Set(names).size, names.length, 'duplicate tool names');
  });

  test('each tier is a superset of the one below', () => {
    const read = new Set(Object.keys(toolsFor('read_only')));
    const auto = Object.keys(toolsFor('automation'));
    for (const name of read) assert.ok(auto.includes(name), `automation lost ${name}`);
  });

  test('every research tool declares an input schema', () => {
    const tools = toolsFor('automation');
    for (const name of [...FREE, ...PAID, 'track_keyword']) {
      assert.ok(tools[name]?.inputSchema !== undefined, `${name} has no inputSchema`);
    }
  });
});
