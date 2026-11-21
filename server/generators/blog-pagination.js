import { getSiteById } from '../store/read.js';
import { getFileContent, getRepoTree, defaultBranchName } from '../github/client.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';
import { detectTechnology } from '../discovery/detect-technology.js';
import { RECIPES, recipeSupported, supportedFrameworks, pagerClassesFromDesignProfile } from './lib/pagination/recipes.js';
import { DEFAULT_PAGE_SIZE } from './lib/pagination/eleventy-recipe.js';

// Drafts the change that splits a long blog listing into numbered pages, using the recipe for the site's framework. Deterministic: no LLM,
// nothing invented. The draft carries the listing file as it is now (`before`) and as it would be (`after`), and the implementer
// (implementers/lib/blog-pagination-inject.js) writes it only if the file is still exactly `before`.
//
// It REFUSES, with a plain reason, whenever it cannot do this safely: a framework with no recipe, a listing it cannot find in the repo, or a
// template its recipe does not handle (hand-written cards, JSON front matter, a title edited in place by the setup automation, ...). A refusal
// is the right outcome there, not a failure: that listing needs a person.

export const meta = {
  id: 'blog-pagination',
  name: 'Blog Pagination Generator',
  description: 'Splits a blog listing that has grown too long into numbered pages, using the site\'s own framework and design. Draft for review, never auto-shipped.',
  recommendationTags: [],
};

const refuse = (reason, message) => Object.assign(new Error(message), { status: 400, userFacing: true, refusal: true, reason });

export async function generate({ siteId, params }, deps = {}) {
  const { loadSite = getSiteById, readFile = getFileContent, readTree = getRepoTree, detect = detectTechnology } = deps;
  const listing = params?.listing;
  if (!listing) throw Object.assign(new Error('listing is required'), { status: 400 });
  const site = await loadSite(siteId);
  if (!site?.repo_owner || !site?.repo_name) throw refuse('no-repo', 'This site has no repository connected, so there is no listing template to change.');

  const sourcePath = resolveFile(site, listing);
  if (!sourcePath) throw refuse('no-file-mapping', `No source file is mapped for ${listing}, so the listing template cannot be found. Map it with connect-repo first.`);
  const ref = defaultBranchName(site);
  const file = await readFile(site, sourcePath, ref);
  if (!file) throw refuse('file-not-found', `${sourcePath} does not exist on branch "${ref}": the mapping for ${listing} looks wrong.`);

  // The framework comes from the repository itself (config files and dependencies), never from a guess.
  const tree = await readTree(site, ref);
  const pkg = tree.files.includes('package.json') ? (await readFile(site, 'package.json', ref))?.content : null;
  const detected = detect({ files: tree.files, packageJsonRaw: pkg });
  const framework = detected.framework?.id || null;
  if (!framework || detected.framework?.ambiguous || detected.framework?.confidence?.level === 'low') {
    throw refuse('framework-unclear', `The framework of this repository could not be identified with confidence${framework ? ` (best guess: ${framework})` : ''}, so no pagination recipe was chosen.`);
  }
  if (!recipeSupported(framework)) {
    throw refuse('no-recipe', `There is no pagination recipe for ${detected.framework.name || framework} yet (supported: ${supportedFrameworks().join(', ')}). The listing needs to be paginated by hand.`);
  }

  const basePath = new URL(listing).pathname;
  const { buttonClass, currentClass } = pagerClassesFromDesignProfile(site.url_file_map?.siteRoot?.designProfile);
  // What a recipe may need to know about the repository beyond the listing file: where it is, which files exist (so it never creates one
  // that is already there), and how the framework is configured (Astro's trailingSlash decides the shape of the pager's links).
  const configPath = tree.files.find((f) => /^astro\.config\.(mjs|js|ts|cjs)$/.test(f));
  const configText = framework === 'astro' && configPath ? (await readFile(site, configPath, ref))?.content || '' : '';
  const astroTrailing = /trailingSlash\s*:\s*['"](always|never|ignore)['"]/.exec(configText)?.[1] || 'ignore';
  const nextConfigPath = tree.files.find((f) => /^next\.config\.(mjs|js|ts|cjs)$/.test(f));
  const nextConfigText = framework === 'nextjs' && nextConfigPath ? (await readFile(site, nextConfigPath, ref))?.content || '' : '';
  const nextMajor = Number(/"next"\s*:\s*"[\^~>=\s]*(\d+)/.exec(pkg || '')?.[1]) || 15;
  const plan = RECIPES[framework].plan({
    source: file.content, sourcePath, basePath, pageSize: params?.pageSize || DEFAULT_PAGE_SIZE, buttonClass, currentClass,
    trailingSlash: framework === 'nextjs' ? /trailingSlash\s*:\s*true/.test(nextConfigText) : astroTrailing, nextMajor, existingFiles: tree.files,
  });
  if (!plan.ok) throw refuse(plan.reason, plan.error);

  return {
    content: {
      listing, framework, pageSize: params?.pageSize || DEFAULT_PAGE_SIZE,
      files: [{ path: sourcePath, before: file.content, after: plan.after }, ...(plan.extraFiles || []).map((f) => ({ path: f.path, before: null, after: f.after }))],
      notes: plan.notes,
    },
    summary: `Paginate ${listing} (${framework}, ${params?.pageSize || DEFAULT_PAGE_SIZE} posts per page): ${plan.notes[0]}`,
  };
}
