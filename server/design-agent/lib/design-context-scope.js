// Carries the VALIDATED design context from the place that validates it
// (routes/action-center.js's generateDraft) to the code that uses it (the
// generators' composer calls and the page-template builder).
//
// Why this exists. Generators fetch the site row themselves
// (`getSiteById(siteId)` inside generate()), so a context attached to
// generateDraft's own site snapshot never reaches them. Passing the site into
// every generator would change ~20 generators; an AsyncLocalStorage scope
// reaches whatever the generator calls — composer, builder, renderers —
// without touching their signatures, and cannot leak between concurrent drafts
// because each draft runs inside its own scope.
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

const pathKey = (url) => {
  try {
    const u = new URL(url, 'https://placeholder.invalid');
    return (u.pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '') || '/') + u.search;
  } catch { return null; }
};

/** Run `fn` with `contexts` (design contexts, each with a pagePath) visible to everything it awaits. */
export function runWithDesignContexts(contexts, fn) {
  const byPath = new Map();
  for (const c of contexts || []) if (c?.pagePath) byPath.set(c.pagePath, c);
  return store.run({ byPath }, fn);
}

export function scopedDesignContextFor(pageUrl) {
  const scope = store.getStore();
  const key = pageUrl ? pathKey(pageUrl) : null;
  return (scope && key && scope.byPath.get(key)) || null;
}
