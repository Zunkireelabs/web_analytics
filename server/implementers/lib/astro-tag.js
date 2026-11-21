// Pure parsing of an Astro page's first component tag (the layout): its attributes and where they sit. No imports, so recipes and tests can use it
// without loading anything else. marker-merge.js builds on it.

// Reads one `<Name attr="x" other={expr} flag>` starting at src[start] === '<'. Returns null when it is not a well-formed component tag.
export function parseComponentTag(src, start) {
  let i = start + 1;
  const nm = /^[A-Z][\w.:-]*/.exec(src.slice(i, i + 80));
  if (!nm) return null;
  const name = nm[0]; i += name.length;
  const attrs = [];
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  for (;;) {
    skipWs();
    if (i >= src.length) return null;
    if (src[i] === '>') return { name, attrs, start, end: i + 1 };
    if (src[i] === '/' && src[i + 1] === '>') return { name, attrs, start, end: i + 2 };
    const an = /^[A-Za-z_:@][\w:.@-]*/.exec(src.slice(i, i + 120));
    if (!an) {
      if (src[i] === '{') { const e = skipBraces(src, i); if (e == null) return null; i = e; continue; }   // {...spread}
      return null;
    }
    const attr = { name: an[0], kind: 'flag' }; i += an[0].length;
    skipWs();
    if (src[i] === '=') {
      i++; skipWs();
      const c = src[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
        if (j >= src.length) return null;
        Object.assign(attr, { kind: 'string', quote: c, value: src.slice(i + 1, j), valueStart: i, valueEnd: j + 1 });
        i = j + 1;
      } else if (c === '{') {
        const e = skipBraces(src, i); if (e == null) return null;
        // A value already wrapped by OUR marker (`{/* SEOAI:TITLE */ "x"}`) is still a literal: the second field must not refuse because of the first.
        const marked = /^\{\s*\/\*\s*SEOAI:[\w-]+\s*\*\/\s*(["'])(?:(?!\1)[^\\]|\\.)*\1\s*\}$/.test(src.slice(i, e));
        Object.assign(attr, { kind: marked ? 'marked' : 'expr', valueStart: i, valueEnd: e }); i = e;
      } else {
        const bare = /^[^\s>]+/.exec(src.slice(i)); if (!bare) return null;
        Object.assign(attr, { kind: 'bare' }); i += bare[0].length;
      }
    }
    attrs.push(attr);
  }
}

// Index just past the `}` that closes the `{` at src[i], skipping braces inside strings and template literals.
export function skipBraces(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { const q = c; j++; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return null;
}

// The template part of an .astro file: everything after the closing `---` of its frontmatter fence (or the whole file when it has none).
function astroTemplateStart(content) {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/.exec(content);
  return m ? m[0].length : 0;
}

export function firstComponentTag(content) {
  const from = astroTemplateStart(content);
  const re = /<([A-Z][\w.:-]*)/g; re.lastIndex = from;
  let m;
  while ((m = re.exec(content))) {
    const tag = parseComponentTag(content, m.index);
    if (tag) return tag;
  }
  return null;
}

