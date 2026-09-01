import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  frontMatterKeys, extractTitle, hasImageField, insertFrontMatterFields, IMAGE_FIELD_ALIASES,
  extractImageUrl, listPostPaths,
} from './blog-frontmatter.js';

const POST = `---
title: "A real blog post title"
description: "Some description"
---

Body text here.`;

describe('frontMatterKeys', () => {
  test('lists top-level front-matter keys only, not nested ones', () => {
    const raw = '---\ntitle: "T"\nseo:\n  description: "nested, not top-level"\n---\nbody';
    const keys = frontMatterKeys(raw);
    assert.ok(keys.has('title'));
    assert.ok(!keys.has('description'), 'a nested key under seo: must not be read as top-level');
  });

  test('empty set for content with no front matter at all', () => {
    assert.deepEqual([...frontMatterKeys('just a body, no --- block')], []);
  });
});

describe('extractTitle', () => {
  test('reads a quoted title', () => {
    assert.equal(extractTitle(POST), 'A real blog post title');
  });

  test('reads an unquoted title', () => {
    assert.equal(extractTitle('---\ntitle: Unquoted Title\n---\nbody'), 'Unquoted Title');
  });

  test('null when there is no title field', () => {
    assert.equal(extractTitle('---\ndescription: "x"\n---\nbody'), null);
  });

  test('null with no front matter at all', () => {
    assert.equal(extractTitle('no front matter here'), null);
  });
});

describe('hasImageField', () => {
  for (const alias of IMAGE_FIELD_ALIASES) {
    test(`recognizes "${alias}" as an existing image field`, () => {
      assert.equal(hasImageField(`---\ntitle: "T"\n${alias}: "/x.jpg"\n---\nbody`), true);
    });
  }

  test('false when none of the aliases are present', () => {
    assert.equal(hasImageField(POST), false);
  });
});

describe('insertFrontMatterFields', () => {
  test('inserts fields inside the front-matter block, never touching the body', () => {
    const updated = insertFrontMatterFields(POST, [
      ['featuredImage', 'https://example.com/a.jpg'],
      ['featuredImageAlt', 'A real photo'],
    ]);
    assert.match(updated, /featuredImage: "https:\/\/example\.com\/a\.jpg"/);
    assert.match(updated, /featuredImageAlt: "A real photo"/);
    const bodyOnly = (raw) => raw.slice(raw.lastIndexOf('---') + 3);
    assert.equal(bodyOnly(updated), bodyOnly(POST), 'body text must survive byte-identical');
  });

  test('null/empty-string fields are dropped, never written as empty strings', () => {
    const updated = insertFrontMatterFields(POST, [
      ['featuredImage', 'https://example.com/a.jpg'],
      ['featuredImageCredit', null],
      ['featuredImageAlt', ''],
    ]);
    assert.match(updated, /featuredImage:/);
    assert.ok(!updated.includes('featuredImageCredit'));
    assert.ok(!updated.includes('featuredImageAlt'));
  });

  test('escapes a double quote in a value', () => {
    const updated = insertFrontMatterFields(POST, [['featuredImageAlt', 'A "special" photo']]);
    assert.match(updated, /featuredImageAlt: "A \\"special\\" photo"/);
  });

  test('no fields to insert returns the original content unchanged', () => {
    assert.equal(insertFrontMatterFields(POST, [['featuredImage', null]]), POST);
  });
});
