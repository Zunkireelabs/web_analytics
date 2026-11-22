// Classifies what a generator's change is allowed to touch when its target
// turns out to be a SHARED template (page-resolution.js's isSharedTemplate).
//
// Most content is page-specific by nature: an FAQ, a meta title, a byline —
// each answers "what should THIS page say", and writing it into a template
// that renders many pages would apply it to all of them. A few generators are
// the opposite by design: a security header, an html-lang attribute, an
// analytics snippet belong on every page and their one real instance already
// lives in a shared layout (siteRoot.layoutTemplate) — that is not a mistake
// to guard against, it is the correct target.
//
// A third case exists in principle — a site that genuinely wants one action
// type applied to every member of a route family (e.g. an author byline on
// every glossary term) — but that is a content decision only a human can
// make for a specific site, never something this pipeline infers from a
// generator's id. It requires an explicit per-site opt-in in url_file_map;
// absent that, every generator not in GLOBAL_BY_DESIGN is page-specific.

// Generators whose one real target is a site-level file
// (siteRoot.layoutTemplate, siteRoot.llmsTxt, etc.), not a specific page —
// see backend.js's isSitewideInstall/computeMarkerMerge and the siteRoot.*
// resolvers in url-file-map.js. These are exempt from the shared-template
// backstop below because their target being "shared" IS the design, not an
// accident of resolution.
const GLOBAL_BY_DESIGN = new Set([
  'analytics-install', 'security-headers', 'html-lang', 'llms-txt', 'robots-fix', 'robots-bootstrap', 'sitemap',
]);

// Pre-draft counterpart to the apply-time shared-template backstop (checkSharedTemplateWrite). A page-specific action whose page resolves
// to a framework DYNAMIC-ROUTE template (a path segment like [slug] / [course], rendered for many pages) with no adapter and no explicit
// family opt-in can never be applied safely, so it must be reported as blocked BEFORE a draft is generated — otherwise every refresh
// generates a draft, fails at apply, and is retried (the "failed / retry / blocked" churn). Returns the human-readable reason, or null.
export function sharedTemplateTargetBlock(site, pageUrl, generatorId, { file, adapterConfig = null } = {}) {
  if (!file || adapterConfig) return null;
  if (actionScopeFor(generatorId) !== 'page-specific') return null;
  if (!/(^|\/)\[[^\]/]+\](\/|\.|$)/.test(file)) return null;
  if (familyWriteAllowed(site, pageUrl, generatorId)) return null;
  return `This page resolves to ${file}, a shared template that renders many pages, so a "${generatorId}" change written there would apply to all of them. The page's own content lives elsewhere — correct this page's url_file_map entry (or configure an adapter for it) and this clears automatically.`;
}

// Body-markup edits (anchor/replace on rendered HTML) need real markup in the SOURCE file. A page whose file only hands a data object to a
// shared component (`<CountryPageTemplate data={d} />`, `<GeneratedBlogPost {...post} />`) has none: the anchors a generator copies from
// the live HTML do not exist in the file, so every attempt dies with "the page changed after this fix was written". Detect that shape
// up front and say so, instead of generating, failing and retrying.
export const BODY_MARKUP_ACTION_TYPES = new Set(['content-integrity-repair', 'duplicate-id-fix', 'internal-links', 'expand-content', 'qa-content', 'refresh-content']);
export function templateDrivenBodyBlock(fileContent, generatorId, file) {
  if (!BODY_MARKUP_ACTION_TYPES.has(generatorId) || typeof fileContent !== 'string') return null;
  const handsDataToComponent = /<[A-Z][\w.]*\s[^>]*(\bdata=\{\w+\}|\{\.\.\.\w+\})/.test(fileContent);
  const ownMarkup = /<(h[1-6]|p|section|article|ul|ol|table|div)[\s>]/.test(fileContent);
  if (!handsDataToComponent || ownMarkup) return null;
  return `${file} contains no page markup of its own — it hands a data object to a shared component, so "${generatorId}" edits (which match HTML in the file) cannot be located. The content lives in that data object or in a content file; this needs a writer for that data, not a markup edit.`;
}

export function actionScopeFor(generatorId) {
  return GLOBAL_BY_DESIGN.has(generatorId) ? 'global-by-design' : 'page-specific';
}

// A site's explicit opt-in for "yes, apply this action type to every member
// of this route family" — e.g. a url_file_map.patterns[] entry matching
// /glossary/* carrying `familyWrites: ['expand-content']`. Never inferred:
// the shared-template backstop in backend.js only skips a page-specific
// refusal when this returns true for the exact (site, page, actionType) in
// play. Matches url_file_map.patterns[] the same way url-file-map.js's own
// (module-private) getMatchingPattern does — duplicated narrowly here rather
// than exported from there, since this is a distinct question ("did the site
// opt this family INTO shared writes") from what that module answers
// ("what file/marker config applies to this page").
export function familyWriteAllowed(site, pageUrl, generatorId) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = String(pageUrl || ''); }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  for (const pattern of site?.url_file_map?.patterns || []) {
    if (!pattern.match || !pattern.familyWrites?.includes(generatorId)) continue;
    const re = new RegExp(pattern.match);
    if (re.test(normalized) || re.test(path)) return true;
  }
  return false;
}

// The actual backstop decision, extracted out of backend.js's
// computeMarkerMerge so it is unit-testable on its own: backend.js's own
// import graph pulls in an LLM client chain that fails to instantiate under
// node:test's module mocking (the same issue analyst-sync.test.js documents
// for routes/action-center.js), so nothing that imports backend.js can be
// exercised that way. This function has none of that baggage.
//
// Returns a refusal object ({ reason: 'shared-template-write', error }) when
// filePath is a discovered pagination route's own generator template AND the
// action type is page-specific AND the site has not opted this exact
// (family, actionType) into shared writes. Returns null (allowed) in every
// other case — including when isSitewideInstall is true, which callers
// should check before calling this at all (a global-by-design target IS
// meant to be shared, so there's nothing here for it to ask).
export async function checkSharedTemplateWrite(site, pageUrl, generatorId, filePath, { discoverRoutes, matchRoute } = {}) {
  if (actionScopeFor(generatorId) !== 'page-specific') return null;
  if (familyWriteAllowed(site, pageUrl, generatorId)) return null;

  const routes = await discoverRoutes(site).catch(() => []);
  const route = matchRoute(pageUrl, routes);
  if (!route || route.template !== filePath) return null;

  return {
    reason: 'shared-template-write',
    error: `${filePath} is the shared generator for every ${route.routePrefix}/* page (real pagination front matter), not this page's own file. A page-specific "${generatorId}" change here would apply to every page in the family at once. Fix ${pageUrl}'s content in ${route.dataFile || 'its data source'} instead, or configure this route's url_file_map pattern with familyWrites: ["${generatorId}"] if this really should apply sitewide.`,
  };
}
