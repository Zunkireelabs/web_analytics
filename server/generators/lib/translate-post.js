// WHOLE-POST TRANSLATION. The translation generator used to translate the first 2,000 characters of a page's plain text: a translated blog came out at about half the
// size of its source with no table, FAQ, sources, related articles or call to action. This translates the SOURCE FILE (markdown with front matter) in chunks and keeps
// everything the reader sees: every section, table, FAQ block, sources list, related-article links and CTA.
//
// Safety rules (the translation never ships "mostly right"):
//  - every chunk must keep the SAME structure as its source (HTML tags with their class/href/rel/id, every URL, HTML comments and template tags, headings, table rows);
//    one retry with the exact difference as feedback, then the whole translation is refused (an error), never a partial post;
//  - a chunk that comes back much shorter than its source is refused too (a cut-off or summarised reply);
//  - front matter keeps every key (date, image, translationKey, related, ...) and only the reader-facing text fields are translated; the `tags` list is dropped so
//    the language directory's own collection tag (blog-de, ...) is not overridden.
// Pure apart from the injected `translateText(system, user, { maxTokens })` (the Claude worker in production), so it is testable on its own.

export const CHUNK_CHARS = 2600;
const MIN_LENGTH_RATIO = 0.5; // a translated chunk shorter than this share of its source (for any chunk over 300 characters) is a cut-off or a summary
const TRANSLATED_KEYS = new Set(['title', 'seoTitle', 'description', 'seoDescription', 'shortLabel', 'featuredImageAlt']);
// `tags` are not translated; `permalink` and `slug` are dropped because a translated copy that kept its source's would claim the SAME address and fail the client's build (two pages, one output file): the copy gets its own address from its file name.
const DROPPED_KEYS = new Set(['tags', 'permalink', 'slug']);
const BLOCK_SCALAR = /^[>|][+-]?\d*$/;

/** Splits `---\nfront matter\n---\nbody`. A file with no front matter is all body. */
export function splitFrontMatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw || '');
  if (!m) return { front: null, body: raw || '' };
  return { front: m[1], body: (raw || '').slice(m[0].length) };
}

const unquote = (v) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try { return t.startsWith('"') ? JSON.parse(t) : t.slice(1, -1).replace(/''/g, "'"); } catch { return t.slice(1, -1); }
  }
  return t;
};

/** The front matter as lines, with the reader-facing text fields found. Only single-line `key: value` fields are translated; lists and everything else pass through. */
export function readFrontMatter(front) {
  const lines = String(front || '').split(/\r?\n/);
  const out = []; const fields = {};
  let skippingList = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const key = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    // A dropped key's list items, indented or not (`tags:` followed by `- a` at column 0 is valid YAML), go with it.
    if (skippingList) { if (/^\s*-\s|^\s+\S|^\s*$/.test(line) && !key) continue; skippingList = false; }
    if (key && DROPPED_KEYS.has(key[1])) { skippingList = true; continue; }
    if (key && TRANSLATED_KEYS.has(key[1]) && key[2] != null && key[2] !== '') {
      // A folded or literal block (`description: >-` then indented lines) is one value: its lines are joined into a single line so it is translated as text, never as the marker ">-".
      if (BLOCK_SCALAR.test(key[2].trim())) {
        const block = [];
        while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1])) { i += 1; if (lines[i].trim()) block.push(lines[i].trim()); }
        if (block.length) { fields[key[1]] = block.join(' '); out.push({ key: key[1], translate: true }); continue; }
        out.push({ raw: line }); continue;
      }
      fields[key[1]] = unquote(key[2]);
      out.push({ key: key[1], translate: true });
      continue;
    }
    out.push({ raw: line });
  }
  return { lines: out, fields };
}

export function writeFrontMatter(parsed, translated) {
  return parsed.lines.map((l) => (l.translate ? `${l.key}: ${JSON.stringify(translated[l.key] ?? '')}` : l.raw)).join('\n');
}

/** The whole translated file with the reviewer's edits applied. The draft keeps the generated file (`translatedFile`) next to what the generator put in the three fields a person can
 *  edit (`translatedFileParts`: title, meta description, body); a field whose current value differs from that is an edit, and only edits are written into the file.
 *  Without the recorded originals (an older draft) or without any difference, the file comes back exactly as it was. */
export function applyEditsToTranslatedFile(file, edited = {}, original = null) {
  if (!original) return file;
  const changed = (k) => typeof edited[k] === 'string' && edited[k].trim() && edited[k] !== original[k];
  if (!changed('title') && !changed('description') && !changed('body')) return file;
  const { front, body: fileBody } = splitFrontMatter(file);
  let newFront = front;
  if (front != null) {
    const setLine = (keys, value) => {
      newFront = newFront.split(/\r?\n/).map((line) => {
        const m = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
        if (!m || !keys.includes(m[1]) || m[2] == null || m[2] === '') return line;
        return `${m[1]}: ${JSON.stringify(value)}`;
      }).join('\n');
    };
    if (changed('title')) setLine(['title'], edited.title);
    if (changed('description')) setLine(['description', 'seoDescription'], edited.description);
  }
  const newBody = changed('body') ? edited.body : fileBody;
  return front == null ? newBody : `---\n${newFront}\n---\n\n${newBody.replace(/^\s+/, '')}`;
}

/** Blocks at blank lines, grouped into chunks of at most `limit` characters; one block larger than the limit is its own chunk. Joining the chunks gives the body back exactly. */
export function chunkBody(body, limit = CHUNK_CHARS) {
  const blocks = String(body || '').split(/(\n[ \t]*\n)/); // keeps the blank-line separators so nothing is lost on join
  const chunks = []; let cur = '';
  for (let i = 0; i < blocks.length; i += 2) {
    const piece = blocks[i] + (blocks[i + 1] || '');
    if (cur && (cur.length + piece.length > limit)) { chunks.push(cur); cur = ''; }
    cur += piece;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const TAG = /<\/?[A-Za-z][^>]*>/g;
const ATTR = /\b(class|href|rel|id|src|target)=("[^"]*"|'[^']*')/g;
/** Everything that must survive translation unchanged, as comparable lists. */
export function structureSignature(text) {
  const t = String(text || '');
  const tags = (t.match(TAG) || []).map((tag) => {
    const name = /^<\/?\s*([A-Za-z][\w-]*)/.exec(tag)?.[1]?.toLowerCase() || '';
    const attrs = [...tag.matchAll(ATTR)].map((a) => `${a[1]}=${a[2]}`).join(' ');
    return `${tag.startsWith('</') ? '/' : ''}${name}${attrs ? ` ${attrs}` : ''}`;
  });
  const mdUrls = [...t.matchAll(/\]\(([^)\s]+)[^)]*\)/g)].map((m) => m[1]);
  const comments = t.match(/<!--[\s\S]*?-->/g) || [];
  const templateTags = t.match(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g) || [];
  const headings = t.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.match(/^#+/)[0]);
  const tableRows = t.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
  const separators = t.split('\n').filter((l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)).length;
  return { tags, mdUrls, comments, templateTags, headings, tableRows, separators };
}

export function structureDifference(source, translated) {
  const a = structureSignature(source); const b = structureSignature(translated);
  const diffs = [];
  for (const k of Object.keys(a)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${k}: the source has ${Array.isArray(a[k]) ? a[k].length : a[k]} and the translation has ${Array.isArray(b[k]) ? b[k].length : b[k]}`);
  }
  return diffs;
}

const stripFence = (s) => String(s || '').replace(/^\s*```[a-z]*\r?\n/, '').replace(/\r?\n```\s*$/, '');

const chunkSystem = (language) =>
  `You are a professional translator for a company website. Translate everything a reader sees into ${language}, in a natural, professional tone. Keep EXACTLY as written: ` +
  'markdown syntax (#, **, lists, table pipes and the --- separator row), every HTML tag and attribute (class, href, rel, id, src), every URL, HTML comments such as <!-- SEOAI:FAQ:START -->, ' +
  'template tags like {% ... %} and {{ ... }}, code, numbers, and brand and product names. Translate the visible text, including link text and the text inside HTML elements. ' +
  'Do not summarize, shorten, add, omit or reorder anything: the translation must have the same blocks in the same order. Reply with ONLY the translated text, no code fence and no commentary.';

async function translateChunk(chunk, language, translateText) {
  const maxTokens = Math.min(8000, Math.ceil(chunk.length * 0.6) + 800);
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = stripFence(await translateText(chunkSystem(language), `${feedback}${chunk}`, { maxTokens }));
    const diffs = structureDifference(chunk, out);
    const tooShort = chunk.length > 300 && out.trim().length < chunk.trim().length * MIN_LENGTH_RATIO;
    if (!diffs.length && !tooShort && out.trim()) {
      // Whitespace at the ends belongs to the block separators, not the text: keep the source's own.
      const lead = /^\s*/.exec(chunk)[0]; const tail = /\s*$/.exec(chunk)[0];
      return lead + out.trim() + tail;
    }
    feedback = `Your previous translation of the text below was refused: ${tooShort ? 'it was far shorter than the source (something was left out). ' : ''}${diffs.join('; ')}. ` +
      'Translate it again, keeping every tag, URL, comment, heading and table row exactly as in the source and leaving nothing out. The text to translate follows.\n\n';
  }
  throw Object.assign(new Error('Translation refused: the translated text did not keep the source structure (tags, links, headings, tables) or left content out.'), { status: 400, translationStructure: true });
}

async function translateFields(fields, language, translateText) {
  const names = Object.keys(fields);
  if (!names.length) return {};
  const system = `You translate a web page's title and description fields into ${language}. Keep brand and product names. Respond with ONLY a JSON object with exactly the same keys.`;
  const raw = stripFence(await translateText(system, JSON.stringify(fields), { maxTokens: 1500 }));
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
    try { parsed = JSON.parse(raw.slice(s, e + 1)); } catch { parsed = null; }
  }
  if (!parsed || names.some((k) => typeof parsed[k] !== 'string' || !parsed[k].trim())) {
    throw Object.assign(new Error('Translation refused: the title and description fields did not come back translated.'), { status: 400 });
  }
  return Object.fromEntries(names.map((k) => [k, parsed[k].trim()]));
}

/**
 * @param {{raw: string, targetLanguage: string, translateText: (system: string, user: string, opts: {maxTokens: number}) => Promise<string>, concurrency?: number}} args
 * @returns {Promise<{file: string, body: string, title: string, description: string, chunks: number}>}
 */
export async function translatePostFile({ raw, targetLanguage, translateText, concurrency = 2 }) {
  const { front, body } = splitFrontMatter(raw);
  const parsed = readFrontMatter(front);
  const chunks = chunkBody(body);
  const translatedFields = await translateFields(parsed.fields, targetLanguage, translateText);
  const out = new Array(chunks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, chunks.length)) }, async () => {
    while (next < chunks.length) { const i = next++; out[i] = await translateChunk(chunks[i], targetLanguage, translateText); }
  }));
  const translatedBody = out.join('');
  const whole = structureDifference(body, translatedBody);
  if (whole.length) throw Object.assign(new Error(`Translation refused: the whole translated post differs from the source structure (${whole.join('; ')}).`), { status: 400, translationStructure: true });
  const file = front == null ? translatedBody : `---\n${writeFrontMatter(parsed, translatedFields)}\n---\n\n${translatedBody.replace(/^\s+/, '')}`;
  return { file, body: translatedBody, title: translatedFields.title || '', description: translatedFields.description || translatedFields.seoDescription || '', chunks: chunks.length };
}
