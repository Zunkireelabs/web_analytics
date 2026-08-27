import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Proves the shared capability-derivation flow — missing capability -> real
// repo/data inspection -> derive -> validate -> persist -> re-evaluate ->
// unblock -> normal workflow — is genuinely tenant-agnostic, not something
// that happens to work for Zunkiree. Two unrelated synthetic tenants
// (different repo owner/name, different route/field names, different data
// shapes) exercise the exact SAME code path with no tenant-specific branch
// anywhere in recommendation-gates.js / discover-file-mapping.js /
// pagination-adapter-discovery.js.
//
// Real incident this guards against (2026-08-27): a Docker-build failure
// froze the whole app for ~12.5h, so ~250 recommendations sat blocked with
// stale reasons even though the config that would resolve them already
// existed — self-heal was correct, but nothing had re-run it. These tests
// cover the derivation logic itself; server/job.js's runStartupCatchup and
// server/scripts/connect-repo.js cover the "actually re-run it promptly"
// half separately.
//
// db.js and capability-repairs.js are mocked (persistence side effects only)
// — everything else (autoHealFileMapping, healPaginationAdapter,
// recommendation-gates.js's evaluate()) is the REAL implementation.

const persisted = new Map(); // siteId -> url_file_map
let recordedRepairs = [];

const realDb = await import(resolve('../../db.js'));
mock.module(resolve('../../db.js'), {
  namedExports: {
    ...realDb,
    updateSiteRepoConfig: async ({ siteId, urlFileMap }) => {
      persisted.set(siteId, urlFileMap);
      const base = TENANTS.find((t) => t.id === siteId);
      return { ...base, url_file_map: urlFileMap };
    },
  },
});
mock.module(resolve('../../store/capability-repairs.js'), {
  namedExports: {
    recordCapabilityRepair: async (siteId, attempt) => { recordedRepairs.push({ siteId, ...attempt }); },
    listCapabilityRepairs: async () => [],
  },
});

const { createRecommendationGates } = await import('./recommendation-gates.js');

// Two unrelated tenants: different owner/repo, different route prefixes,
// different data-array field names — nothing shared but the mechanism.
const TENANT_A = { id: 101, repo_owner: 'acme', repo_name: 'marketing-site', repo_default_branch: 'main', url_file_map: {} };
const TENANT_B = { id: 202, repo_owner: 'widgetco', repo_name: 'website', repo_default_branch: 'main', url_file_map: {} };
const TENANTS = [TENANT_A, TENANT_B];

const treeOf = (...files) => async () => ({ files, truncated: false });
const noSoftNotFound = { checkSoftNotFound: () => false, fetchFingerprint: async () => null };
const noDesignStatus = { designAgentStatus: async () => ({ state: 'never_attempted', detail: null }) };

beforeEach(() => { persisted.clear(); recordedRepairs = []; });

// --- Scenario 1: plain existing-page mapping (autoHealFileMapping), no
// pagination route involved — meta-title is not design-gated, so a clean
// `blockedReason === null` is the honest, complete assertion.
describe('self-heal — plain file-mapping gap, across tenants', () => {
  for (const tenant of TENANTS) {
    test(`${tenant.repo_owner}/${tenant.repo_name}: derives, persists, and unblocks when exactly one real file matches`, async () => {
      const site = { ...tenant, url_file_map: {} };
      const gates = createRecommendationGates(site.id, site, {
        fetchTree: treeOf('src/pages/about.njk', 'src/pages/contact.njk'),
        discoverRoutes: async () => [],
        ...noSoftNotFound,
      });

      const result = await gates.evaluate('meta-title', { page: `https://${tenant.repo_name}.example.com/about/` });

      assert.equal(result.blockedReason, null, 'the derived mapping fully resolves this gate');
      assert.deepEqual(persisted.get(tenant.id)?.pages['/about'], { file: 'src/pages/about.njk' });
    });

    test(`${tenant.repo_owner}/${tenant.repo_name}: stays blocked and persists NOTHING when the match is ambiguous`, async () => {
      const site = { ...tenant, url_file_map: {} };
      const gates = createRecommendationGates(site.id, site, {
        fetchTree: treeOf('src/pages/about.njk', 'other/about.njk'),
        discoverRoutes: async () => [],
        ...noSoftNotFound,
      });

      const result = await gates.evaluate('meta-title', { page: `https://${tenant.repo_name}.example.com/about/` });

      assert.match(result.blockedReason || '', /could not be discovered automatically/);
      assert.equal(persisted.has(tenant.id), false, 'an ambiguous match must never be persisted, for any tenant');
    });
  }
});

// --- Scenario 2: pagination data-array adapter (healPaginationAdapter) —
// the exact class of bug behind the 68 "/locations/*" blocked recommendations
// found in production. Each tenant uses its own route prefix, alias, data
// file and field name to prove nothing here is hardcoded to one shape.
function paginationFixture({ routePrefix, alias, dataFile, template, field, items }) {
  const route = {
    template, routePrefix, idField: 'id', alias, dataFile, dataFileAmbiguous: false, layout: 'item.njk',
  };
  const templateSource = `<h1>{{ ${alias}.name }}</h1>\n<p>{{ ${alias}.${field} | safe }}</p>\n`;
  const dataJs = `export default [\n${items.map((it) => (
    `  { id: '${it.id}', name: '${it.name}', ${field}: '${it.value}' },`
  )).join('\n')}\n];\n`;
  return { route, templateSource, dataJs };
}

describe('self-heal — pagination data-array adapter gap, across tenants', () => {
  const cases = [
    {
      tenant: TENANT_A,
      pageUrl: 'https://marketing-site.example.com/branches/kathmandu/',
      field: 'overview',
      ...paginationFixture({
        routePrefix: '/branches', alias: 'branch', dataFile: 'src/_data/branches.js',
        template: 'src/branches/branch-pages.njk', field: 'overview',
        items: [{ id: 'kathmandu', name: 'Kathmandu', value: 'Our flagship branch.' }],
      }),
    },
    {
      tenant: TENANT_B,
      pageUrl: 'https://website.example.com/locations/bhaktapur/',
      field: 'description',
      ...paginationFixture({
        routePrefix: '/locations', alias: 'location', dataFile: 'src/_data/locations.js',
        template: 'src/locations/location-pages.njk', field: 'description',
        items: [{ id: 'bhaktapur', name: 'Bhaktapur', value: 'A historic city.' }],
      }),
    },
  ];

  for (const { tenant, pageUrl, route, templateSource, dataJs, field } of cases) {
    test(`${tenant.repo_owner}/${tenant.repo_name}: derives, persists, and unblocks the adapter when exactly one field is unambiguous`, async () => {
      const site = { ...tenant, url_file_map: {} };
      const gates = createRecommendationGates(site.id, site, {
        fetchTree: async () => ({ files: [route.template], truncated: false }),
        fetchFile: async (_s, path) => {
          if (path === route.dataFile) return { content: dataJs };
          if (path === route.template) return { content: templateSource };
          return null;
        },
        discoverRoutes: async () => [route],
        ...noSoftNotFound,
        ...noDesignStatus,
      });

      const result = await gates.evaluate('expand-content', { page: pageUrl });

      // expand-content is also gated on a SEPARATE design-verification check
      // (component template) — a fresh fixture legitimately fails that too.
      // What this test owns is that the adapter-specific reason is gone.
      assert.doesNotMatch(result.blockedReason || '', /Configure a data-array-content adapter/, 'the adapter gap itself must be resolved');

      const cfg = persisted.get(tenant.id);
      assert.ok(cfg, 'the derived adapter config must be persisted');
      const pattern = cfg.patterns.find((p) => p.match.includes(route.routePrefix.slice(1)));
      assert.equal(pattern.adapters['expand-content'].dataFile, route.dataFile);
      assert.equal(pattern.adapters['expand-content'].fields.expandedContent, field);
    });

    test(`${tenant.repo_owner}/${tenant.repo_name}: stays blocked and persists NOTHING when no field is unambiguously rendered raw`, async () => {
      const site = { ...tenant, url_file_map: {} };
      // Template renders nothing matching FIELD_ACTION_TYPES's raw-filter
      // evidence bar for expand-content — genuinely not derivable.
      const noEvidenceTemplate = `<h1>{{ ${route.alias}.name }}</h1>\n`;
      const gates = createRecommendationGates(site.id, site, {
        fetchTree: async () => ({ files: [route.template], truncated: false }),
        fetchFile: async (_s, path) => {
          if (path === route.dataFile) return { content: dataJs };
          if (path === route.template) return { content: noEvidenceTemplate };
          return null;
        },
        discoverRoutes: async () => [route],
        ...noSoftNotFound,
        ...noDesignStatus,
      });

      const result = await gates.evaluate('expand-content', { page: pageUrl });

      assert.match(result.blockedReason || '', /Configure a data-array-content adapter/);
      assert.equal(persisted.has(tenant.id), false, 'a genuinely ambiguous adapter case must never be persisted, for any tenant');
      assert.ok(recordedRepairs.some((r) => r.siteId === tenant.id && r.capabilityType === 'url-file-map-adapter' && r.outcome === 'ambiguous'));
    });
  }
});

// --- Idempotency: healing must be attempted at most once per (page,
// actionType) per pass, for any tenant — never a retry loop, and never
// double work when several findings share the same page.
describe('self-heal — idempotent within a pass, across tenants', () => {
  for (const tenant of TENANTS) {
    test(`${tenant.repo_owner}/${tenant.repo_name}: one repo-tree read serves every finding on the same page`, async () => {
      let treeReads = 0;
      const site = { ...tenant, url_file_map: {} };
      const gates = createRecommendationGates(site.id, site, {
        fetchTree: async () => { treeReads++; return { files: ['src/pages/about.njk'], truncated: false }; },
        discoverRoutes: async () => [],
        ...noSoftNotFound,
      });

      await gates.evaluate('meta-title', { page: `https://${tenant.repo_name}.example.com/about/` });
      await gates.evaluate('schema', { page: `https://${tenant.repo_name}.example.com/about/` });
      await gates.evaluate('canonical', { page: `https://${tenant.repo_name}.example.com/about/` });

      assert.equal(treeReads, 1, 'the repo tree is cached for the whole pass, not re-fetched per finding');
      assert.equal(persisted.get(tenant.id)?.pages['/about']?.file, 'src/pages/about.njk');
    });
  }
});
