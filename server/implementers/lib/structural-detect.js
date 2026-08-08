import * as cheerio from 'cheerio';
import { parse as babelParse } from '@babel/parser';
import babelTraverse from '@babel/traverse';

// Structural (AST/DOM-based) detection of a "real content container" — the
// universal insertion engine's first layer (see insertion-engine.js). Answers
// "where IS the real rendered body, structurally" without a hard-coded list
// of supported frameworks: every detector below works off real parsed
// structure (a JS/JSX AST, or a parsed DOM tree), never a text-position
// guess, so a confident answer here is genuinely inside the live rendered
// page. `detectInsertionPoint` tries each detector in priority order and
// returns the first confident match — this is what lets an unfamiliar/custom
// template shape still resolve via the same generic DOM/AST reasoning
// instead of hitting a hard "unsupported framework" wall.
//
// Deliberately conservative in the same spirit as every other implementer in
// this directory (exact-match-patch.js, discover-file-mapping.js): an
// ambiguous or ownerless structure returns `{ok: false}` rather than a best
// guess. The caller (insertion-engine.js) treats a detected point as
// something to commit alongside the real content change in the same batch
// PR a human already reviews — never a silent, unreviewed change to a
// client's live site.

const traverse = babelTraverse.default || babelTraverse;

// Priority-ordered, same real-world convention list page-content.js already
// uses to find a live page's main content when reading FOR generation — this
// module targets the SOURCE template that produces those same pages, so a
// shared list keeps the two directions of "what counts as the real content
// area" from silently disagreeing.
const HTML_CONTAINER_SELECTORS = ['main', 'article', '[role="main"]', '#content', '.content', '#main-content', '.main-content', '.post-content', '.entry-content', '.article-body', '.article-content'];

// Below this, a matched container is treated as an empty/near-empty wrapper
// (e.g. a client-rendered app shell's <main id="root"></main>) — a real
// insertion point needs to already be inside genuine rendered content, not
// an element that merely has the right tag/class name. Measured on text with
// any existing SEOAI marker comments stripped first (see stripMarkerComments
// below) — otherwise a shell page whose only "content" is an empty marker
// pair could misreport as substantial and pass this bar on marker text
// alone, same failure class this platform's render-mode inspector already
// guards against for content INSPECTION (lib/render-inspector.js).
const MIN_CONTAINER_TEXT = 40;

export function isJsxFile(filePath) {
  return /\.(jsx|tsx)$/i.test(filePath || '');
}

// Vue single-file components and Svelte components both wrap their real
// markup in a distinct top-level block ( <template>...</template> for Vue,
// bare top-level markup for Svelte) rather than being JSX or plain HTML
// documents — handled by their own extractor (extractComponentTemplateBlock)
// before falling through to the generic DOM detector.
export function isVueFile(filePath) {
  return /\.vue$/i.test(filePath || '');
}

export function isSvelteFile(filePath) {
  return /\.svelte$/i.test(filePath || '');
}

// Broad HTML-*shaped* template coverage — not a framework allow-list. Every
// one of these emits real HTML tags with some framework-specific directive
// syntax interleaved ({% %} Jinja/Django/Nunjucks/Twig, <% %> ERB/EJS, @if/
// @extends Blade, <?php ?> PHP, {{ }} everywhere). cheerio's underlying
// parse5 tokenizes real tag structure and treats anything it doesn't
// recognize as inert text (see detectHtmlContainer's comment) — so this one
// detector already covers Django/Flask/Jinja, Rails/ERB, Laravel/Blade,
// Twig, and plain PHP templates without a bespoke parser per framework.
export function isHtmlLikeFile(filePath) {
  return /\.(html?|astro|njk|liquid|hbs|ejs|php|blade\.php|erb|jinja2?|j2|twig|eex|leex)$/i.test(filePath || '');
}

export function isMarkdownFile(filePath) {
  return /\.mdx?$/i.test(filePath || '');
}

// Strips already-placed SEOAI marker comments (both HTML and JSX
// conventions) before measuring "how much real content is here" — an empty
// marker pair is zero real content, not ~30 characters of it, matching this
// codebase's existing engineering lesson about not letting internal
// framework/marker text be mistaken for real page content.
function stripMarkerComments(text) {
  return String(text || '')
    .replace(/<!--\s*SEOAI:[\s\S]*?-->/g, '')
    .replace(/\{\/\*\s*SEOAI:[\s\S]*?\*\/\}/g, '');
}

// HTML-shaped templates: parsed with cheerio's underlying parse5 in
// sourceCodeLocationInfo mode so every element carries its EXACT byte offset
// in the original source. Insertion always splices the raw original string
// at that offset — the DOM is only ever read, never re-serialized — so
// nothing about the file's existing formatting, framework directives, or
// unrelated markup is ever touched or reflowed. Those directives parse as
// inert text content to parse5 (it doesn't validate them), which is exactly
// what's wanted here: this module only needs real tag STRUCTURE, not to
// understand any specific framework's template language.
// `minTextOverride`/`onlySelector` support the "trusted strategy" path
// (detectWithTrustedContainer below): when a DIFFERENT file on the same
// resolved template identity has already proven a given selector is the
// real content container, a brand-new/thin page on that same template
// doesn't need to independently re-earn MIN_CONTAINER_TEXT confidence from
// its own (possibly sparse) content — it can trust the already-proven
// selector directly. Never used for a page with no template-identity match;
// that case always goes through the full, independently-earned check below.
function detectHtmlContainer(fileContent, offsetBase = 0, { minText = MIN_CONTAINER_TEXT, onlySelector = null } = {}) {
  let $;
  try {
    $ = cheerio.load(fileContent, { sourceCodeLocationInfo: true });
  } catch (err) {
    return { ok: false, reason: 'parse-error', error: err.message };
  }

  const selectors = onlySelector ? [onlySelector] : HTML_CONTAINER_SELECTORS;
  for (const selector of selectors) {
    let el;
    try {
      el = $(selector).toArray().find((node) => {
        const loc = node.sourceCodeLocation;
        return loc && loc.endTag && stripMarkerComments($(node).text()).trim().length >= minText;
      });
    } catch {
      continue; // an invalid CSS selector for this parse (unlikely) — try the next candidate rather than fail the whole detection
    }
    if (el) {
      return {
        ok: true,
        fileKind: 'html',
        insertBeforeOffset: offsetBase + el.sourceCodeLocation.endTag.startOffset,
        containerDescription: selector,
      };
    }
  }
  return { ok: false, reason: 'no-confident-html-container', error: `No real content container (${selectors.join(', ')}) with substantial text was found in this file.` };
}

// Vue SFC / Svelte: the real rendered markup lives inside a bounded region
// of the file (Vue's explicit <template>...</template> block; Svelte has no
// wrapper tag, its top-level markup outside <script>/<style> IS the
// template), never the whole file (which also contains <script>/<style>
// blocks that are never part of the rendered tree). Extracting that region
// first and DOM-parsing only it keeps this from ever matching a <main>-named
// CSS selector living inside <style>, or JS object literal text inside
// <script> that happens to look like a tag.
function extractComponentTemplateBlock(fileContent, filePath) {
  if (isVueFile(filePath)) {
    const match = /<template[^>]*>([\s\S]*?)<\/template>/i.exec(fileContent);
    if (!match) return { ok: false, reason: 'no-template-block', error: 'No <template> block found in this Vue single-file component.' };
    return { ok: true, block: match[1], offsetBase: match.index + match[0].indexOf(match[1]) };
  }
  // Svelte: strip <script>/<style> blocks positionally, treat what's left as
  // the template — a plain regex strip is safe here because Svelte's own
  // compiler requires these blocks to be well-formed, non-nested top-level
  // tags, so a single non-greedy pass reliably isolates markup between them.
  const scriptOrStyle = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
  let match;
  let cursor = 0;
  const segments = [];
  while ((match = scriptOrStyle.exec(fileContent))) {
    segments.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  segments.push({ start: cursor, end: fileContent.length });
  const markupSegment = segments.reduce((biggest, s) => (s.end - s.start) > (biggest.end - biggest.start) ? s : biggest, segments[0]);
  if (!markupSegment || markupSegment.end - markupSegment.start < MIN_CONTAINER_TEXT) {
    return { ok: false, reason: 'no-template-block', error: 'No real markup region found outside this Svelte component\'s <script>/<style> blocks.' };
  }
  return { ok: true, block: fileContent.slice(markupSegment.start, markupSegment.end), offsetBase: markupSegment.start };
}

function detectComponentTemplateContainer(fileContent, filePath, htmlOptions = {}) {
  const extracted = extractComponentTemplateBlock(fileContent, filePath);
  if (!extracted.ok) return extracted;
  const inner = detectHtmlContainer(extracted.block, extracted.offsetBase, htmlOptions);
  if (!inner.ok) return inner;
  return { ...inner, fileKind: isVueFile(filePath) ? 'vue' : 'svelte' };
}

// JSX/TSX (React/Next.js): parsed with a real JS/JSX parser (never regex —
// unlike HTML, `<...>` inside JS/JSX is only unambiguous once you're
// actually parsing expressions, not just tags). Requires the file to
// resolve to exactly ONE returned JSX tree — a file with zero JSX returns
// has nothing to anchor to, and a file with more than one (e.g. a page
// component plus an unrelated helper component) is genuinely ambiguous
// about which one is "the page," so both cases refuse rather than guess.
function findReturnedJsxRoots(ast) {
  const roots = [];
  traverse(ast, {
    ReturnStatement(path) {
      const arg = path.node.argument;
      if (!arg) return;
      const jsx = arg.type === 'JSXElement' ? arg
        : (arg.type === 'JSXFragment' ? arg
        : (arg.type === 'ParenthesizedExpression' && arg.expression?.type === 'JSXElement') ? arg.expression
        : null);
      if (jsx) roots.push(jsx);
    },
    ArrowFunctionExpression(path) {
      // Implicit-return arrow components: `() => <div>...</div>`
      const body = path.node.body;
      if (body?.type === 'JSXElement') roots.push(body);
    },
  });
  return roots;
}

// Depth-first search for the first element matching `tagNames` inside a JSX
// tree — same priority as the HTML path, just walking a real AST instead of
// a parsed DOM. `.children` on a JSXElement/JSXFragment is the only place
// nested elements live in Babel's JSX AST shape. `tagNames` defaults to
// main/article but accepts a single trusted tag name (see
// detectWithTrustedContainer) when a different tag was already proven
// correct on another page sharing this same template identity.
function findJsxContainer(node, tagNames = ['main', 'article']) {
  if (node.type === 'JSXElement') {
    const name = node.openingElement.name;
    if (name.type === 'JSXIdentifier' && tagNames.includes(name.name)) return node;
  }
  for (const child of node.children || []) {
    if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
      const found = findJsxContainer(child, tagNames);
      if (found) return found;
    }
  }
  return null;
}

function detectJsxContainer(fileContent, { trustedTagName = null } = {}) {
  let ast;
  try {
    ast = babelParse(fileContent, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: false,
    });
  } catch (err) {
    return { ok: false, reason: 'parse-error', error: `Could not parse this file as JSX/TSX: ${err.message}` };
  }

  const roots = findReturnedJsxRoots(ast);
  if (roots.length === 0) return { ok: false, reason: 'no-jsx-return-found', error: 'No component in this file returns JSX — nothing to anchor a content container to.' };
  if (roots.length > 1) return { ok: false, reason: 'multiple-jsx-returns-ambiguous', error: `Found ${roots.length} separate JSX-returning functions in this file — can't tell which one is the real page component.` };

  const root = roots[0];
  const found = findJsxContainer(root, trustedTagName ? [trustedTagName] : ['main', 'article']);
  if (trustedTagName && !found) {
    // The learned strategy expected a specific tag that isn't here — this
    // page's structure has genuinely diverged from the template it was
    // supposed to share; fail honestly rather than silently falling back to
    // the root (which could be a completely wrong container).
    return { ok: false, reason: 'trusted-tag-not-found', error: `Expected a <${trustedTagName}> element (learned from another page on this template) but none was found.` };
  }
  const target = found || root;

  // A self-closing element (`<Layout />`) or an empty fragment has no
  // interior to insert into — inserting "before its closing tag" would mean
  // inserting into its opening tag's attribute list, which is nonsense.
  if (target.type === 'JSXElement' && !target.closingElement) {
    return { ok: false, reason: 'self-closing-root-no-body', error: 'The page\'s root/content element has no children to insert content next to.' };
  }
  const closing = target.type === 'JSXFragment' ? target.closingFragment : target.closingElement;
  if (!closing) return { ok: false, reason: 'no-closing-tag', error: 'Could not locate a closing tag to insert before.' };

  return {
    ok: true,
    fileKind: 'jsx',
    insertBeforeOffset: closing.start,
    containerDescription: target === root
      ? 'the component\'s own returned root element (no <main>/<article> found inside it)'
      : `<${target.openingElement.name.name}>`,
  };
}

// Plain Markdown/MDX: the ONE case where end-of-file genuinely IS inside the
// rendered body — a pure content file with no component wrapper at all
// (this codebase's own newContentTargets convention: blog-outline,
// direct-answer; see frontend.js). There's no markup "after the last line"
// the way a .jsx/.tsx/.astro component has — the last line of the file IS
// the end of the rendered article. First-class detector (not a silent
// "no strategy needed" special case) so it participates in the same
// registry/audit trail as every other detector, and so it explicitly
// refuses on a file that's front-matter-only (nothing to append after
// safely, e.g. a data-only .md used as a config source rather than an
// article body).
function detectMarkdownContainer(fileContent, { minText = MIN_CONTAINER_TEXT } = {}) {
  const frontMatterMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(fileContent);
  const bodyStart = frontMatterMatch ? frontMatterMatch[0].length : 0;
  const body = stripMarkerComments(fileContent.slice(bodyStart));
  if (body.trim().length < minText) {
    return { ok: false, reason: 'no-markdown-body', error: 'This file has no substantial Markdown/MDX body content to anchor to (front matter only, or empty).' };
  }
  return {
    ok: true,
    fileKind: 'markdown',
    insertBeforeOffset: fileContent.length,
    containerDescription: 'the Markdown/MDX article body (end of file)',
  };
}

function hasFrontMatterLayout(fileContent) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(fileContent);
  return !!fm && /^layout:\s*\S/m.test(fm[1]);
}

function hasFullDocumentWrapper(fileContent) {
  return /<html[\s>]/i.test(fileContent);
}

// Eleventy/Jekyll/Hugo-style CONTENT file: front matter declares a
// `layout:` reference (see template-identity.js's frontMatterLayout) and
// this file itself is a FRAGMENT — no <html>/<body> wrapper of its own —
// because the static-site generator slots this file's rendered body
// verbatim into the named layout's own content region
// (`{{ content }}`/`{% block content %}`/...). Real production evidence for
// this shape: a `.njk` service page with `layout: service.njk` in front
// matter and no <main>/<article> anywhere in its own source — the real
// <main> lives in service.njk, not here. detectHtmlContainer correctly
// finds nothing INSIDE this file for the same reason a plain Markdown body
// has nothing "after its last line" — there IS no more of this page's own
// document, because it was never a whole document to begin with. So this
// fragment's own end-of-file is exactly as safe as detectMarkdownContainer's
// EOF, just for an HTML-templated (not prose) content file. Tried only
// AFTER detectHtmlContainer fails — a layout-referencing file that ALSO
// happens to be a full document with its own <main> still prefers that
// real, more specific container.
function detectLayoutFragmentContainer(fileContent, { minText = MIN_CONTAINER_TEXT } = {}) {
  if (!hasFrontMatterLayout(fileContent) || hasFullDocumentWrapper(fileContent)) {
    return { ok: false, reason: 'not-a-layout-fragment', error: 'This file has no front-matter `layout:` reference, or it wraps its own full <html> document — not a layout-slotted content fragment.' };
  }
  const frontMatterMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(fileContent);
  const bodyStart = frontMatterMatch ? frontMatterMatch[0].length : 0;
  const body = stripMarkerComments(fileContent.slice(bodyStart));
  if (body.trim().length < minText) {
    return { ok: false, reason: 'no-fragment-body', error: 'This layout fragment has no substantial body content to anchor to.' };
  }
  return {
    ok: true,
    fileKind: 'html-fragment',
    insertBeforeOffset: fileContent.length,
    containerDescription: 'the layout fragment body (end of file, slotted into its declared layout)',
  };
}

// Single entry point — an ordered fallback CHAIN, not a single strategy
// keyed off file extension. This is what lets an unrecognized/custom
// template shape still resolve: try the detector best-suited to what the
// extension suggests first, but an ambiguous or wrong-shaped file falls
// through to the next real structural strategy instead of hitting a hard
// "unsupported framework" wall. Only a file that fails EVERY real detector
// returns `{ok: false}` — genuinely no safe structural answer exists yet,
// not merely "this extension isn't on a list."
export function detectInsertionPoint(fileContent, filePath) {
  const attempts = [];

  if (isJsxFile(filePath)) attempts.push(() => detectJsxContainer(fileContent));
  if (isVueFile(filePath) || isSvelteFile(filePath)) attempts.push(() => detectComponentTemplateContainer(fileContent, filePath));
  if (isMarkdownFile(filePath)) attempts.push(() => detectMarkdownContainer(fileContent));
  if (isHtmlLikeFile(filePath)) {
    attempts.push(() => detectHtmlContainer(fileContent));
    // A recognized HTML-like extension still safely falls through to the
    // layout-fragment EOF strategy — unlike JSX/Vue/Svelte, this isn't a
    // component tree with real markup after it; a layout-referencing
    // fragment with no <main>/<article> of its own has nothing further in
    // its OWN file at all, so EOF here is genuinely safe (see
    // detectLayoutFragmentContainer's comment).
    attempts.push(() => detectLayoutFragmentContainer(fileContent));
  }

  // A RECOGNIZED component-shaped extension (.jsx/.tsx/.vue/.svelte) never
  // falls through to an EOF-based strategy on its own detector's failure —
  // end-of-file on those formats is markup OUTSIDE the rendered component
  // tree entirely (the exact hazard marker-merge.js's isNoEofInsertField
  // guards against elsewhere in this codebase), so an ambiguous/self-closing/
  // unparseable JSX or Vue/Svelte file returns its own honest failure, full
  // stop.
  //
  // A genuinely UNRECOGNIZED extension (attempts.length === 0 — requirement
  // 13's "unknown/custom framework" case) gets real progressive fallback
  // instead of an immediate "unsupported" wall: try DOM/tag structure first
  // (catches any tag-shaped custom template language, since parse5 treats
  // unrecognized directive syntax as inert text — see detectHtmlContainer's
  // comment), then Markdown-body as the final resort (a prose/content file
  // under an extension this analyzer has never seen).
  if (attempts.length === 0) {
    attempts.push(() => detectHtmlContainer(fileContent));
    attempts.push(() => detectLayoutFragmentContainer(fileContent));
    attempts.push(() => detectMarkdownContainer(fileContent));
  }

  // Keeps the FIRST failure, not the last: attempts are ordered
  // most-specific-first, so the first one is almost always the most
  // on-topic diagnostic for this file's actual shape (e.g. "found an empty
  // <main>, not substantial enough") — a later fallback's failure is
  // usually just "this file isn't even the right shape for me" (e.g. "no
  // front-matter layout"), which would otherwise silently overwrite and
  // hide the more useful reason.
  let firstFailure = null;
  for (const attempt of attempts) {
    const result = attempt();
    if (result.ok) return result;
    if (!firstFailure) firstFailure = result;
  }
  return firstFailure || { ok: false, reason: 'unsupported-file-type', error: `No structural-detection strategy succeeded for "${filePath}".` };
}

// The "trusted strategy" path — called by strategy-registry.js only when a
// DIFFERENT file already resolved successfully on this same
// template-identity, with `containerDescription` carrying over whatever that
// prior detection found (a CSS selector like "main"/".post-content" for
// html/vue/svelte, a JSX tag name like "<ContentBody>", or the fixed
// Markdown sentinel). Bypasses MIN_CONTAINER_TEXT — the whole point is that
// a brand-new/thin page on a proven template shouldn't have to independently
// re-earn confidence from its own sparse content — but never bypasses a real
// structural mismatch: if the trusted selector/tag genuinely isn't present
// in THIS file, that's reported honestly (`trusted-*-not-found`) so the
// caller falls back to full independent detection rather than inserting in
// the wrong place.
export function detectWithTrustedContainer(fileContent, filePath, fileKind, containerDescription) {
  if (fileKind === 'jsx') {
    const tagMatch = /^<([A-Za-z][\w.-]*)>$/.exec(containerDescription || '');
    if (!tagMatch) return { ok: false, reason: 'trusted-strategy-not-applicable', error: 'No trusted tag name to anchor to for this JSX strategy.' };
    return detectJsxContainer(fileContent, { trustedTagName: tagMatch[1] });
  }
  if (fileKind === 'markdown') {
    return detectMarkdownContainer(fileContent, { minText: 1 });
  }
  if (fileKind === 'html-fragment') {
    return detectLayoutFragmentContainer(fileContent, { minText: 1 });
  }
  if (fileKind === 'vue' || fileKind === 'svelte') {
    const extracted = extractComponentTemplateBlock(fileContent, filePath);
    if (!extracted.ok) return extracted;
    const inner = detectHtmlContainer(extracted.block, extracted.offsetBase, { minText: 0, onlySelector: containerDescription });
    if (!inner.ok) return { ok: false, reason: 'trusted-selector-not-found', error: `Expected "${containerDescription}" (learned from another page on this template) but it wasn't found.` };
    return { ...inner, fileKind };
  }
  if (fileKind === 'html') {
    const result = detectHtmlContainer(fileContent, 0, { minText: 0, onlySelector: containerDescription });
    if (!result.ok) return { ok: false, reason: 'trusted-selector-not-found', error: `Expected "${containerDescription}" (learned from another page on this template) but it wasn't found.` };
    return result;
  }
  return { ok: false, reason: 'trusted-strategy-not-applicable', error: `No trusted-strategy handling for fileKind "${fileKind}".` };
}

// Detects a real <head> element to auto-create the SEOAI:HEAD region itself
// — closes the one remaining case (classifyMarkerGap's 'fatal-no-head-region')
// that previously required a human to hand-place
// <!-- SEOAI:HEAD:START/END --> once before any head-scoped field
// (canonical, open-graph, analytics) could ever self-heal. No text-length
// bar the way body containers have (MIN_CONTAINER_TEXT) — a <head> element
// existing at all, even empty, is real evidence of the right place; head
// content is metadata, not prose, so "substantial text" isn't a meaningful
// signal here.
export function detectHeadRegion(fileContent) {
  let $;
  try {
    $ = cheerio.load(fileContent, { sourceCodeLocationInfo: true });
  } catch (err) {
    return { ok: false, reason: 'parse-error', error: err.message };
  }
  const head = $('head').toArray().find((node) => node.sourceCodeLocation?.endTag);
  if (!head) return { ok: false, reason: 'no-head-element', error: 'No <head> element with a real closing tag was found in this file.' };
  return {
    ok: true,
    fileKind: 'html',
    insertBeforeOffset: head.sourceCodeLocation.endTag.startOffset,
    containerDescription: 'head',
  };
}
