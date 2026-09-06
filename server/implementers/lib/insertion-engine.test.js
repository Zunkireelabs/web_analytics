import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../../db.js';
import { resolveInsertion, buildUnresolvedInsertionFailure } from './insertion-engine.js';
import { hasMarker, spliceMarkers } from './marker-merge.js';

// Same real-DB convention as strategy-registry.test.js (this module's whole
// job is orchestrating that DB-backed registry) — one throwaway site,
// cleaned up in `after`.

let site;

before(async () => {
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, repo_owner, repo_name)
     VALUES ('insertion-engine-test-site', 'sc-domain:insertion-engine-test.example', 'test-ga4', 'test-owner', 'test-repo')
     RETURNING *`
  );
  site = rows[0];
});

after(async () => {
  await query('DELETE FROM sites WHERE id = $1', [site.id]);
  await pool.end();
});

describe('marker already present', () => {
  test('no-op — nothing to create, nothing unresolved', async () => {
    const file = '<html><body><main><!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END --></main></body></html>';
    const { content, unresolved } = await resolveInsertion(site, file, 'index.html', { faq: 'FAQ' });
    assert.equal(content, file);
    assert.deepEqual(unresolved, []);
  });
});

describe('auto-create + splice inline, no separate bootstrap PR', () => {
  test('creates a missing body marker via real structural detection and the caller can immediately splice real content into it — all in one file diff', async () => {
    const file = '<html><body><main><h1>Title</h1><p>' + 'x'.repeat(60) + '</p></main></body></html>';
    const { content, unresolved } = await resolveInsertion(site, file, 'src/pages/faq-target.html', { faq: 'FAQ' });
    assert.deepEqual(unresolved, []);
    assert.equal(hasMarker(content, 'FAQ'), true);
    // the marker landed inside <main>, not appended after </body></html>
    assert.ok(content.indexOf('SEOAI:FAQ') < content.indexOf('</main>'));

    const spliced = spliceMarkers(content, { faq: 'FAQ' }, { faq: '<dl><dt>Q</dt><dd>A</dd></dl>' });
    assert.equal(spliced.ok, true);
    assert.match(spliced.newContent, /<dl><dt>Q<\/dt><dd>A<\/dd><\/dl>/);
  });

  test('creates the marker inside a real <main> on a .tsx page (JSX comment convention), never at end-of-file', async () => {
    const file = 'export default function Page() {\n  return (\n    <main>\n      <h1>Hi</h1>\n    </main>\n  );\n}\n';
    const { content, unresolved } = await resolveInsertion(site, file, 'src/pages/about-tsx.tsx', { schema: 'SCHEMA' });
    assert.deepEqual(unresolved, []);
    assert.match(content, /\{\/\* SEOAI:SCHEMA:START \*\/\}\{\/\* SEOAI:SCHEMA:END \*\/\}/);
    assert.ok(!content.trimEnd().endsWith('*/}')); // not appended after the component's closing brace
  });

  test('auto-creates the SEOAI:HEAD region itself from a real <head>, then nests the field marker inside it', async () => {
    const file = '<html><head><title>Hi</title></head><body>hi</body></html>';
    const { content, unresolved } = await resolveInsertion(site, file, 'layout.html', { canonical: 'CANONICAL' });
    assert.deepEqual(unresolved, []);
    assert.match(content, /<!-- SEOAI:HEAD:START -->[\s\S]*<!-- SEOAI:CANONICAL:START --><!-- SEOAI:CANONICAL:END -->[\s\S]*<!-- SEOAI:HEAD:END -->/);
    assert.ok(content.indexOf('SEOAI:HEAD:END') < content.indexOf('</head>'));
  });
});

describe('genuinely unresolvable — honest failure, never a silent skip', () => {
  test('reports an unresolved body field when no confident container exists, and does not touch the file', async () => {
    const file = 'export default function getData() { return { props: {} }; }\n';
    const { content, unresolved } = await resolveInsertion(site, file, 'src/pages/getServerSideProps.tsx', { schema: 'SCHEMA' });
    assert.equal(content, file);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].field, 'schema');
    assert.equal(unresolved[0].markerName, 'SCHEMA');
  });

  test('reports an unresolved head-scoped field when no real <head> exists', async () => {
    const file = '<div>not even a real html document</div>';
    const { unresolved } = await resolveInsertion(site, file, 'fragment.html', { canonical: 'CANONICAL' });
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].reason, 'no-head-region');
  });

  test('a LINE-convention field with no front matter is reported honestly, via its own path, without going through structural detection', async () => {
    const file = 'export default function getData() { return { props: {} }; }\n';
    const { content, unresolved } = await resolveInsertion(site, file, 'src/pages/mixed-getServerSideProps.tsx', { title: 'TITLE' });
    assert.equal(content, file); // untouched — never routed through body-content structural detection
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].reason, 'no-front-matter');
  });

  test('one unresolved field never blocks another resolvable field on the same file', async () => {
    const file = '---\ntitle: "Old title"\n---\n<html><body><main><p>' + 'z'.repeat(60) + '</p></main></body></html>';
    const { content, unresolved } = await resolveInsertion(site, file, 'content/mixed-with-schema.njk', { title: 'TITLE', schema: 'SCHEMA' });
    // title resolves via the safe front-matter path; schema resolves via
    // real structural detection — neither one's success/failure affects
    // the other.
    assert.equal(unresolved.length, 0);
    assert.match(content, /# SEOAI:TITLE/);
    assert.match(content, /SEOAI:SCHEMA/);
  });
});

// buildUnresolvedInsertionFailure is the exact contract backend.js's
// computeMarkerMerge relies on to decide "does this draft ever reach a PR" —
// pulled out as its own pure function specifically so it has real unit
// coverage independent of the live GitHub network calls the rest of
// computeMarkerMerge needs. This repo has no convention for mocking GitHub
// (no supertest/nock/sinon in package.json, no server/routes/*.test.js —
// confirmed by inspection), so the surrounding fetch/push/PR flow in
// backend.js and routes/action-center.js's approve handler is NOT covered
// by an automated test at any layer, before or after this feature. That is
// a pre-existing, repo-wide gap (every other implementer — schema-repair,
// alt-text, security-headers, html-lang, ...) has the exact same untested
// surface, not something specific to this change. What IS new and IS
// covered here is the one piece of that pipeline that's pure: the decision
// of whether a draft's insertion result is real enough to reach a PR, and
// the exact per-field detail preserved when it isn't.
describe('buildUnresolvedInsertionFailure — the terminal-state contract backend.js relies on (no DB/network needed, pure)', () => {
  test('returns null (nothing to report) when splicing succeeded and nothing was left unresolved', () => {
    assert.equal(buildUnresolvedInsertionFailure('page.html', { ok: true }, []), null);
  });

  test('reports a failure when resolveInsertion left fields unresolved, even if spliceMarkers itself was never reached as "ok"', () => {
    const unresolved = [{ field: 'schema', markerName: 'SCHEMA', reason: 'no-confident-container', error: 'No container found.' }];
    const failure = buildUnresolvedInsertionFailure('src/pages/about.tsx', { ok: false, missingMarkers: ['SCHEMA'] }, unresolved);
    assert.equal(failure.ok, false);
    assert.equal(failure.reason, 'no-confident-insertion-point');
    assert.match(failure.error, /SEOAI:SCHEMA/);
    assert.match(failure.error, /no-confident-container/);
    // The real per-field detail survives verbatim, not just folded into the
    // message string — this is what a future UI (or any other caller) would
    // read to show accurate per-field status even before it's wired up.
    assert.deepEqual(failure.unresolved, unresolved);
  });

  test('never silently drops an unresolved field even when spliceMarkers reports ok:true for everything it touched', () => {
    // Realistic shape: spliceMarkers only ever visits markerMap's own keys,
    // so a field the marker-existence pass never got to at all wouldn't
    // appear in spliced.missingMarkers — only in resolveInsertion's own
    // `unresolved`. If this function only looked at `spliced.ok`, this case
    // would be silently treated as a full success despite one field never
    // actually being inserted.
    const unresolved = [{ field: 'qaContent', markerName: 'QACONTENT', reason: 'no-confident-container', error: 'No container found.' }];
    const failure = buildUnresolvedInsertionFailure('page.tsx', { ok: true }, unresolved);
    assert.notEqual(failure, null);
    assert.equal(failure.ok, false);
    assert.deepEqual(failure.unresolved, unresolved);
  });

  test('deduplicates a marker name that appears in both spliceMarkers.missingMarkers and resolveInsertion.unresolved', () => {
    const unresolved = [{ field: 'schema', markerName: 'SCHEMA', reason: 'no-confident-container', error: 'No container found.' }];
    const failure = buildUnresolvedInsertionFailure('page.html', { ok: false, missingMarkers: ['SCHEMA'] }, unresolved);
    const occurrences = failure.error.match(/SEOAI:SCHEMA/g) || [];
    assert.equal(occurrences.length, 1);
  });
});
