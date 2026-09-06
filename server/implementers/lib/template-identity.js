import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import babelTraverse from '@babel/traverse';
import { isJsxFile, isVueFile, isSvelteFile } from './structural-detect.js';

// Resolves the shared layout/base/component a given page renders through —
// the piece that makes "learn an insertion strategy once, reuse it for
// every page on that template" (strategy-registry.js) mean something beyond
// "two pages happen to be the same literal file." Two pages that are
// SEPARATE source files but both render through the same shared layout are
// exactly the case a per-file structural signature can't recognize on its
// own; this module is what lets the Strategy Registry key on the shared
// rendering structure instead.
//
// Same conservative discipline as structural-detect.js: every detector here
// either confirms a real, syntactically-explicit relationship (a front-matter
// `layout:` field, a real `{% extends %}`/`@extends()` statement, a real
// `import` resolved against the actual wrapping JSX/Vue/Svelte element) or
// returns null. Never a guess based on naming convention or file location
// alone — a wrong template-identity match would silently apply one page's
// learned strategy to an unrelated page's file, which is worse than falling
// back to that page's own independent (slower, but correct) detection.

const traverse = babelTraverse.default || babelTraverse;

function frontMatterBlock(fileContent) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(fileContent);
  return match ? match[1] : null;
}

// Eleventy / Jekyll / Astro content collections: `layout: post` (or
// `layout: "layouts/post.njk"`) in front matter. This is already the
// site's own declared template identity — a named/pathed layout id, not
// something that needs file-path resolution — so it's returned as-is.
function frontMatterLayout(fileContent) {
  const fm = frontMatterBlock(fileContent);
  if (!fm) return null;
  const match = /^layout:\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/m.exec(fm);
  if (!match) return null;
  return `layout:${match[1].trim()}`;
}

// Jinja / Django / Nunjucks / Twig: `{% extends "base.html" %}`. The
// extended template's path is resolved by the framework's own configured
// template-search-path (not relative to this file's own directory — that
// would be wrong for Jinja/Django's real resolution rules), so the raw
// string IS the correct identity key, used verbatim.
function templateExtends(fileContent) {
  const match = /\{%-?\s*extends\s+["']([^"']+)["']\s*-?%\}/.exec(fileContent);
  if (!match) return null;
  return `extends:${match[1].replace(/\.(html?|jinja2?|j2|twig|njk)$/i, '')}`;
}

// Laravel Blade: `@extends('layouts.app')`. Blade view names are already a
// dot-namespaced identity independent of this file's own location.
function bladeExtends(fileContent) {
  const match = /@extends\(\s*["']([^"']+)["']\s*\)/.exec(fileContent);
  if (!match) return null;
  return `extends:${match[1].replace(/\./g, '/')}`;
}

// A relative import specifier (`'../layouts/Post.astro'`) is resolved
// against THIS file's own directory into a normalized, extension-stripped
// repo-relative path — the same real file imported via a different relative
// path from a different directory correctly normalizes to one identity. A
// bare/aliased specifier (`'@/components/Layout'`, `'layouts/Post'`) can't be
// safely resolved without this repo's real module-resolution config
// (tsconfig paths, bundler aliases) — kept as its own distinct namespace
// (`component-alias:`) rather than guessed at, so it still matches identical
// imports without ever colliding with an unrelated resolved real path.
function normalizeImportSpecifier(specifier, filePath) {
  if (specifier.startsWith('.')) {
    const dir = path.posix.dirname(filePath.replace(/\\/g, '/'));
    const resolved = path.posix.normalize(path.posix.join(dir, specifier));
    return `component:${resolved.replace(/\.(jsx|tsx|js|ts|mjs|vue|svelte|astro)$/i, '')}`;
  }
  return `component-alias:${specifier}`;
}

// Finds the single JSX root a page component returns (same shape as
// structural-detect.js's findReturnedJsxRoots, kept independent here since
// this module's job — "what wraps this page" — genuinely differs from
// structural-detect's "where's the content container inside it", and an
// ambiguous/ownerless result means the same thing in both: refuse, don't
// guess which function is really the page).
function findSingleReturnedJsxRoot(ast) {
  const roots = [];
  traverse(ast, {
    ReturnStatement(p) {
      const arg = p.node.argument;
      if (!arg) return;
      const jsx = arg.type === 'JSXElement' ? arg
        : (arg.type === 'ParenthesizedExpression' && arg.expression?.type === 'JSXElement') ? arg.expression
        : null;
      if (jsx) roots.push(jsx);
    },
    ArrowFunctionExpression(p) {
      if (p.node.body?.type === 'JSXElement') roots.push(p.node.body);
    },
  });
  return roots.length === 1 ? roots[0] : null;
}

// JSX/TSX: a page whose entire returned tree is wrapped in a single
// capitalized custom component (`<Layout>...</Layout>`, not an intrinsic
// tag like `<div>`) — the import that component's local name resolves to
// (found via a real `import X from '...'` binding, not a name-string guess)
// is the template identity.
function jsxWrappingComponentImport(fileContent) {
  let ast;
  try {
    ast = babelParse(fileContent, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: false });
  } catch {
    return null;
  }
  const root = findSingleReturnedJsxRoot(ast);
  if (!root || root.type !== 'JSXElement') return null;
  const name = root.openingElement.name;
  if (name.type !== 'JSXIdentifier' || !/^[A-Z]/.test(name.name)) return null;

  let importPath = null;
  traverse(ast, {
    ImportDeclaration(p) {
      const hit = p.node.specifiers.find((s) => s.type === 'ImportDefaultSpecifier' && s.local.name === name.name);
      if (hit) importPath = p.node.source.value;
    },
  });
  return importPath;
}

// Vue SFC / Svelte: the outermost tag in the component's real markup region
// (Vue's <template> block; Svelte's markup outside <script>/<style>) is a
// capitalized custom component imported in <script> — same "single explicit
// wrapping import" principle as the JSX case, applied to whichever region
// actually renders.
function scriptImportedWrapper(fileContent, filePath) {
  let markup;
  if (isVueFile(filePath)) {
    const match = /<template[^>]*>([\s\S]*?)<\/template>/i.exec(fileContent);
    if (!match) return null;
    markup = match[1];
  } else {
    markup = fileContent.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  }
  const outer = /^\s*<([A-Z][A-Za-z0-9]*)\b/.exec(markup.trim());
  if (!outer) return null;
  const tagName = outer[1];
  const importMatch = new RegExp(`import\\s+${tagName}\\s+from\\s+["']([^"']+)["']`).exec(fileContent);
  return importMatch ? importMatch[1] : null;
}

// Single entry point. Tries every real, syntactically-explicit relationship
// this page's source can confirm, in the order most specific/cheap first;
// returns the first confirmed identity, or `null` when none can be
// confirmed (caller falls back to purely per-file detection/caching —
// see strategy-registry.js).
export function resolveTemplateIdentity(fileContent, filePath) {
  const layout = frontMatterLayout(fileContent);
  if (layout) return layout;

  const extendsTemplate = templateExtends(fileContent) || bladeExtends(fileContent);
  if (extendsTemplate) return extendsTemplate;

  if (isJsxFile(filePath)) {
    const importPath = jsxWrappingComponentImport(fileContent);
    if (importPath) return normalizeImportSpecifier(importPath, filePath);
  }

  if (isVueFile(filePath) || isSvelteFile(filePath)) {
    const importPath = scriptImportedWrapper(fileContent, filePath);
    if (importPath) return normalizeImportSpecifier(importPath, filePath);
  }

  return null;
}
