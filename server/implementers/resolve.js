import { getImplementerForGenerator } from './registry.js';
import { getAdapter } from './adapters/registry.js';
import { resolveAdapter } from './lib/url-file-map.js';

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
export async function resolveImplementerForApply(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  const adapterConfig = resolveAdapter(site, page, draft.action_type);

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
