import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let issued;
let selectRows;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith('SELECT content_type')) return { rows: selectRows };
  if (sql.startsWith('INSERT INTO page_content_classification')) {
    const [siteId, page, contentType, confidence, classifiedBy] = params;
    return { rows: [{ content_type: contentType, confidence, classified_by: classifiedBy }] };
  }
  throw new Error(`page-content-classification.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const { getPageContentType, upsertPageContentType } = await import('./page-content-classification.js');

beforeEach(() => {
  issued = [];
  selectRows = [];
});

describe('getPageContentType — cross-tenant isolation', () => {
  test('CROSS-CLIENT ISOLATION: every read is scoped by site_id in the WHERE clause, not page alone', async () => {
    await getPageContentType(7, 'https://client.example/a');
    const select = issued.find((i) => i.sql.startsWith('SELECT content_type'));
    assert.match(select.sql, /WHERE site_id = \$1 AND page = \$2/);
    assert.deepEqual(select.params, [7, 'https://client.example/a']);
  });

  test('returns null rather than another site\'s row when there is no match for this site_id', async () => {
    selectRows = []; // the fake query already only returns what the (mocked) WHERE would have matched
    const result = await getPageContentType(7, 'https://client.example/a');
    assert.equal(result, null);
  });

  test('returns the cached row when one exists', async () => {
    selectRows = [{ content_type: 'blog', confidence: 0.9, classified_by: 'llm', classified_at: '2026-01-01T00:00:00Z' }];
    const result = await getPageContentType(7, 'https://client.example/a');
    assert.equal(result.content_type, 'blog');
  });
});

describe('upsertPageContentType', () => {
  test('writes site_id, page, content_type, confidence, and classified_by as positional params', async () => {
    await upsertPageContentType({ siteId: 7, page: 'https://client.example/a', contentType: 'product', confidence: 0.95, classifiedBy: 'path-heuristic' });
    const insert = issued.find((i) => i.sql.startsWith('INSERT INTO page_content_classification'));
    assert.deepEqual(insert.params, [7, 'https://client.example/a', 'product', 0.95, 'path-heuristic']);
  });

  test('upserts on (site_id, page) conflict rather than erroring on re-classification', async () => {
    await upsertPageContentType({ siteId: 7, page: 'https://client.example/a', contentType: 'product', confidence: 0.95, classifiedBy: 'path-heuristic' });
    const insert = issued.find((i) => i.sql.startsWith('INSERT INTO page_content_classification'));
    assert.match(insert.sql, /ON CONFLICT \(site_id, page\) DO UPDATE/);
  });
});
