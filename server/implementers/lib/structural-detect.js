import * as cheerio from 'cheerio';
import { parse as babelParse } from '@babel/parser';
import babelTraverse from '@babel/traverse';

// Structural (AST-based) detection of a "real content container" — the one
// piece of automation missing from marker-merge.js's NO_EOF_INSERT_FIELDS
// guard: on a component-based template (React/Next.js/Astro/.jsx/.tsx),
// end-of-file is outside the rendered tree, so nothing there can be safely
// auto-inserted at EOF (see that module's comment). This module answers
// "where IS the real rendered body, structurally" for the two template
// shapes this platform's onboarded sites actually use — parsed, not guessed
// from text position, so a confident answer here is genuinely inside the
// live rendered page, not a plausible-looking string match.
//
// Deliberately conservative in the same spirit as every other implementer
// in this directory (exact-match-patch.js, discover-file-mapping.js): an
// ambiguous or ownerless structure returns `{ok: false}` rather than a best
// guess. The caller (marker-bootstrap.js) treats a detected point as a
// PROPOSAL for a human-reviewed bootstrap PR, never a silent direct commit —
// so this module's only job is "is there a genuinely unambiguous answer,"
// not "how confident is a heuristic."

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
// an element that merely has the right tag/class name.
const MIN_CONTAINER_TEXT = 40;

export function isJsxFile(filePath) {
  return /\.(jsx|tsx)$/i.test(filePath || '');
}

export function isHtmlLikeFile(filePath) {
  return /\.(html?|astro|njk|liquid|hbs|ejs|vue)$/i.test(filePath || '');
}

// HTML-shaped templates (Astro/.njk/.html/...): parsed with cheerio's
// underlying parse5 in sourceCodeLocationInfo mode so every element carries
// its EXACT byte offset in the original source. Insertion always splices
// the raw original string at that offset — the DOM is only ever read, never
// re-serialized — so nothing about the file's existing formatting, framework
// directives (Astro's `{expr}`, Nunjucks' `{% %}`, ...), or unrelated markup
// is ever touched or reflowed. Those directives parse as inert text content
// to parse5 (it doesn't validate them), which is exactly what's wanted here:
// this module only needs real tag STRUCTURE, not to understand a specific
// framework's template language.
function detectHtmlContainer(fileContent) {
  let $;
  try {
    $ = cheerio.load(fileContent, { sourceCodeLocationInfo: true });
  } catch (err) {
    return { ok: false, reason: 'parse-error', error: err.message };
  }

  for (const selector of HTML_CONTAINER_SELECTORS) {
    let el;
    try {
      el = $(selector).toArray().find((node) => {
        const loc = node.sourceCodeLocation;
        return loc && loc.endTag && $(node).text().trim().length >= MIN_CONTAINER_TEXT;
      });
    } catch {
      continue; // an invalid CSS selector for this parse (unlikely) — try the next candidate rather than fail the whole detection
    }
    if (el) {
      return {
        ok: true,
        fileKind: 'html',
        insertBeforeOffset: el.sourceCodeLocation.endTag.startOffset,
        containerDescription: selector,
      };
    }
  }
  return { ok: false, reason: 'no-confident-html-container', error: `No real content container (${HTML_CONTAINER_SELECTORS.join(', ')}) with substantial text was found in this file.` };
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

// Depth-first search for the first <main>/<article> element inside a JSX
// tree — same priority as the HTML path, just walking a real AST instead of
// a parsed DOM. `.children` on a JSXElement/JSXFragment is the only place
// nested elements live in Babel's JSX AST shape.
function findJsxContainer(node) {
  if (node.type === 'JSXElement') {
    const name = node.openingElement.name;
    if (name.type === 'JSXIdentifier' && (name.name === 'main' || name.name === 'article')) return node;
  }
  for (const child of node.children || []) {
    if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
      const found = findJsxContainer(child);
      if (found) return found;
    }
  }
  return null;
}

function detectJsxContainer(fileContent) {
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
  const target = findJsxContainer(root) || root;

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

// Single entry point. Returns `{ok:false}` for any file type this module
// doesn't have a real structural strategy for (plain .md/.mdx never needs
// this — EOF already IS safe there, see marker-merge.js's
// isPlainMarkdownFile) rather than attempting a generic fallback.
export function detectInsertionPoint(fileContent, filePath) {
  if (isJsxFile(filePath)) return detectJsxContainer(fileContent);
  if (isHtmlLikeFile(filePath)) return detectHtmlContainer(fileContent);
  return { ok: false, reason: 'unsupported-file-type', error: `No structural-detection strategy for "${filePath}" — supported: .jsx/.tsx (AST) and .html/.astro/.njk/.liquid/.hbs/.ejs/.vue (parsed DOM).` };
}
