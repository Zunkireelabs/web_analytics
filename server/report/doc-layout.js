import { rgbColor } from './brand.js';

// The branded weekly/monthly Google Doc section (design: mockups/reports/doc.html, SRANK-34): a colour band with the
// client's name, a headline, tiles, bars, real Docs tables, footer. Weekly and monthly build a `model` and hand it
// here, so the two can never drift apart.
//
// Google Docs only tells you where a table's cells are AFTER the table exists, and every insert shifts every later
// index. So a section is written in two passes instead of by guessing offsets:
//   1. structure: insert every paragraph and empty table at the top, last block first (so the final order is the
//      model's order), in one batchUpdate;
//   2. fill: read the document back, find each block's real position, then style/fill from the LAST block to the
//      FIRST, so a later insert never moves an index an earlier request still needs.
// The same section also starts with a plain marker paragraph (the period label) and ends with a rule line, which is
// what monthly-doc.js's staleTopSection uses to replace a re-run period instead of stacking a duplicate.

const GREEN = '#1a7f4b';
const RED = '#b42318';
const GREY = '#5f6368';
const FAINT = '#80868b';
const RULE = '#c9ccd1';
const HAIR = '#e0e3e7';
const INK = '#202124';
const WHITE = '#ffffff';
const TOTAL_FILL = '#f6f6f6';
const FONT = 'Arial';
const WIDTH = 440; // pt of table width; fits both Letter and A4 text areas
const TONE = { good: GREEN, bad: RED, flat: GREY };
export const RULE_LINE = '─'.repeat(38);

const PT = (n) => ({ magnitude: n, unit: 'PT' });
const runsOf = (p) => (p.runs || [{ text: p.text }]);
const plainOf = (p) => runsOf(p).map((r) => r.text).join('');
const para = (text, o = {}) => ({ type: 'para', runs: o.runs, text, plain: o.runs ? o.runs.map((r) => r.text).join('') : text, ...o });
const cellText = (c) => (typeof c === 'string' ? c : c.t);

// ---- model -> flat block list -------------------------------------------------------------------------------

// model: { marker, band:{kind, period, sub}, headline, summary, tiles:[{label,value,delta,tone}],
//          barsTitle, bars:[{label,value}], sections:[{title, sub?, table:{head,rows,totalRow?} | bullets:[{text,mark}]}],
//          footer }
export function buildBlocks(model, brand) {
  const blocks = [];
  blocks.push(para(model.marker, { size: 8, color: FAINT, pageBreakBefore: true, spaceBelow: 4 }));

  blocks.push({
    type: 'table', rows: 1, cols: 2, widths: [WIDTH * 0.62, WIDTH * 0.38], borders: 'none',
    cells: [[
      { fill: brand.color, pad: 12, lines: [{ text: brand.name, size: 15, bold: true, color: brand.onColor }, { text: model.band.sub, size: 9, color: brand.onColor }] },
      { fill: brand.color, pad: 12, align: 'END', lines: [{ text: model.band.kind, size: 9, color: brand.onColor }, { text: model.band.period, size: 11, bold: true, color: brand.onColor }] },
    ]],
  });

  blocks.push(para(model.headline, { size: 20, bold: true, color: INK, spaceAbove: 14, spaceBelow: 2 }));
  if (model.summary) blocks.push(para(model.summary, { size: 10.5, color: '#3c4043', spaceBelow: 8 }));

  if (model.tiles?.length) {
    const w = WIDTH / model.tiles.length;
    blocks.push({
      type: 'table', rows: 1, cols: model.tiles.length, widths: model.tiles.map(() => w), borders: 'gap',
      cells: [model.tiles.map((t) => ({
        fill: brand.tint, pad: 9,
        lines: [{ text: t.label, size: 8.5, color: GREY }, { text: t.value, size: 20, bold: true, color: brand.text }, { text: t.delta || ' ', size: 8.5, bold: true, color: TONE[t.tone] || GREY }],
      }))],
    });
  }

  if (model.bars?.length) {
    blocks.push(para(model.barsTitle, { size: 12, bold: true, color: INK, spaceAbove: 14, spaceBelow: 4 }));
    const max = Math.max(...model.bars.map((b) => b.value), 1);
    const top = model.bars.reduce((best, b, i) => (b.value > model.bars[best].value ? i : best), 0);
    blocks.push({
      type: 'table', rows: model.bars.length, cols: 3, widths: [WIDTH * 0.2, WIDTH * 0.62, WIDTH * 0.18], borders: 'none',
      cells: model.bars.map((b, i) => [
        { pad: 2, lines: [{ text: b.label, size: 9, color: GREY }] },
        { pad: 2, lines: [{ text: '█'.repeat(Math.max(1, Math.round((b.value / max) * 30))), size: 10, color: i === top ? brand.bar : brand.barSoft }] },
        { pad: 2, align: 'END', lines: [{ text: b.valueText ?? String(b.value), size: 9, bold: i === top, color: INK }] },
      ]),
    });
  }

  for (const s of model.sections || []) {
    blocks.push(para(s.title, { size: 12, bold: true, color: INK, spaceAbove: 16, spaceBelow: s.sub ? 0 : 4 }));
    if (s.sub) blocks.push(para(s.sub, { size: 8.5, color: FAINT, spaceBelow: 4 }));
    if (s.bullets) {
      for (const b of s.bullets) {
        const mark = { tick: ['✓', GREEN], wait: ['!', '#c2410c'], dot: ['•', GREY] }[b.mark || 'dot'];
        const runs = [{ text: `${mark[0]}  `, color: mark[1], bold: true }, { text: b.text, color: INK }];
        if (b.note) runs.push({ text: ` · ${b.note}`, color: FAINT });
        blocks.push(para(null, { runs, size: 10.5, spaceBelow: 2 }));
      }
    }
    if (s.table) {
      const { head, rows, totalRow } = s.table;
      const widths = head.map((_, i) => (i === 0 ? WIDTH * 0.3 : (WIDTH * 0.7) / (head.length - 1)));
      blocks.push({
        type: 'table', rows: rows.length + 1, cols: head.length, widths, borders: 'rows',
        cells: [
          head.map((h, i) => ({ fill: brand.color, pad: 5, align: i ? 'END' : 'START', lines: [{ text: h, size: 8.5, bold: true, color: brand.onColor }] })),
          ...rows.map((r, ri) => r.map((c, i) => {
            const total = totalRow && ri === rows.length - 1;
            return { fill: total ? TOTAL_FILL : null, pad: 5, align: i ? 'END' : 'START', lines: [{ text: cellText(c), size: 9.5, bold: total || (typeof c !== 'string' && !!c.tone), color: typeof c !== 'string' && c.tone ? TONE[c.tone] : INK }] };
          })),
        ],
      });
    }
  }

  blocks.push(para(model.footer, { size: 8, color: FAINT, spaceAbove: 14 }));
  blocks.push(para(RULE_LINE, { size: 8, color: RULE, spaceAbove: 4, spaceBelow: 4 }));
  return blocks;
}

// ---- pass 1: structure --------------------------------------------------------------------------------------

export function structureRequests(blocks) {
  return [...blocks].reverse().map((b) => (b.type === 'table'
    ? { insertTable: { rows: b.rows, columns: b.cols, location: { index: 1 } } }
    : { insertText: { location: { index: 1 }, text: `${b.plain}\n` } }));
}

// ---- locate: where did Docs actually put each block ---------------------------------------------------------

const paraText = (el) => (el.paragraph.elements || []).map((e) => e.textRun?.content || '').join('').replace(/\n$/, '');

// Docs adds a stray empty paragraph around tables, so walk forward matching by kind/text rather than by position.
export function locateBlocks(content, blocks) {
  const els = content || [];
  let i = 0;
  return blocks.map((b, n) => {
    while (i < els.length) {
      const el = els[i];
      i += 1;
      if (b.type === 'table' && el.table) {
        return { start: el.startIndex, end: el.endIndex, cells: el.table.tableRows.map((r) => r.tableCells.map((c) => c.content[0].startIndex)) };
      }
      if (b.type === 'para' && el.paragraph && paraText(el) === b.plain) return { start: el.startIndex, end: el.endIndex };
    }
    throw new Error(`doc-layout: block ${n} (${b.type}) was not found in the written document`);
  });
}

// ---- pass 2: fill and style (last block first, so earlier indices stay valid) ------------------------------

const textStyle = (o) => {
  const style = { bold: !!o.bold, italic: false, fontSize: PT(o.size), weightedFontFamily: { fontFamily: FONT }, foregroundColor: rgbColor(o.color || INK) };
  return { textStyle: style, fields: 'bold,italic,fontSize,weightedFontFamily,foregroundColor' };
};
const styleText = (start, end, o) => ({ updateTextStyle: { range: { startIndex: start, endIndex: end }, ...textStyle(o) } });
// pageBreakBefore is only sent when it is true: Google rejects the field for any paragraph inside a table, and the
// tiles, band and tables are all table paragraphs.
const styleParagraph = (start, end, o) => ({
  updateParagraphStyle: {
    range: { startIndex: start, endIndex: end },
    paragraphStyle: { alignment: o.align || 'START', spaceAbove: PT(o.spaceAbove || 0), spaceBelow: PT(o.spaceBelow || 0), ...(o.pageBreakBefore ? { pageBreakBefore: true } : {}) },
    fields: `alignment,spaceAbove,spaceBelow${o.pageBreakBefore ? ',pageBreakBefore' : ''}`,
  },
});

function border(kind, brand) {
  const none = { color: rgbColor(WHITE), width: PT(0), dashStyle: 'SOLID' };
  const line = (hex, w) => ({ color: rgbColor(hex), width: PT(w), dashStyle: 'SOLID' });
  if (kind === 'gap') return { Top: line(WHITE, 4), Bottom: line(WHITE, 4), Left: line(WHITE, 4), Right: line(WHITE, 4) };
  if (kind === 'rows') return { Top: none, Left: none, Right: none, Bottom: line(HAIR, 0.75) };
  return { Top: none, Bottom: none, Left: none, Right: none };
}

function tableRequests(block, at, brand) {
  const out = [];
  const tableStart = at.start;
  const loc = (r, c) => ({ tableCellLocation: { tableStartLocation: { index: tableStart }, rowIndex: r, columnIndex: c }, rowSpan: 1, columnSpan: 1 });
  const bd = border(block.borders, brand);

  block.widths.forEach((w, c) => out.push({
    updateTableColumnProperties: { tableStartLocation: { index: tableStart }, columnIndices: [c], tableColumnProperties: { widthType: 'FIXED_WIDTH', width: PT(w) }, fields: 'widthType,width' },
  }));
  block.cells.forEach((row, r) => row.forEach((cell, c) => {
    const style = {
      borderTop: bd.Top, borderBottom: bd.Bottom, borderLeft: bd.Left, borderRight: bd.Right,
      paddingTop: PT(cell.pad ?? 4), paddingBottom: PT(cell.pad ?? 4), paddingLeft: PT((cell.pad ?? 4) + 2), paddingRight: PT((cell.pad ?? 4) + 2),
      backgroundColor: cell.fill ? rgbColor(cell.fill) : rgbColor(WHITE),
    };
    out.push({ updateTableCellStyle: { tableRange: loc(r, c), tableCellStyle: style, fields: 'borderTop,borderBottom,borderLeft,borderRight,paddingTop,paddingBottom,paddingLeft,paddingRight,backgroundColor' } });
  }));

  // Cell text: last cell first, so inserting into one never shifts the start of a cell still to come.
  for (let r = block.cells.length - 1; r >= 0; r -= 1) {
    for (let c = block.cells[r].length - 1; c >= 0; c -= 1) {
      const cell = block.cells[r][c];
      const p = at.cells[r][c];
      const text = cell.lines.map((l) => l.text).join('\n');
      out.push({ insertText: { location: { index: p }, text } });
      out.push(styleParagraph(p, p + text.length + 1, { align: cell.align }));
      let off = p;
      for (const l of cell.lines) {
        out.push(styleText(off, off + l.text.length, l));
        off += l.text.length + 1;
      }
    }
  }
  return out;
}

export function fillRequests(blocks, located, brand) {
  const out = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    const at = located[i];
    if (b.type === 'table') { out.push(...tableRequests(b, at, brand)); continue; }
    out.push(styleParagraph(at.start, at.end, b));
    out.push(styleText(at.start, at.end - 1, b));
    let off = at.start;
    for (const run of runsOf(b)) {
      if (b.runs) out.push(styleText(off, off + run.text.length, { ...b, ...run }));
      off += run.text.length;
    }
  }
  return out;
}

// ---- the whole write ----------------------------------------------------------------------------------------

// `stale` ({start,end}) is a previous run of the same period to replace. If the second pass fails, the half-built
// section is removed again so the doc is never left with empty tables at the top.
export async function writeSection(docs, docId, model, brand, { stale } = {}) {
  const blocks = buildBlocks(model, brand);
  const first = [];
  if (stale) first.push({ deleteContentRange: { range: { startIndex: stale.start, endIndex: stale.end } } });
  first.push(...structureRequests(blocks));
  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: first } });

  const { data } = await docs.documents.get({ documentId: docId, fields: 'body.content' });
  const located = locateBlocks(data.body.content, blocks);
  try {
    await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: fillRequests(blocks, located, brand) } });
  } catch (err) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: [{ deleteContentRange: { range: { startIndex: located[0].start, endIndex: located.at(-1).end } } }] },
    }).catch(() => {});
    throw err;
  }
  return { blocks: blocks.length };
}

