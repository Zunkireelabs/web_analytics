import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let issued;
let upsertReturnRow;
let signalsRows;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith('INSERT INTO technical_seo_checks')) {
    return { rows: [upsertReturnRow] };
  }
  if (sql.startsWith('SELECT page, checked_at, technical_audit->>')) {
    return { rows: signalsRows };
  }
  throw new Error(`technical-seo-checks.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const { upsertTechnicalSeoCheck, getTechnicalSeoSignalsForPages } = await import('./technical-seo-checks.js');

beforeEach(() => {
  issued = [];
  upsertReturnRow = { id: 1, site_id: 7, page: 'https://x.com/p', word_count: 400 };
  signalsRows = [];
});

// Migration 120: word_count/meta_description/internal_link_count are new,
// nullable columns fed from analyzePage() output that was previously
// discarded after every technical-seo run (see that migration's comment).
describe('upsertTechnicalSeoCheck — content signal columns (migration 120)', () => {
  test('passes wordCount/metaDescription/internalLinkCount through as positional params', async () => {
    await upsertTechnicalSeoCheck(7, 'https://x.com/p', {
      indexStatus: null, coreWebVitals: null, technicalAudit: null, brokenLinks: null, lastImpressions: 12,
      wordCount: 400, metaDescription: 'A real description.', internalLinkCount: 6,
    });
    const insert = issued.find((i) => i.sql.startsWith('INSERT INTO technical_seo_checks'));
    assert.ok(insert);
    assert.deepEqual(insert.params.slice(6), [12, 400, 'A real description.', 6]);
  });

  test('never fabricates 0/empty-string when a signal is unavailable — passes through null', async () => {
    await upsertTechnicalSeoCheck(7, 'https://x.com/p', {
      indexStatus: null, coreWebVitals: null, technicalAudit: null, brokenLinks: null, lastImpressions: null,
      wordCount: undefined, metaDescription: undefined, internalLinkCount: undefined,
    });
    const insert = issued.find((i) => i.sql.startsWith('INSERT INTO technical_seo_checks'));
    assert.deepEqual(insert.params.slice(6), [null, null, null, null]);
  });

  test('empty-string metaDescription is stored as null, not as an empty string', async () => {
    await upsertTechnicalSeoCheck(7, 'https://x.com/p', {
      indexStatus: null, coreWebVitals: null, technicalAudit: null, brokenLinks: null, lastImpressions: null,
      wordCount: 0, metaDescription: '', internalLinkCount: 0,
    });
    const insert = issued.find((i) => i.sql.startsWith('INSERT INTO technical_seo_checks'));
    // wordCount/internalLinkCount of a real 0 must still be stored as 0 (a
    // real observed zero), only metaDescription's falsy '' collapses to null.
    assert.deepEqual(insert.params.slice(6), [null, 0, null, 0]);
  });
});

describe('getTechnicalSeoSignalsForPages', () => {
  test('scopes to site_id and optionally filters by page list', async () => {
    signalsRows = [{ page: 'https://x.com/p', title: 'Hi', has_canonical: true, word_count: 400 }];
    const rows = await getTechnicalSeoSignalsForPages(7, { pages: ['https://x.com/p'] });
    assert.equal(rows.length, 1);
    const select = issued.find((i) => i.sql.startsWith('SELECT page, checked_at, technical_audit->>'));
    assert.equal(select.params[0], 7);
    assert.deepEqual(select.params[1], ['https://x.com/p']);
  });

  test('with no pages filter, still scopes to site_id alone', async () => {
    await getTechnicalSeoSignalsForPages(7, {});
    const select = issued.find((i) => i.sql.startsWith('SELECT page, checked_at, technical_audit->>'));
    assert.equal(select.params.length, 1);
    assert.equal(select.params[0], 7);
  });
});
