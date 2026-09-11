import { getImplementerForGenerator } from './registry.js';
import { getAdapter } from './adapters/registry.js';
import { resolveAdapter } from './lib/url-file-map.js';
import { resolveFaqRenderMode } from './lib/faq-render-mode.js';
import { CONFIDENCE_THRESHOLD } from './lib/render-inspector.js';

// Which implementer actually handles a draft's apply()/mergeToStage() is no
// longer fixed per action type — a page's adapter config (url_file_map.pages
// [url].adapters[actionType], see lib/url-file-map.js's resolveAdapter) can
// override it to a named adapter instead of the default backend/frontend
// implementer. Both resolvers here return the same { implementer,
// implementerId } shape (or { error }) so routes/action-center.js's
// push-branch/merge-to-stage/approve handlers don't need to know which kind
// of implementer they got — adapters satisfy the exact same
// { apply(site, draft), mergeToStage(site, draft) } contract as
// backend.js/frontend.js. (Render mode — visible vs. schema-only — is a
// separate, unrelated decision made inside backend.js itself via live page
// inspection, not part of implementer routing at all.)

// approve -> push-branch: resolves fresh from the page's current adapter
// config. `implementerId` is what gets persisted (markDraftBranchPushed) so
// the merge step below can later reuse the SAME implementer/adapter rather
// than re-deriving it — a page's adapter config could in principle change
// between push and merge, and the merge must apply to whatever was actually
// pushed, not whatever config says today.
//
// resolveAdapter returns a config OBJECT (at minimum `{id}`, plus whatever
// per-adapter parameters that adapter needs — e.g. dataFile/idField/
// itemsField/format for data-array-content.js), not a bare id string — an
// adapter re-resolves its own full config itself (calling resolveAdapter
// again with the same site/page/actionType) inside apply()/preview()/
// mergeToStage() rather than having it threaded through here, so this
// module only ever needs the `id` for adapter lookup + persistence.
//
// 'faq' is the one action type where an adapter config doesn't fully decide
// the writer on its own: a page wired to a data-array-content adapter is
// only actually routed there once the real render-mode decision (see
// lib/render-inspector.js via lib/faq-render-mode.js) comes out 'visible'.
// 'schema-only' always goes through the default marker-merge implementer
// instead — publishing just a JSON-LD fragment into the page's own template
// marker is a marker-merge concern regardless of which mechanism would have
// written the VISIBLE representation, and it keeps every adapter's own
// apply/mergeToStage/rollback honestly scoped to the one file format (its
// own dataFile) it actually knows how to snapshot and restore, rather than
// retrofitting HTML-marker rollback into a JSON/JS-data writer.
// `renderModeOverride` is a human's already-confirmed choice re-entering
// after a prior 'render-mode-uncertain' stop (see routes/action-center.js) —
// when present, the fresh inspection below is skipped entirely, same as
// backend.js's own computeMarkerMerge, so a human's answer is never
// re-litigated into the same uncertain stop on retry.
export async function resolveImplementerForApply(site, draft, renderModeOverride) {
  const page = draft.content?.page || draft.input?.page;

  // 'location-service-bootstrap' (agents/lib/location-service-gap.js) always
  // targets the data-array-content adapter by construction — it only ever
  // exists to create the empty services.<id> container that adapter's own
  // computeChange writes into for a real generator's fields afterward. It
  // deliberately carries its OWN copy of the base adapter config
  // (draft.content.baseConfig, captured from whichever real generator's
  // config already resolved for this page — see recommendation-gates.js)
  // rather than requiring every tenant to also register a url_file_map
  // adapters['location-service-bootstrap'] entry alongside their real one:
  // that would be a second, redundant onboarding step for something this
  // draft type can only ever mean.
  if (draft.action_type === 'location-service-bootstrap') {
    const adapter = await getAdapter('data-array-content');
    if (!adapter) return { error: 'No adapter registered for "data-array-content" — location-service-bootstrap cannot apply.' };
    return { implementer: adapter, implementerId: 'adapter:data-array-content' };
  }

  const adapterConfig = resolveAdapter(site, page, draft.action_type);

  if (adapterConfig && draft.action_type === 'faq') {
    let mode = renderModeOverride || null;
    if (!mode) {
      const inspection = await resolveFaqRenderMode(site, draft);
      if (!inspection.mode || inspection.confidence < CONFIDENCE_THRESHOLD) {
        return {
          error: inspection.reason, reason: 'render-mode-uncertain',
          confidence: inspection.confidence, suggestedMode: inspection.mode,
        };
      }
      mode = inspection.mode;
    }
    if (mode === 'schema-only') {
      const implementer = await getImplementerForGenerator(draft.action_type);
      if (!implementer) return { error: `No implementer wired for "${draft.action_type}" yet` };
      return { implementer, implementerId: implementer.meta.id };
    }
    // mode === 'visible' (auto-decided or human-confirmed) falls through to
    // the adapter below, same as today.
  }

  if (adapterConfig) {
    const adapter = await getAdapter(adapterConfig.id);
    if (!adapter) return { error: `No adapter registered for "${adapterConfig.id}" — add one at server/implementers/adapters/${adapterConfig.id}.js` };
    return { implementer: adapter, implementerId: `adapter:${adapter.meta.id}` };
  }

  const implementer = await getImplementerForGenerator(draft.action_type);
  if (!implementer) return { error: `No implementer wired for "${draft.action_type}" yet` };
  return { implementer, implementerId: implementer.meta.id };
}

// branch_pushed -> merge-to-stage: reuses the implementer_id persisted at
// push time (see above) instead of re-resolving from the page's current
// adapter config, so a real branch someone reviews always merges via the
// same implementer/adapter that actually pushed it.
export async function resolveImplementerForMerge(draft) {
  const id = draft.implementer_id || '';
  if (id.startsWith('adapter:')) {
    const adapterId = id.slice('adapter:'.length);
    const adapter = await getAdapter(adapterId);
    if (!adapter) return { error: `Adapter "${adapterId}" (used to push this branch) is no longer registered.` };
    return { implementer: adapter };
  }

  const implementer = await getImplementerForGenerator(draft.action_type);
  if (!implementer) return { error: `No implementer wired for "${draft.action_type}" yet` };
  return { implementer };
}
