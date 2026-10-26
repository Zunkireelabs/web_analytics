// The Content page and the Action Center are two views of one drafts board:
// Content is the writing the agent drafts (blog posts, landing pages,
// translations, expanded copy), the Action Center is every fix. A page's batch
// buttons must only ever touch its own side.
export const CONTENT_GENERATOR_IDS = ['blog-outline', 'landing-page', 'translation', 'expand-content', 'blog-image'];

// scope: 'content' | 'fixes' | undefined (everything, exactly as before there were scopes)
export function inDraftScope(actionType, scope) {
  if (scope === 'content') return CONTENT_GENERATOR_IDS.includes(actionType);
  if (scope === 'fixes') return !CONTENT_GENERATOR_IDS.includes(actionType);
  return true;
}
