import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExpandStructurePrior } from './expand-structure-loader.js';
import { SPEC_VERSION } from './expand-structure-spec.js';

const spec = { version: SPEC_VERSION, sectionCount: { min: 2, max: 3 }, sectionOrder: ['hero', 'content', 'cta'], shapes: { content: 'card' }, headingLevels: { content: 'section' }, tableUsage: { allowed: false }, placement: { anchor: 'after-last-content-section', before: ['cta'] } };
const optedIn = { id: 1, url_file_map: { siteRoot: { expandStructureRef: true, designProfile: { pages: [] } } } };
const getSpec = async () => ({ version: 1, spec });

describe('loadExpandStructurePrior — containment', () => {
  test('a tenant that has not opted in gets nothing, and the spec is never even read', async () => {
    let reads = 0;
    const r = await loadExpandStructurePrior({ id: 2, url_file_map: { siteRoot: {} } }, { deps: { getSpec: async () => { reads++; return { spec }; } } });
    assert.equal(r, null);
    assert.equal(reads, 0);
  });

  test('ONLY expand-content can ever receive it — a hard assertion, not a convention', async () => {
    for (const actionType of ['blog-outline', 'landing-page', 'faq', 'direct-answer', 'translation', 'meta-title']) {
      assert.equal(await loadExpandStructurePrior(optedIn, { actionType, deps: { getSpec } }), null, actionType);
    }
  });

  test('an opted-in tenant on expand-content gets a prior built from the reference', async () => {
    const r = await loadExpandStructurePrior(optedIn, { actionType: 'expand-content', deps: { getSpec } });
    assert.deepEqual(r.sectionCount, { min: 2, max: 3 });
    assert.equal(r.sources.sectionCount, 'reference');
  });

  test('the opt-in must be the literal boolean true, not a truthy string', async () => {
    const r = await loadExpandStructurePrior({ id: 3, url_file_map: { siteRoot: { expandStructureRef: 'yes' } } }, { deps: { getSpec } });
    assert.equal(r, null);
  });

  test('no spec saved yet, or a read failure, is null — never a throw into generation', async () => {
    assert.equal(await loadExpandStructurePrior(optedIn, { deps: { getSpec: async () => null } }), null);
    assert.equal(await loadExpandStructurePrior(optedIn, { deps: { getSpec: async () => { throw new Error('db down'); } } }), null);
  });

  test('a spec that fails the identity firewall yields no prior at all', async () => {
    const leaky = { ...spec, shapes: { content: 'text-2xl' } };
    assert.equal(await loadExpandStructurePrior(optedIn, { deps: { getSpec: async () => ({ spec: leaky }) } }), null);
  });
});

// Invariant test, same style as the DEDUP_IDENTITY ledger test: the reference
// is consulted by exactly the modules meant to, so a future generator cannot
// quietly start borrowing another site's structure.
describe('containment invariant — who may import the structure reference', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const ALLOWED = new Set([
    'design-agent/lib/expand-structure-spec.js', 'design-agent/lib/expand-structure-loader.js',
    'design-agent/lib/expand-structure-spec.test.js', 'design-agent/lib/expand-structure-loader.test.js',
    'store/expand-structure.js', 'scripts/derive-expand-structure-spec.js',
    'generators/expand-content.js', 'implementers/backend.js',
    'design-agent/live-analysis/compose-expand-layout.js', 'design-agent/live-analysis/compose-expand-layout-prior.test.js', 'design-agent/live-analysis-handler.js',
  ]);
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });

  test('no other module imports expand-structure-spec, -loader, or the store', () => {
    const offenders = walk(root)
      .map((p) => relative(root, p))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /expand-structure-(spec|loader)|store\/expand-structure/.test(readFileSync(join(root, rel), 'utf8').split('\n').filter((l) => /^\s*(import |.*await import\()/.test(l)).join('\n')));
    assert.deepEqual(offenders, []);
  });

  test('the only GENERATOR allowed to use it is expand-content', () => {
    const generators = walk(join(root, 'generators')).map((p) => relative(root, p)).filter((r) => !r.endsWith('.test.js'));
    const users = generators.filter((rel) => /expand-structure/.test(readFileSync(join(root, rel), 'utf8')));
    assert.deepEqual(users, ['generators/expand-content.js']);
  });
});
