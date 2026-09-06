import { analyzePageUrl } from './page-content.js';

// One cache per runOrchestration() call, shared across every agent in that
// run — dedupes redundant live fetches when two agents' candidate pools
// overlap (confirmed real: content-gap.js and ai-visibility.js both draw
// from the same GSC-top-pages + page_inventory pool via
// selectCandidatePages, and technical-seo.js/opportunity.js touch
// overlapping GSC pages too). Stores the in-flight Promise, not just the
// resolved value, so two agents racing to fetch the same URL in the same
// tick coalesce into one real network request instead of two — same
// pattern opportunity.js already used locally (its own pageAnalysisCache),
// just promoted to be shared across agents instead of private to one.
//
// Deliberately a plain function, not an object/Map, on the returned value —
// runner.js persists the agent-run `input` object verbatim via
// JSON.stringify, and a bare function value is automatically omitted from
// that serialization (unlike a Map, which would flatten to "{}"), so
// threading this through orchestrator.js -> runAgent -> input.pageCache
// needs no extra stripping step to keep agent_runs.input clean.
export function createPageCache() {
  const cache = new Map();
  return function getOrFetch(url) {
    if (cache.has(url)) return cache.get(url);
    const promise = analyzePageUrl(url);
    cache.set(url, promise);
    return promise;
  };
}
