import { classExistsInCss, extractStylesheetHrefs } from '../../implementers/lib/design-drift.js';

// Autonomous repair of a missing-but-safe-to-fix PREREQUISITE — not a
// content recommendation (that's generators/*.js), a fact about the site's
// own build configuration that is blocking otherwise-shippable work.
//
// This is deliberately a narrow, allow-listed registry (one entry today:
// a missing Tailwind Typography plugin), not a general "figure out what's
// wrong and fix the repo" capability. §16 of the remediation brief draws
// this line explicitly: "missing Tailwind utility -> repair source/config ->
// rebuild -> verify" is a safe, well-understood repair; inventing arbitrary
// fixes to an unfamiliar repo is not. Every entry here follows the same
// shape: detect from real evidence (repo content + live CSS), compute an
// exact, minimal, mechanical file edit, and let the caller build/verify
// before ever proposing it as a PR.
//
// THE CONCRETE CASE this exists for: zunkireelabs-web's blog-post.njk,
// glossary-term.njk and location.njk all use `prose`/`prose-lg` classes
// (real repo-derived markup — Design Agent, Phase 3/4's freshness checks),
// but @tailwindcss/typography is not installed (tailwind.config.js's
// `plugins: []`), so .prose* ships ZERO rules on the live site. Confirmed
// directly: fetching the real shipped CSS and checking for `.prose` finds
// nothing. Blog and glossary body copy renders unstyled today — a real
// defect, not a hypothetical one.

const TYPOGRAPHY_PACKAGE = '@tailwindcss/typography';
const TYPOGRAPHY_VERSION = '^0.5.20'; // compatible with both Tailwind v3 and v4 — verified via `npm view @tailwindcss/typography peerDependencies`

// A literal `class="...prose..."` (or the same inside a Nunjucks/JSX
// expression building a class string) anywhere in real template source —
// same "only trust literal, repo-derived evidence" discipline as
// design-drift.js's extractLiteralClassNames. Bare `prose`/`prose-*` word
// boundaries only, so this never matches an unrelated identifier that merely
// contains the substring.
const PROSE_CLASS_RE = /\bprose(?:-[\w-]+)?\b/;
const TEMPLATE_EXTENSIONS = ['njk', 'html', 'liquid', 'hbs', 'ejs', 'jsx', 'tsx', 'astro', 'vue'];

// Whether tailwind.config.js's plugins array ALREADY includes typography, by
// any of the ways a real config actually spells it — require(), a bare
// import specifier, or (Tailwind v4) an @plugin directive in a CSS entry
// file is out of scope here since v3's JS config is what this site uses.
// Text-matched rather than executed: this file can contain arbitrary JS, and
// evaluating an untrusted config is exactly what scripts/lib/safe-js-data-eval.js
// exists to avoid doing outside its own narrow, sandboxed purpose.
function configAlreadyHasTypography(tailwindConfigSource) {
  return tailwindConfigSource.includes(TYPOGRAPHY_PACKAGE);
}

// Real evidence, gathered in the cheapest-first order: config text (no
// network) before repo scan (one tree read + N fetches) before a live CSS
// check (network to the actual site). Returns null when there is nothing to
// repair — either the plugin is already configured, or no template actually
// uses a prose class, or (rarest) the live site somehow already ships
// `.prose` from some other source, in which case installing the plugin would
// be solving a problem that doesn't exist.
export async function detectMissingTypographyPlugin(site, {
  fetchTailwindConfig, fetchTree, fetchFile, fetchPage, fetchStylesheet, pageUrl,
}) {
  const configPath = 'tailwind.config.js';
  const configSource = await fetchTailwindConfig(configPath);
  if (!configSource) return null; // not a Tailwind site, or config lives somewhere else — nothing this repair knows how to fix
  if (configAlreadyHasTypography(configSource)) return null;

  const tree = await fetchTree();
  const templateFiles = (tree.files || []).filter((f) => (
    TEMPLATE_EXTENSIONS.some((ext) => f.endsWith(`.${ext}`)) && !f.includes('/_data/')
  ));

  const usingProse = [];
  for (const file of templateFiles) {
    const source = await fetchFile(file).catch(() => null);
    if (source && PROSE_CLASS_RE.test(source)) usingProse.push(file);
  }
  if (!usingProse.length) return null; // nothing on the site actually asks for it

  // Live-CSS confirmation — the same evidence bar as design-drift.js's
  // checkTemplateFreshness, so this repair is never proposed on a stale
  // assumption about what the site currently ships.
  if (!pageUrl) return { reason: 'no-live-url', usingProse, configPath };
  const html = await fetchPage(pageUrl).catch(() => null);
  if (!html) return { reason: 'unreachable', usingProse, configPath };
  const hrefs = extractStylesheetHrefs(html);
  const cssParts = [];
  for (const href of hrefs) {
    const css = await fetchStylesheet(new URL(href, pageUrl).href).catch(() => null);
    if (css) cssParts.push(css);
  }
  if (!cssParts.length) return { reason: 'unreachable', usingProse, configPath };
  const css = cssParts.join('\n');
  if (classExistsInCss('prose', css)) return null; // already ships from somewhere else — nothing to do

  return {
    reason: 'confirmed', usingProse, configPath,
    package: TYPOGRAPHY_PACKAGE, version: TYPOGRAPHY_VERSION,
  };
}

// ── The exact, minimal file edits — pure string/JSON transforms, no network.

// Adds the plugin to package.json's devDependencies, preserving every other
// key untouched. Alphabetized insertion only within devDependencies (JSON
// key order is otherwise irrelevant to npm, and this keeps the diff a
// reviewer sees to exactly one line rather than a whole-file reformat).
export function addTypographyToPackageJson(packageJsonSource) {
  const pkg = JSON.parse(packageJsonSource);
  pkg.devDependencies = pkg.devDependencies || {};
  if (pkg.devDependencies[TYPOGRAPHY_PACKAGE] || pkg.dependencies?.[TYPOGRAPHY_PACKAGE]) {
    return packageJsonSource; // already present — idempotent, not an error
  }
  const entries = Object.entries({ ...pkg.devDependencies, [TYPOGRAPHY_PACKAGE]: TYPOGRAPHY_VERSION })
    .sort(([a], [b]) => a.localeCompare(b));
  pkg.devDependencies = Object.fromEntries(entries);
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

// Wires the plugin into tailwind.config.js's `plugins` array. Deliberately a
// targeted regex substitution, not a JS parser/AST rewrite — this file's
// author-facing shape (an ESM `export default { ... plugins: [...] }`
// object literal) is common enough across real Tailwind v3 configs that a
// small, well-anchored substitution is safe, and a full AST tool would be
// new surface area for a one-line change. Refuses (returns null) rather than
// guessing when the shape doesn't match what it expects — the same
// never-guess discipline every other repair/heal path in this app follows.
export function addTypographyToTailwindConfig(configSource) {
  if (configAlreadyHasTypography(configSource)) return configSource;

  const IMPORT_LINE = `import typography from '${TYPOGRAPHY_PACKAGE}';\n`;
  let withImport = configSource;
  if (!/^import\s+typography\s+from/m.test(configSource)) {
    // Placed as the very first line — before any leading JSDoc comment too,
    // which is the conventional position and keeps this independent of
    // whatever else the file's header happens to contain.
    withImport = IMPORT_LINE + configSource;
  }

  // Matches `plugins: []` or `plugins: [ ]` (the common empty-array case,
  // confirmed as this site's actual shape) and an already-populated array
  // `plugins: [foo, bar]`, inserting rather than replacing so existing
  // plugins are preserved.
  const PLUGINS_RE = /plugins:\s*\[([^\]]*)\]/;
  const match = PLUGINS_RE.exec(withImport);
  if (!match) return null; // shape not recognized — refuse rather than guess where plugins live

  const existing = match[1].trim();
  const newInner = existing ? `${existing}, typography` : 'typography';
  const rewritten = withImport.slice(0, match.index) + `plugins: [${newInner}]` + withImport.slice(match.index + match[0].length);
  return rewritten;
}

// One deterministic descriptor of every file this repair touches — the
// caller (a script/agent orchestrating the branch+commit+PR) applies these
// verbatim rather than re-deriving what changed.
export function computeTypographyRepairEdits({ packageJsonSource, tailwindConfigSource }) {
  const newPackageJson = addTypographyToPackageJson(packageJsonSource);
  const newTailwindConfig = addTypographyToTailwindConfig(tailwindConfigSource);
  if (newTailwindConfig === null) {
    return { ok: false, reason: 'tailwind-config-shape-not-recognized' };
  }
  return {
    ok: true,
    edits: [
      { path: 'package.json', content: newPackageJson },
      { path: 'tailwind.config.js', content: newTailwindConfig },
    ],
  };
}
