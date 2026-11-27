// Plain text out of an uploaded brand document (.docx, .pdf, .txt, .md). The text is what the agents read; the file itself is not kept.
// Decided by the file's own bytes first (a .docx is a zip, a PDF starts with %PDF), the name second, so a renamed file is not misread.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const isZip = (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
const isPdf = (b) => b.length > 5 && b.slice(0, 5).toString('latin1') === '%PDF-';

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }

const tidy = (t) => String(t || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export async function extractDocumentText({ name = '', buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail('The file is empty.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw fail(`That file is too large (${Math.round(buffer.length / 1048576)} MB; the limit is ${MAX_UPLOAD_BYTES / 1048576} MB).`);
  const lower = String(name).toLowerCase();
  let text = '';
  if (isPdf(buffer)) {
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try { text = (await parser.getText())?.text || ''; } finally { await parser.destroy?.().catch?.(() => {}); }
    } catch { throw fail('That PDF could not be read. Try saving it again, or paste its text instead.'); }
    text = text.replace(/\n*-- \d+ of \d+ --\n*/g, '\n\n');
    if (!tidy(text)) throw fail('That PDF has no readable text (it may be a scan of pages). Paste the text instead, or use a text version of the file.');
  } else if (isZip(buffer)) {
    if (!lower.endsWith('.docx')) throw fail('Only Word (.docx), PDF and plain text files can be read. Save a .doc as .docx first.');
    try { text = (await (await import('mammoth')).default.extractRawText({ buffer })).value || ''; }
    catch { throw fail('That Word file could not be read. Save it again as .docx, or paste its text instead.'); }
    if (!tidy(text)) throw fail('That Word file has no text in it.');
  } else if (/\.(txt|md|markdown|csv)$/.test(lower) || !/\.[a-z0-9]{2,5}$/.test(lower)) {
    text = buffer.toString('utf8');
    if (text.includes('�') && text.split('�').length > 20) throw fail('That does not look like a text file.');
    if (!tidy(text)) throw fail('The file is empty.');
  } else {
    throw fail('Only Word (.docx), PDF and plain text (.txt, .md) files can be read.');
  }
  return tidy(text);
}
