import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parsePaginationFrontMatter, discoverPaginationRoutes, recordIdsForRoute, compareFamilyBuilds,
  commitMessagesInRange, FAMILY_WRITE_MARKER, normalizeBuildAssetHashes,
} from './check-family-siblings.mjs';

// The real front matter from zunkireelabs-web's glossary-terms.njk — same
// fixture pagination-routes.test.js (in the main app) uses, since this
// script's parser is a deliberate duplicate of pagination-routes.js's own
// and must keep reading it identically.
const GLOSSARY_TEMPLATE = `---
pagination:
  data: glossary
  size: 1
  alias: term
  addAllPagesToCollections: true
layout: glossary-term.njk
permalink: /glossary/{{ term.id }}/
---
body`;

const GLOSSARY_DATA = `export default [
  { id: 'multi-tenant-saas', term: 'Multi-tenant SaaS', shortDef: 'x' },
  { id: 'zero-shot-learning', term: 'Zero-shot learning', shortDef: 'y' },
  { id: 'rag', term: 'RAG', shortDef: 'z' },
];`;

let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'family-siblings-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('parsePaginationFrontMatter — kept identical to pagination-routes.js', () => {
  test('reads the route and id field from real front matter', () => {
    const fm = parsePaginationFrontMatter(GLOSSARY_TEMPLATE);
    assert.equal(fm.data, 'glossary');
    assert.equal(fm.routePrefix, '/glossary');
    assert.equal(fm.idField, 'id');
  });

  test('a non-paginating template is not a route', () => {
    assert.equal(parsePaginationFrontMatter('---\nlayout: base.njk\n---\nbody'), null);
  });
});

describe('discoverPaginationRoutes', () => {
  test('finds a real generated-record family from the repo tree', () => {
    mkdirSync(join(dir, 'src/glossary'), { recursive: true });
    mkdirSync(join(dir, 'src/_data'), { recursive: true });
    writeFileSync(join(dir, 'src/glossary/glossary-terms.njk'), GLOSSARY_TEMPLATE);
    writeFileSync(join(dir, 'src/_data/glossary.js'), GLOSSARY_DATA);

    const routes = discoverPaginationRoutes(dir);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].routePrefix, '/glossary');
    assert.equal(routes[0].dataFile, 'src/_data/glossary.js');
  });

  test('an ambiguous data file (matches both .js and .json) is skipped rather than guessed', () => {
    mkdirSync(join(dir, 'src/glossary'), { recursive: true });
    mkdirSync(join(dir, 'src/_data'), { recursive: true });
    writeFileSync(join(dir, 'src/glossary/glossary-terms.njk'), GLOSSARY_TEMPLATE);
    writeFileSync(join(dir, 'src/_data/glossary.js'), GLOSSARY_DATA);
    writeFileSync(join(dir, 'src/_data/glossary.json'), '[]');

    assert.deepEqual(discoverPaginationRoutes(dir), []);
  });

  test('ignores node_modules and _includes entirely', () => {
    mkdirSync(join(dir, 'node_modules/somepkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/somepkg/fake.njk'), GLOSSARY_TEMPLATE);
    mkdirSync(join(dir, 'src/_includes'), { recursive: true });
    writeFileSync(join(dir, 'src/_includes/base.njk'), GLOSSARY_TEMPLATE);
    assert.deepEqual(discoverPaginationRoutes(dir), []);
  });
});

describe('recordIdsForRoute', () => {
  test('extracts every record id from a real _data/*.js file', () => {
    mkdirSync(join(dir, 'src/_data'), { recursive: true });
    writeFileSync(join(dir, 'src/_data/glossary.js'), GLOSSARY_DATA);
    const ids = recordIdsForRoute(dir, { dataFile: 'src/_data/glossary.js', idField: 'id' });
    assert.deepEqual(ids.sort(), ['multi-tenant-saas', 'rag', 'zero-shot-learning']);
  });

  test('a .json data file is parsed directly, no sandbox needed', () => {
    mkdirSync(join(dir, 'src/_data'), { recursive: true });
    writeFileSync(join(dir, 'src/_data/comparisons.json'), JSON.stringify([{ id: 'a-vs-b' }, { id: 'c-vs-d' }]));
    const ids = recordIdsForRoute(dir, { dataFile: 'src/_data/comparisons.json', idField: 'id' });
    assert.deepEqual(ids.sort(), ['a-vs-b', 'c-vs-d']);
  });

  test('a data file that tries to require() or touch the filesystem fails closed to an empty list', () => {
    mkdirSync(join(dir, 'src/_data'), { recursive: true });
    writeFileSync(join(dir, 'src/_data/evil.js'), "const fs = require('fs'); export default fs.readdirSync('/');");
    assert.deepEqual(recordIdsForRoute(dir, { dataFile: 'src/_data/evil.js', idField: 'id' }), []);
  });

  test('a missing data file is an empty list, not a crash', () => {
    assert.deepEqual(recordIdsForRoute(dir, { dataFile: 'src/_data/nope.js', idField: 'id' }), []);
  });
});

describe('normalizeBuildAssetHashes', () => {
  test('strips a Vite-style content hash from script/link tags', () => {
    const html = '<script type="module" crossorigin src="/assets/main-CUFX_6OC.js"></script>\n'
      + '<link rel="stylesheet" crossorigin href="/assets/main-CTap5ap_.css">';
    const normalized = normalizeBuildAssetHashes(html);
    assert.match(normalized, /src="\/assets\/main-HASH\.js"/);
    assert.match(normalized, /href="\/assets\/main-HASH\.css"/);
  });

  test('two builds with only a different bundle hash normalize to the same string', () => {
    const a = '<link rel="stylesheet" href="/assets/main-CTap5ap_.css">';
    const b = '<link rel="stylesheet" href="/assets/main-DuUiLYSD.css">';
    assert.equal(normalizeBuildAssetHashes(a), normalizeBuildAssetHashes(b));
  });

  test('passes null through untouched', () => {
    assert.equal(normalizeBuildAssetHashes(null), null);
  });
});

describe('compareFamilyBuilds — the actual sibling-non-leakage gate', () => {
  function writeRendered(outputDir, routePrefix, id, html) {
    const full = join(outputDir, ...routePrefix.split('/').filter(Boolean), id, 'index.html');
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, html);
  }

  test('THE §13 SCENARIO: one record changed, siblings byte-identical -> exactly one changed URL, no leakage', () => {
    mkdirSync(join(dir, 'src/_data'), { recursive: true });
    writeFileSync(join(dir, 'src/_data/glossary.js'), GLOSSARY_DATA);
    const route = { routePrefix: '/glossary', dataFile: 'src/_data/glossary.js', idField: 'id' };

    const base = join(dir, 'base'), head = join(dir, 'head');
    for (const id of ['multi-tenant-saas', 'zero-shot-learning', 'rag']) {
      writeRendered(base, '/glossary', id, `<html>${id}: old</html>`);
    }
    writeRendered(head, '/glossary', 'multi-tenant-saas', '<html>multi-tenant-saas: NEW CONTENT</html>');
    writeRendered(head, '/glossary', 'zero-shot-learning', '<html>zero-shot-learning: old</html>');
    writeRendered(head, '/glossary', 'rag', '<html>rag: old</html>');

    const result = compareFamilyBuilds(dir, route, base, head);
    assert.equal(result.totalUrls, 3);
    assert.deepEqual(result.changedUrls, ['/glossary/multi-tenant-saas/']);
  });

  test('LEAKAGE: a shared-template edit changes every sibling — caught, not silently passed', () => {
    mkdirSync(join(dir, 'src/_data'), { recursive: true });
    writeFileSync(join(dir, 'src/_data/glossary.js'), GLOSSARY_DATA);
    const route = { routePrefix: '/glossary', dataFile: 'src/_data/glossary.js', idField: 'id' };

    const base = join(dir, 'base'), head = join(dir, 'head');
    for (const id of ['multi-tenant-saas', 'zero-shot-learning', 'rag']) {
      writeRendered(base, '/glossary', id, `<html>${id}: old header</html>`);
      // Every page picked up the "fix", exactly the hazard the brief describes.
      writeRendered(head, '/glossary', id, `<html>${id}: NEW SHARED HEADER</html>`);
    }

    const result = compareFamilyBuilds(dir, route, base, head);
    assert.equal(result.changedUrls.length, 3, 'all three siblings changed — this is the leakage the gate exists to catch');
  });

  test('a sitewide bundle-hash change alone (unrelated CSS/JS rebuild) is not leakage', () => {
    mkdirSync(join(dir, 'src/_data'), { recursive: true });
    writeFileSync(join(dir, 'src/_data/glossary.js'), GLOSSARY_DATA);
    const route = { routePrefix: '/glossary', dataFile: 'src/_data/glossary.js', idField: 'id' };

    const base = join(dir, 'base'), head = join(dir, 'head');
    for (const id of ['multi-tenant-saas', 'zero-shot-learning', 'rag']) {
      writeRendered(base, '/glossary', id, `<html>${id}<script src="/assets/main-CUFX_6OC.js"></script></html>`);
      // Tailwind's JIT scan of an unrelated page changed the shared bundle's
      // content hash — every page's <script src> differs, page content does not.
      writeRendered(head, '/glossary', id, `<html>${id}<script src="/assets/main-D1X5Ps2s.js"></script></html>`);
    }

    const result = compareFamilyBuilds(dir, route, base, head);
    assert.deepEqual(result.changedUrls, []);
  });

  test('a page present on one side and missing on the other counts as changed', () => {
    mkdirSync(join(dir, 'src/_data'), { recursive: true });
    writeFileSync(join(dir, 'src/_data/glossary.js'), GLOSSARY_DATA);
    const route = { routePrefix: '/glossary', dataFile: 'src/_data/glossary.js', idField: 'id' };
    const base = join(dir, 'base'), head = join(dir, 'head');
    // Two of the three siblings are present and IDENTICAL on both sides —
    // proves this isn't just "base build is empty, so everything differs".
    for (const id of ['rag', 'zero-shot-learning']) {
      writeRendered(base, '/glossary', id, `<html>${id}: stable</html>`);
      writeRendered(head, '/glossary', id, `<html>${id}: stable</html>`);
    }
    // The target page is genuinely new — present in head only.
    writeRendered(head, '/glossary', 'multi-tenant-saas', '<html>new page</html>');

    const result = compareFamilyBuilds(dir, route, base, head);
    assert.deepEqual(result.changedUrls, ['/glossary/multi-tenant-saas/']);
  });
});

describe('the CLI end-to-end, via a real git repo and real subprocess', () => {
  function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

  test('a family-write-marked commit range passes even with sitewide leakage', () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@test.com');
    git(dir, 'config', 'user.name', 'test');
    writeFileSync(join(dir, 'x.txt'), 'a');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base commit');
    const baseRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    writeFileSync(join(dir, 'x.txt'), 'b');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `sitewide byline rollout\n\n${FAMILY_WRITE_MARKER}`);
    const headRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    assert.match(commitMessagesInRange(dir, baseRef, headRef), new RegExp(FAMILY_WRITE_MARKER.replace(/[[\]]/g, '\\$&')));
  });

  test('an ordinary commit range carries no marker', () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@test.com');
    git(dir, 'config', 'user.name', 'test');
    writeFileSync(join(dir, 'x.txt'), 'a');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    const baseRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'x.txt'), 'b');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'fix one glossary term');
    const headRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    assert.doesNotMatch(commitMessagesInRange(dir, baseRef, headRef), /family-write/);
  });

  test('an unreadable git history fails open to an empty string, not a crash', () => {
    assert.equal(commitMessagesInRange(dir, 'nonexistent-ref', 'HEAD'), '');
  });
});
