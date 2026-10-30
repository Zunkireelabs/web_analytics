import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrand } from './brand.js';
import { buildBlocks, structureRequests, locateBlocks, fillRequests, writeSection, RULE_LINE } from './doc-layout.js';

const brand = resolveBrand({ name: 'Admizz Education', url_file_map: { siteRoot: { designProfile: { color: { accent: '#0d1282' } } } } });
const model = {
  marker: 'Week of Oct 20 – Oct 26, 2026',
  band: { kind: 'Weekly report', period: 'Week of 20 to 26 Oct 2026', sub: 'Search and AI visibility' },
  headline: 'Clicks are up 9% on the prior week',
  summary: 'A short plain summary.',
  tiles: [
    { label: 'Impressions', value: '18.4k', delta: '▲ 12% vs prior week', tone: 'good' },
    { label: 'Clicks', value: '1,168', delta: '▼ 4% vs prior week', tone: 'bad' },
  ],
  barsTitle: 'Clicks by day',
  bars: [{ label: 'Mon', value: 142 }, { label: 'Tue', value: 201 }],
  sections: [
    { title: 'Day by day', table: { head: ['Day', 'Clicks'], rows: [['Mon 20', '142'], ['Week', { t: '343', tone: 'good' }]], totalRow: true } },
    { title: 'Next', bullets: [{ text: 'Repair canonical tags', mark: 'dot' }, { text: 'Pricing speed fix', mark: 'wait', note: 'waiting for your OK' }] },
  ],
  footer: 'Prepared for Admizz Education · search data final through 26 Oct',
};

test('blocks come out in the design order, starting with the marker and ending with the rule', () => {
  const blocks = buildBlocks(model, brand);
  assert.equal(blocks[0].plain, model.marker);
  assert.equal(blocks[0].pageBreakBefore, true);
  assert.equal(blocks.at(-1).plain, RULE_LINE);
  assert.equal(blocks.filter((b) => b.type === 'table').length, 4); // band, tiles, bars, one data table
  assert.equal(blocks[1].cells[0][0].fill, brand.color);
});

test('structure requests are last-block-first, all at index 1, so the final order is the model order', () => {
  const blocks = buildBlocks(model, brand);
  const reqs = structureRequests(blocks);
  assert.equal(reqs.length, blocks.length);
  for (const r of reqs) assert.equal((r.insertText || r.insertTable).location.index, 1);
  assert.equal(reqs[0].insertText.text, `${RULE_LINE}\n`);
});

// A synthetic document the way Docs returns it: a stray empty paragraph before each table.
function fakeContent(blocks) {
  let idx = 1; const out = [];
  const para = (text) => { const start = idx; idx += text.length + 1; out.push({ startIndex: start, endIndex: idx, paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }); };
  for (const b of blocks) {
    if (b.type === 'para') { para(b.plain); continue; }
    para('');
    const start = idx; idx += 1;
    const tableRows = [];
    for (let r = 0; r < b.rows; r += 1) { idx += 1; const tableCells = []; for (let c = 0; c < b.cols; c += 1) { idx += 1; tableCells.push({ content: [{ startIndex: idx }] }); idx += 1; } tableRows.push({ tableCells }); }
    out.push({ startIndex: start, endIndex: idx, table: { tableRows } });
  }
  return out;
}

test('locateBlocks finds every block through the stray empty paragraphs', () => {
  const blocks = buildBlocks(model, brand);
  const located = locateBlocks(fakeContent(blocks), blocks);
  assert.equal(located.length, blocks.length);
  assert.ok(located[1].cells && located[1].cells[0].length === 2);
  assert.throws(() => locateBlocks(fakeContent(blocks).slice(0, 4), blocks), /was not found/);
});

test('fill requests never shift an index a later request still needs (insert positions only go down)', () => {
  const blocks = buildBlocks(model, brand);
  const located = locateBlocks(fakeContent(blocks), blocks);
  const inserts = fillRequests(blocks, located, brand).filter((r) => r.insertText).map((r) => r.insertText.location.index);
  assert.ok(inserts.length > 10);
  for (let i = 1; i < inserts.length; i += 1) assert.ok(inserts[i] < inserts[i - 1], `insert ${i} (${inserts[i]}) should be below ${inserts[i - 1]}`);
});

test('the band, tiles and header row carry the brand colour; light brands get dark band text', () => {
  const blocks = buildBlocks(model, brand);
  const located = locateBlocks(fakeContent(blocks), blocks);
  const reqs = fillRequests(blocks, located, brand);
  const fills = reqs.filter((r) => r.updateTableCellStyle).map((r) => r.updateTableCellStyle.tableCellStyle.backgroundColor.color.rgbColor);
  assert.ok(fills.some((c) => Math.abs(c.blue - 0x82 / 255) < 0.01 && Math.abs(c.green - 0x12 / 255) < 0.01), 'brand navy fill present');
  const gold = buildBlocks(model, resolveBrand({ name: 'C', url_file_map: { siteRoot: { designProfile: { color: { accent: '#c8a96e' } } } } }));
  assert.equal(gold[1].cells[0][0].lines[0].color, '#171717');
});

test('writeSection: structure, read back, fill; replaces a stale period; cleans up if the fill fails', async () => {
  const blocks = buildBlocks(model, brand);
  const calls = [];
  const docs = { documents: {
    batchUpdate: async (a) => { calls.push(a.requestBody.requests); },
    get: async () => ({ data: { body: { content: fakeContent(blocks) } } }),
  } };
  await writeSection(docs, 'doc1', model, brand, { stale: { start: 1, end: 50 } });
  assert.equal(calls.length, 2);
  assert.ok(calls[0][0].deleteContentRange, 'stale section removed first');
  assert.ok(calls[1].some((r) => r.insertText) && calls[1].some((r) => r.updateTableCellStyle));

  let n = 0; const seen = [];
  const failing = { documents: {
    batchUpdate: async (a) => { n += 1; seen.push(a.requestBody.requests); if (n === 2) throw new Error('docs said no'); },
    get: async () => ({ data: { body: { content: fakeContent(blocks) } } }),
  } };
  await assert.rejects(() => writeSection(failing, 'doc1', model, brand), /docs said no/);
  assert.ok(seen.at(-1)[0].deleteContentRange, 'half-built section removed');
});
