import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDocumentText, MAX_UPLOAD_BYTES } from './document-text.js';

// A tiny valid one-page PDF with one line of text, built by hand so the test needs no fixture file.
function tinyPdf(line) {
  const content = Buffer.from(`BT /F1 18 Tf 72 720 Td (${line}) Tj ET`);
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  let out = Buffer.from('%PDF-1.4\n'); const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]); });
  const x = out.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const f of offs) xref += `${String(f).padStart(10, '0')} 00000 n \n`;
  return Buffer.concat([out, Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`)]);
}

test('plain text and markdown are read as they are', async () => {
  assert.equal(await extractDocumentText({ name: 'voice.md', buffer: Buffer.from('# Voice\r\n\r\n\r\n\r\nWarm.') }), '# Voice\n\nWarm.');
});
test('a PDF is read by its bytes, page markers removed, even if renamed', async () => {
  const t = await extractDocumentText({ name: 'renamed.docx', buffer: tinyPdf('Brand voice is friendly.') });
  assert.equal(t, 'Brand voice is friendly.');
});
test('anything else, an empty file, or an oversize file is refused with a plain reason', async () => {
  await assert.rejects(extractDocumentText({ name: 'tool.exe', buffer: Buffer.from('MZ....') }), /Word \(\.docx\), PDF and plain text/);
  await assert.rejects(extractDocumentText({ name: 'a.txt', buffer: Buffer.alloc(0) }), /empty/);
  await assert.rejects(extractDocumentText({ name: 'a.txt', buffer: Buffer.alloc(MAX_UPLOAD_BYTES + 1) }), /too large/);
  await assert.rejects(extractDocumentText({ name: 'old.doc', buffer: Buffer.from('PK\x03\x04....') }), /\.docx/);
});
