import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../db.js';
import { withAgentMemory } from '../agent-memory.js';
import { withCompetitorContext, _clearCompetitorPolicyCache } from '../agents/lib/competitor-policy.js';
import { withDesignContext } from '../implementers/lib/design-drift.js';
import { DESIGN_PROFILE_VERSION } from '../design-agent/lib/design-profile.js';

// P1 Phase 2. Real Postgres, local database only. Three guards the existing isolation tests do not give:
//   1. every table in the schema is classified: a new table with no tenant key fails until someone decides what it is,
//   2. the analyst's client_id tables really are bound to a tenant, and the OAuth lookalikes are not mistaken for tenants,
//   3. nothing the model is shown for one project can contain another project's data, and no code path asks the analyst
//      service about a project the caller did not name.
// Reference: docs/architecture/p1-isolation-audit.md.

const TAG = `tiso${Date.now()}`;
const siteIds = []; const wsIds = [];
after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM agent_fix_memory WHERE site_id = ANY($1::int[]) OR symptoms LIKE $2', [siteIds, `%${TAG}%`]);
    await query('DELETE FROM competitor_profiles WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  if (wsIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [wsIds]);
  await pool.end();
});

async function newSite(label, urlFileMap = {}) {
  const ws = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-${label}`])).rows[0].id; wsIds.push(ws);
  const id = (await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain, url_file_map) VALUES ($1,$2,$2,'UTC',$3,$4,$5::jsonb) RETURNING id`,
    [`${TAG} ${label}`, `${TAG}-${label}`, ws, `${label.toLowerCase()}.${TAG}.example`, JSON.stringify(urlFileMap)])).rows[0].id; siteIds.push(id);
  return id;
}

// ── 1. every table is classified ───────────────────────────────────────────────────────────────────────────────────
// Class: A instance-private (reached through a parent), B shared knowledge, D platform / pre-tenant, ROOT tenant root.
// `via` names the table whose foreign key carries the tenant. Update this list in the same change that adds a table.
const CLASSIFIED = {
  // A: reach a tenant through a parent
  approval_history: { cls: 'A', via: 'investigations' }, investigation_events: { cls: 'A', via: 'investigations' },
  forecast_points: { cls: 'A', via: 'forecast_runs' }, feature_importance_scores: { cls: 'A', via: 'feature_importance_runs' },
  root_cause_analysis_nodes: { cls: 'A', via: 'root_cause_analysis_runs' }, copilot_messages: { cls: 'A', via: 'copilot_conversations' },
  watchlist_item_history: { cls: 'A', via: 'watchlist_items' }, execution_job_recommendations: { cls: 'A', via: 'execution_jobs' },
  product_growth_config: { cls: 'A', via: 'products' }, prospects: { cls: 'A', via: 'products' }, trial_signups: { cls: 'A', via: 'products' },
  audit_log: { cls: 'A', via: 'sites' },
  // D: pre-tenant or credentials, reached through users
  password_resets: { cls: 'D', via: 'users' }, get_started_signups: { cls: 'D', via: 'users' }, onboarding_drafts: { cls: 'D', via: 'users' },
  return_requests: { cls: 'D', via: 'users' }, signup_resume_links: { cls: 'D', via: 'users' }, signup_requests: { cls: 'D', via: 'users' },
  free_audit_leads: { cls: 'D', via: 'free_audit_reports' },
  // D: platform tables, no tenant data
  alembic_version: { cls: 'D' }, schema_migrations: { cls: 'D' }, session: { cls: 'D' }, job_locks: { cls: 'D' }, rate_limits: { cls: 'D' },
  platform_activations: { cls: 'D' }, signup_recovery_settings: { cls: 'D' }, contact_requests: { cls: 'D' }, free_audit_reports: { cls: 'D' },
  model_registry: { cls: 'D' }, model_registry_log: { cls: 'D', via: 'model_registry' }, training_datasets: { cls: 'D' }, login_codes: { cls: 'D' },
  // B: shared knowledge by design (aggregate or public)
  industry_knowledge: { cls: 'B' }, industry_knowledge_log: { cls: 'B', via: 'industry_knowledge' },
  commoncrawl_backlink_domains: { cls: 'B' }, commoncrawl_backlink_summary: { cls: 'B' }, commoncrawl_graph_releases: { cls: 'B' },
  metrics_catalog: { cls: 'B' }, metric_dimension_support: { cls: 'B', via: 'metrics_catalog' },
  // Roots
  workspaces: { cls: 'ROOT', via: 'sites' }, clients: { cls: 'ROOT' },
  // NEEDS A DECISION (docs/architecture/p1-isolation-audit.md section 1.4): listed so a change in their status is noticed.
  query_translations: { cls: 'REVIEW' }, expand_structure_specs: { cls: 'REVIEW' }, engineering_fix_lessons: { cls: 'REVIEW' }, internal_errors: { cls: 'REVIEW' },
};

describe('every table is classified', () => {
  test('a table with no tenant key is either listed above or fails this test', async () => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
       EXCEPT SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('site_id','workspace_id','client_id')`);
    const unclassified = rows.map((r) => r.table_name).filter((t) => !CLASSIFIED[t]);
    assert.deepEqual(unclassified, [], `new table(s) with no tenant key: add each to CLASSIFIED with a class and, if it reaches a tenant through a parent, its parent. Do not just add it to make this pass: decide what it is.`);
  });

  test('every table listed as reached through a parent still has a foreign key to that parent', async () => {
    const { rows } = await query(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace`);
    const fk = new Set(rows.map((r) => `${r.child}>${r.parent}`));
    const broken = Object.entries(CLASSIFIED).filter(([t, v]) => v.via && v.cls !== 'ROOT' && t !== 'login_codes' && !fk.has(`${t}>${v.via}`)).map(([t, v]) => `${t} -> ${v.via}`);
    assert.deepEqual(broken, [], 'the route to a tenant for these tables is no longer a foreign key');
  });

  test('every parent used above carries a tenant key itself, directly or through another classified table', async () => {
    const { rows } = await query(
      `SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('site_id','workspace_id','client_id')`);
    const keyed = new Set(rows.map((r) => r.table_name));
    const reaches = (t, seen = new Set()) => {
      if (keyed.has(t)) return true;
      if (seen.has(t)) return false; seen.add(t);
      const v = CLASSIFIED[t]; return !!(v?.via && reaches(v.via, seen));
    };
    const orphans = Object.entries(CLASSIFIED).filter(([, v]) => v.cls === 'A').map(([t]) => t).filter((t) => !reaches(t));
    assert.deepEqual(orphans, [], 'class A tables must reach a tenant');
  });
});

// ── 2. the analyst's client_id tables ──────────────────────────────────────────────────────────────────────────────
const OAUTH_LOOKALIKES = ['oauth_access_tokens', 'oauth_authorization_codes', 'oauth_refresh_tokens'];
describe('the analyst client_id tables', () => {
  test('all 23 tenant tables have client_id NOT NULL and a foreign key to clients; the OAuth lookalikes point at oauth_clients', async () => {
    const { rows } = await query(`
      SELECT t.table_name, col.is_nullable,
             (SELECT c.confrelid::regclass::text FROM pg_constraint c WHERE c.contype='f' AND c.conrelid = ('public.'||t.table_name)::regclass
                AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) AND a.attname='client_id') LIMIT 1) AS refs
        FROM information_schema.tables t JOIN information_schema.columns col ON col.table_name=t.table_name AND col.table_schema='public' AND col.column_name='client_id'
       WHERE t.table_schema='public' AND t.table_type='BASE TABLE' ORDER BY 1`);
    const tenant = rows.filter((r) => !OAUTH_LOOKALIKES.includes(r.table_name) && r.table_name !== 'oauth_clients');
    assert.ok(tenant.length === 23, `expected exactly 23 analyst tenant tables (a new one must be added to this count on purpose), found ${tenant.length}`);
    // ai_activity_log is the one deliberate exception: a stage-level feed of what the nightly pipeline is doing, "NOT per-client"
    // (data-analyst-agent/app/db/models.py, AiActivityLog), with client_id left null. Any other nullable client_id is a leak path.
    const NULLABLE_BY_DESIGN = ['ai_activity_log'];
    for (const r of tenant) {
      assert.equal(r.refs, 'clients', `${r.table_name}.client_id must reference clients`);
      if (!NULLABLE_BY_DESIGN.includes(r.table_name)) assert.equal(r.is_nullable, 'NO', `${r.table_name}.client_id must be NOT NULL: a row with no tenant belongs to everyone`);
    }
    assert.deepEqual(tenant.filter((r) => r.is_nullable === 'YES').map((r) => r.table_name), NULLABLE_BY_DESIGN, 'the set of nullable client_id tables changed');
    for (const t of OAUTH_LOOKALIKES) {
      assert.equal(rows.find((r) => r.table_name === t)?.refs, 'oauth_clients', `${t} is an OAuth application table, not a tenant table`);
    }
  });

  test('clients and sites cannot silently drift: the link is a convention, so the provisioning code is the only writer', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const writers = [];
    const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (f === 'node_modules') continue; if (statSync(p).isDirectory()) walk(p); else if (/\.js$/.test(f) && !/\.test\.js$/.test(f) && /INSERT INTO clients\b/i.test(readFileSync(p, 'utf8'))) writers.push(relative(root, p)); } };
    walk(root);
    assert.deepEqual(writers, [], 'Node must not write the analyst clients table directly: it goes through provisionAnalystClient (the analyst service owns that table)');
  });

  test('every Node call to the analyst service names a project it was given, or sits behind the platform-admin gate', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = [];
    // scripts/ holds operator command-line tools a person runs by hand; they are not reachable from a request or the scheduler.
    const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (f === 'node_modules' || p === join(root, 'scripts')) continue; if (statSync(p).isDirectory()) walk(p); else if (/\.js$/.test(f) && !/\.test\.js$/.test(f) && !/data-analyst-client\.js$/.test(f)) files.push(p); } };
    walk(root);
    const calls = []; const refs = [];
    for (const p of files) {
      const src = readFileSync(p, 'utf8');
      const file = relative(root, p);
      // The client may be imported under another name (routes/dataAnalyst.js calls it `callPython`), so find every name it goes by.
      const names = new Set(['callDataAnalystAgent']);
      for (const m of src.matchAll(/callDataAnalystAgent\s+as\s+(\w+)/g)) names.add(m[1]);
      for (const name of names) {
        for (const m of src.matchAll(new RegExp(`\\b${name}\\(\\s*([\`'"])([^\`'"]*)\\1`, 'g'))) calls.push({ file, path: m[2] });
        // handed to another function as a value rather than called here (import lines are not uses)
        const body = src.replace(/^import[\s\S]*?;\s*$/gm, '');
        for (const m of body.matchAll(new RegExp(`\\b${name}\\b(?!\\s*\\()`, 'g'))) refs.push({ file, name, at: m.index });
      }
    }
    assert.ok(calls.length >= 30, `found only ${calls.length} analyst calls: the scan is probably broken (routes/dataAnalyst.js alone has about 30)`);

    // 1. Staff-only proxy: paths take :clientId from the URL, which is fine only because EVERY route in the file is behind the platform
    //    admin gate, and the client-facing mirror overwrites :clientId with the session's own site.
    const STAFF_PROXY = 'routes/dataAnalyst.js';
    const proxy = readFileSync(join(root, STAFF_PROXY), 'utf8');
    assert.match(proxy, /router\.use\(requireAuth, requirePlatformRole\('platform_admin'\)\)/, 'the staff proxy lost its platform-admin gate');
    assert.ok(proxy.indexOf("router.use(requireAuth, requirePlatformRole('platform_admin'))") < proxy.indexOf('router.get('), 'the gate must come before the first route');
    assert.match(proxy, /req\.params\.clientId = String\(req\.siteId\)/, 'the client mirror must force :clientId to the session\'s own site');
    assert.doesNotMatch(proxy, /clientAnalystRouter\.\w+\([^)]*req\.params\.clientId\s*=\s*req\.(params|query|body)/, 'the mirror must not take the client from the request');

    // 2. Everywhere else: a site id must be in the path, or the call is a known platform-wide one.
    const PLATFORM_WIDE = new Map([['/admin/learning', 'routes/platform.js']]);
    const unscoped = calls.filter((c) => c.file !== STAFF_PROXY && !/\$\{[^}]*siteId[^}]*\}/.test(c.path) && PLATFORM_WIDE.get(c.path) !== c.file);
    assert.deepEqual(unscoped, [], 'an analyst call without a site id in its path would read across clients; add it to PLATFORM_WIDE only with a reason');

    // 3. Handed over as a value (job.js gives it to the paged insight feed): allowed only where the receiver builds every path from a site id.
    const REFERENCE_ALLOWED = new Map([['job.js', 'lib/analyst-insight-feed.js'], ['lib/tenant-provisioning.js', 'lib/tenant-provisioning.js']]);
    for (const { file } of refs) {
      const receiver = REFERENCE_ALLOWED.get(file);
      assert.ok(receiver, `${file} passes the analyst client by reference: allow it only if the receiver scopes every path to a site id`);
      const body = readFileSync(join(root, receiver), 'utf8');
      const paths = [...body.matchAll(/\bcall\(\s*`([^`]*)`/g)].map((m) => m[1]);
      assert.ok(paths.length >= 1 && paths.every((p) => /\$\{[^}]*(siteId|site\.id)[^}]*\}/.test(p)), `${receiver} must build every analyst path from a site id`);
    }
  });
});

// ── 3. what the model is shown for one project never contains another's ───────────────────────────────────────────
describe('model-context injectors (real database)', () => {
  test('agent memory: a lesson written for A is never in B\'s prompt; shared (no-site) lessons are the only crossing', async () => {
    const A = await newSite('A'); const B = await newSite('B');
    const gen = `gen-${TAG}`;
    const ins = (siteId, symptoms) => query(
      `INSERT INTO agent_fix_memory (category, scope, status, execution_permission, site_id, generator_id, problem_signature, symptoms, affected_pattern, fix_strategy)
       VALUES ('content','client','trusted','informational',$1,$2,$3,$4,'generalized','strategy')`, [siteId, gen, `sig-${siteId}-${Math.random()}`, symptoms]);
    await ins(A, `SECRET-A-${TAG} only project A has this problem`);
    await ins(B, `SECRET-B-${TAG} only project B has this problem`);
    await ins(null, `SHARED-${TAG} a generalized lesson for everyone`);
    const forA = await withAgentMemory('SYS', gen, A);
    const forB = await withAgentMemory('SYS', gen, B);
    assert.match(forA, new RegExp(`SECRET-A-${TAG}`), 'positive control: A sees its own lesson');
    assert.match(forB, new RegExp(`SECRET-B-${TAG}`), 'positive control: B sees its own lesson');
    assert.ok(!forA.includes(`SECRET-B-${TAG}`), "A's prompt contains B's lesson");
    assert.ok(!forB.includes(`SECRET-A-${TAG}`), "B's prompt contains A's lesson");
    assert.match(forA, new RegExp(`SHARED-${TAG}`));
    assert.match(forB, new RegExp(`SHARED-${TAG}`));
  });

  test('agent memory: a lesson with no site is shared with EVERY project, so site-specific text must never be written there', async () => {
    // This documents the design rather than a defect: site_id NULL is the "cross-tenant wildcard" (migration 097).
    // The test makes the consequence explicit so nobody writes a site-specific lesson with a missing site id.
    const A = await newSite('A2'); const B = await newSite('B2');
    const gen = `gen2-${TAG}`;
    await query(`INSERT INTO agent_fix_memory (category, scope, status, execution_permission, site_id, generator_id, problem_signature, symptoms, affected_pattern, fix_strategy)
                 VALUES ('content','client','trusted','informational',NULL,$1,'sig-null','NULL-SITE-${TAG}','p','s')`, [gen]);
    assert.match(await withAgentMemory('SYS', gen, A), new RegExp(`NULL-SITE-${TAG}`));
    assert.match(await withAgentMemory('SYS', gen, B), new RegExp(`NULL-SITE-${TAG}`));
  });

  test('competitor context: A\'s rivals are not named in B\'s prompt', async () => {
    const A = await newSite('A3'); const B = await newSite('B3');
    await query(`INSERT INTO competitor_profiles (site_id, domain) VALUES ($1,$2)`, [A, `rival-a.${TAG}.example`]);
    await query(`INSERT INTO competitor_profiles (site_id, domain) VALUES ($1,$2)`, [B, `rival-b.${TAG}.example`]);
    _clearCompetitorPolicyCache();
    const forA = await withCompetitorContext('SYS', 'blog-outline', A);
    const forB = await withCompetitorContext('SYS', 'blog-outline', B);
    assert.match(forA, new RegExp(`rival-a\\.${TAG}`)); assert.match(forB, new RegExp(`rival-b\\.${TAG}`));
    assert.ok(!forA.includes(`rival-b.${TAG}`)); assert.ok(!forB.includes(`rival-a.${TAG}`));
  });

  test('design context, through the real site reader: A\'s design notes are not in B\'s prompt', async () => {
    const profile = (note) => ({
      version: DESIGN_PROFILE_VERSION, styling: 'tailwind',
      typography: { body: 'text-base', heading: { item: 'text-2xl font-bold' } }, layout: { container: 'max-w-7xl mx-auto' },
      pageTypePatterns: { homepage: { sectionOrder: ['header', 'hero', 'footer'], notes: note } }, evidence: { notes: note },
    });
    const A = await newSite('A4', { siteRoot: { designProfile: profile(`VOICE-A-${TAG}`) } });
    const B = await newSite('B4', { siteRoot: { designProfile: profile(`VOICE-B-${TAG}`) } });
    const forA = await withDesignContext('SYS', 'faq', A);
    const forB = await withDesignContext('SYS', 'faq', B);
    assert.match(forA, new RegExp(`VOICE-A-${TAG}`), 'positive control: the real reader returned A\'s profile');
    assert.match(forB, new RegExp(`VOICE-B-${TAG}`));
    assert.ok(!forA.includes(`VOICE-B-${TAG}`)); assert.ok(!forB.includes(`VOICE-A-${TAG}`));
  });

  test('no project id means no project data', async () => {
    const gen = `gen3-${TAG}`;
    assert.equal(await withDesignContext('SYS', 'faq', null), 'SYS');
    assert.equal(await withCompetitorContext('SYS', 'blog-outline', null), 'SYS');
    assert.equal(await withAgentMemory('SYS', null, 1), 'SYS');
    assert.ok(typeof (await withAgentMemory('SYS', gen, null)) === 'string');
  });
});
