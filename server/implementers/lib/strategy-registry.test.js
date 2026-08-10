import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../../db.js';
import { getOrDetectStrategy } from './strategy-registry.js';

// Uses the real DB (this repo has no mocked-DB test convention — see
// marker-merge.test.js's sibling files for the pure-function-only norm;
// this module's whole job is the DB round trip, so it's tested against a
// real, isolated site row rather than mocked). All rows this test creates
// are scoped to one throwaway site and cleaned up in `after`.

let site;

before(async () => {
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, repo_owner, repo_name)
     VALUES ('strategy-registry-test-site', 'sc-domain:strategy-registry-test.example', 'test-ga4', 'test-owner', 'test-repo')
     RETURNING *`
  );
  site = rows[0];
});

after(async () => {
  await query('DELETE FROM sites WHERE id = $1', [site.id]);
  await pool.end();
});

describe('own-file cache', () => {
  test('first call detects fresh and persists a row; second call on the same unchanged file hits the cache', async () => {
    const file = '<html><body><main><p>' + 'a'.repeat(60) + '</p></main></body></html>';
    const first = await getOrDetectStrategy(site, 'src/pages/about.html', file);
    assert.equal(first.ok, true);
    assert.equal(first.source, 'fresh');

    const second = await getOrDetectStrategy(site, 'src/pages/about.html', file);
    assert.equal(second.ok, true);
    assert.equal(second.source, 'file-cache');
    assert.equal(second.containerDescription, first.containerDescription);
  });

  test('a structurally-changed file invalidates the cached row and re-learns', async () => {
    const before1 = '<html><body><main><p>' + 'b'.repeat(60) + '</p></main></body></html>';
    await getOrDetectStrategy(site, 'src/pages/drift.html', before1);

    const after1 = '<html><body><article><p>' + 'c'.repeat(60) + '</p></article></body></html>';
    const result = await getOrDetectStrategy(site, 'src/pages/drift.html', after1);
    assert.equal(result.ok, true);
    assert.equal(result.source, 'fresh');
    assert.equal(result.containerDescription, 'article');
  });
});

describe('template-identity reuse across separate files', () => {
  const layoutImport = (body) =>
    "import Layout from '../layouts/BlogPost';\n" +
    `export default function Page() { return <Layout><main><p>${body}</p></main></Layout>; }\n`;

  test('a second, brand-new/thin page sharing the same Layout import inherits the first page\'s proven container', async () => {
    const richPage = layoutImport('x'.repeat(80));
    const first = await getOrDetectStrategy(site, 'src/pages/blog/post-rich.tsx', richPage);
    assert.equal(first.ok, true);
    assert.equal(first.containerDescription, '<main>');

    // A brand-new page with almost no content of its own — would still pass
    // for JSX today (JSX detection has no length threshold), but this
    // proves the template-identity path is actually consulted and used,
    // not silently skipped, by checking `source`.
    const thinPage = layoutImport('hi');
    const second = await getOrDetectStrategy(site, 'src/pages/blog/post-thin.tsx', thinPage);
    assert.equal(second.ok, true);
    assert.equal(second.source, 'template-identity');
    assert.equal(second.containerDescription, '<main>');
  });

  test('falls back to independent detection when the trusted container genuinely is not present', async () => {
    const richPage = layoutImport('y'.repeat(80));
    await getOrDetectStrategy(site, 'src/pages/blog/post-rich-2.tsx', richPage);

    const divergedPage =
      "import Layout from '../layouts/BlogPost';\n" +
      "export default function Page() { return <Layout><div><p>hello world</p></div></Layout>; }\n";
    const result = await getOrDetectStrategy(site, 'src/pages/blog/post-diverged.tsx', divergedPage);
    assert.equal(result.ok, true);
    assert.equal(result.source, 'fresh');
    assert.match(result.containerDescription, /component's own returned root element/);
  });
});
