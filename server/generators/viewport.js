// Pure, deterministic generator — no LLM call. There's exactly one correct
// viewport value; the implementer (server/implementers/backend.js) inserts
// or replaces the <meta name="viewport"> tag in the shared layout template
// (server/implementers/lib/viewport-inject.js). Setting the WHOLE content
// value (not patching pieces of it) is what fixes all three real mobile-
// usability findings this can be recommended from — missing, misconfigured
// (no width=device-width), and zoom-blocking (user-scalable=no /
// maximum-scale<=1) — with the same one draft.

export const meta = {
  id: 'viewport',
  name: 'Viewport Meta Generator',
  description: 'Drafts the correct <meta name="viewport"> tag for the shared layout template.',
  recommendationTags: [],
};

const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1';

export async function generate() {
  return {
    content: { viewportContent: VIEWPORT_CONTENT },
    summary: `Set <meta name="viewport" content="${VIEWPORT_CONTENT}"> on the shared layout template.`,
  };
}
