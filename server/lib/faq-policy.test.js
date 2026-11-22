import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faqSchemaRequiresVisible } from './faq-policy.js';

test('FAQ schema is required to match the visible FAQ by default', () => {
  const saved = process.env.FAQ_SCHEMA_REQUIRES_VISIBLE;
  delete process.env.FAQ_SCHEMA_REQUIRES_VISIBLE;
  try {
    assert.equal(faqSchemaRequiresVisible(), true);
    process.env.FAQ_SCHEMA_REQUIRES_VISIBLE = 'true';
    assert.equal(faqSchemaRequiresVisible(), true);
  } finally {
    if (saved === undefined) delete process.env.FAQ_SCHEMA_REQUIRES_VISIBLE; else process.env.FAQ_SCHEMA_REQUIRES_VISIBLE = saved;
  }
});

test('FAQ_SCHEMA_REQUIRES_VISIBLE=false restores the earlier schema-only policy', () => {
  const saved = process.env.FAQ_SCHEMA_REQUIRES_VISIBLE;
  process.env.FAQ_SCHEMA_REQUIRES_VISIBLE = 'false';
  try { assert.equal(faqSchemaRequiresVisible(), false); }
  finally { if (saved === undefined) delete process.env.FAQ_SCHEMA_REQUIRES_VISIBLE; else process.env.FAQ_SCHEMA_REQUIRES_VISIBLE = saved; }
});
