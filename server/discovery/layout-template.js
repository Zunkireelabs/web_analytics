import { getRepoTree, getFileContent } from '../github/client.js';
import { setViewportMeta } from '../implementers/lib/viewport-inject.js';

// Works out siteRoot.layoutTemplate: the ONE shared file that renders <html> and <head> for the whole site.
// Layout-level fixes (viewport, html lang, analytics, security meta) are all edits to that file, so without it a
// project can ship page fixes but nothing sitewide.
//
// Nothing here guesses. A file is only chosen on evidence the repo itself shows:
//   1. it is the only file in the repo that renders both <html> and <head>; or
//   2. it is the framework's own root layout (Next app/layout, Jekyll _layouts/default, Hugo baseof, ...); or
//   3. it is the layout most of the site's own pages actually use, and clearly more than the next one.
// Anything else is left unset, with the reason, rather than picked. The pick is then checked the way the fixers
// will use it (a viewport edit must find the <head>), and a value a person already set is never touched.

const TEMPLATE_EXT = /\.(astro|html|njk|liquid|hbs|handlebars|ejs|pug|vue|svelte|tsx|jsx|js|php|erb|cshtml|twig|jinja2?|mustache)$/i;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.git|coverage|vendor|tests?|__tests__|__mocks__|stories|storybook|docs?|examples?)(\/|$)/i;
const SKIP_FILE = /\.(test|spec|stories)\.[a-z]+$/i;
const MAX_CANDIDATE_READS = 40;
const MAX_PAGE_READS = 12;

// Roots the framework itself defines, most specific first.
const CANONICAL = [
  /^(src\/)?app\/layout\.(tsx|jsx|js)$/,                 // Next.js app router
  /^(src\/)?pages\/_document\.(tsx|jsx|js)$/,            // Next.js pages router
  /^_layouts\/default\.html$/,                           // Jekyll
  /^layouts\/_default\/baseof\.html$/,                   // Hugo
  /^(src\/)?app\.html$/,                                 // SvelteKit
  /^app\.vue$/, /^layouts\/default\.vue$/,               // Nuxt
  /^index\.html$/,                                       // single-page / plain static root
];
const PREFERRED_NAME = /(^|\/)(base|layout|default|main|site|root|app|baseof|index)\.[a-z0-9]+$/i;

export const looksLikeLayout = (content) => /<html\b/i.test(content || '') && /<head\b/i.test(content || '');

export function candidatePaths(files) {
  return (files || []).filter((f) => TEMPLATE_EXT.test(f) && !SKIP_DIR.test(f) && !SKIP_FILE.test(f));
}

const stem = (p) => p.split('/').pop().replace(/\.[^.]+$/, '');
const countUses = (layoutPath, pageContents) => {
  const name = stem(layoutPath);
  const re = new RegExp(`(?:from\\s+['"][^'"]*${name}(?:\\.[a-z]+)?['"]|layout\\s*[:=]\\s*['"]?[^\\s'"]*${name}|extends\\s+['"][^'"]*${name}|include\\s+['"][^'"]*${name}|<${name}[\\s>/]|@layout\\s+['"][^'"]*${name})`, 'i');
  return pageContents.filter((c) => re.test(c)).length;
};

// candidates: [{ path, content }] that already pass looksLikeLayout. pageContents: sources of the site's own pages.
// -> { path, evidence } | { path: null, reason, options? }
export function chooseLayoutTemplate(candidates, pageContents = []) {
  if (!candidates.length) return { path: null, reason: 'no-file-renders-html-and-head' };
  if (candidates.length === 1) return { path: candidates[0].path, evidence: 'the only file in the repository that renders <html> and <head>' };

  const canonical = CANONICAL.map((re) => candidates.filter((c) => re.test(c.path))).find((m) => m.length === 1);
  if (canonical) return { path: canonical[0].path, evidence: `the framework's own root layout (${canonical[0].path})` };

  const ranked = candidates
    .map((c) => ({ ...c, uses: countUses(c.path, pageContents), named: PREFERRED_NAME.test(c.path) ? 1 : 0 }))
    .sort((a, b) => b.uses - a.uses || b.named - a.named);
  const [top, next] = ranked;
  if (top.uses >= 2 && top.uses > (next?.uses ?? 0)) {
    return { path: top.path, evidence: `the layout ${top.uses} of the site's ${pageContents.length} sampled pages use, more than any other` };
  }
  return { path: null, reason: 'several-layouts-no-clear-owner', options: ranked.slice(0, 5).map((c) => c.path) };
}

// The pick must work for the fixers that will edit it: a viewport edit has to find the <head> tag.
export function verifyLayoutFile(content) {
  if (!looksLikeLayout(content)) return false;
  const r = setViewportMeta(content, 'width=device-width, initial-scale=1');
  return r.ok === true || r.reason === 'viewport-already-correct';
}

export async function deriveLayoutTemplate(site, { fetchTree = getRepoTree, fetchFile = getFileContent } = {}) {
  const existing = site?.url_file_map?.siteRoot?.layoutTemplate;
  if (existing) return { path: existing, kept: true, evidence: 'already set by a person — left alone' };
  if (!site?.repo_owner || !site?.repo_name) return { path: null, reason: 'no-repo-configured' };

  const branch = site.repo_default_branch || 'main';
  const { files } = await fetchTree(site, branch);
  const paths = candidatePaths(files).slice(0, MAX_CANDIDATE_READS * 5);

  // Read only files that could plausibly be a root layout, bounded, one at a time.
  const likely = [...paths.filter((p) => CANONICAL.some((re) => re.test(p)) || /layout|base|default|main|site|root|app|document|index|head/i.test(p.split('/').pop()))].slice(0, MAX_CANDIDATE_READS);
  const candidates = [];
  for (const path of likely) {
    const file = await fetchFile(site, path, branch).catch(() => null);
    const content = file?.content ?? file;
    if (typeof content === 'string' && looksLikeLayout(content)) candidates.push({ path, content });
  }

  const pageFiles = [...new Set(Object.values(site.url_file_map?.pages || {}).map((v) => (typeof v === 'string' ? v : v?.file)).filter(Boolean))].slice(0, MAX_PAGE_READS);
  const pageContents = [];
  for (const path of pageFiles) {
    const file = await fetchFile(site, path, branch).catch(() => null);
    const content = file?.content ?? file;
    if (typeof content === 'string') pageContents.push(content);
  }

  const choice = chooseLayoutTemplate(candidates, pageContents);
  if (!choice.path) return choice;
  const picked = candidates.find((c) => c.path === choice.path);
  if (!verifyLayoutFile(picked.content)) return { path: null, reason: 'chosen-file-failed-the-fixer-check', candidate: choice.path };
  return choice;
}
