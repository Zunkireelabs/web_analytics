// The Content page and the Action Center are two views of one drafts board: Content is the
// writing the agent drafts (blog posts, landing pages, translations, expanded copy), the Action
// Center is every fix. Keep this list in step with server/lib/draft-scope.js, which the batch
// "approve all" uses to touch only the page's own drafts.
export const CONTENT_GENERATOR_IDS = ['blog-outline', 'landing-page', 'translation', 'expand-content', 'blog-image'];

// scope: 'content' | 'fixes' | undefined (everything)
export function inDraftScope(generatorId, scope) {
  if (scope === 'content') return CONTENT_GENERATOR_IDS.includes(generatorId);
  if (scope === 'fixes') return !CONTENT_GENERATOR_IDS.includes(generatorId);
  return true;
}
