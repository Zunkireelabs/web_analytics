// Sanity execution adapter — the CMS counterpart to the GitHub path.
//
// Same recommendation -> generator -> adapter -> validation -> human approval
// pipeline as everything else; only the final write differs. Discovery,
// scoring, qualification, tenant isolation, scheduling, pacing, the circuit
// breaker, retry and audit are all upstream of here and entirely unchanged.
// This file is deliberately small for that reason: if it needed to know about
// any of those, it would be the wrong shape.
//
// WHY THIS EXISTS: blog content on a Sanity-backed site has no file in the
// repo. The page component fetches it by GROQ at build time, so every
// file-and-marker implementer is inapplicable — not because blog SEO is a
// different KIND of problem, but purely because the bytes live behind an API
// instead of in git. resolveAdapter (implementers/lib/url-file-map.js) already
// routes per-URL-pattern, and adapters/registry.js already states an adapter
// "that writes to a non-GitHub target (e.g. a CMS API) just needs to return
// the same result shape". This is that.
//
// THE HUMAN GATE IS NOT OPTIONAL. apply() writes to Sanity's DRAFT document
// (`drafts.<id>`), never the published one. That is the deliberate analogue of
// pushing a branch rather than committing to main: the change is real,
// reviewable in Studio, and invisible to the public site until a person
// publishes it. Nothing in this file publishes. The one function that could
// (publishSanityDraft) is exported for a human-triggered route to call and is
// never reached from any scheduled path.
//
// url_file_map config shape (patterns[].adapters[actionType], or
// pages[url].adapters[actionType]):
//
//   {
//     "id": "sanity-document",
//     "projectId": "vd27cmpc",
//     "dataset": "production",
//     "apiVersion": "2026-02-10",       // optional
//     "documentType": "post",
//     "slugFromUrl": "^/blogs/([^/]+)/?$",  // capture group 1 = the slug
//     "studioUrl": "https://admizz.sanity.studio"  // optional, for the review link
//   }
//
// The token is NOT here — it is resolved per-site from
// sites.sanity_write_token_env_var (server/sanity/credentials.js), which fails
// closed rather than falling back to anything shared.

import { resolveAdapter } from '../lib/url-file-map.js';
import { sanityQuery, sanityMutate, draftId, publishedId, DEFAULT_API_VERSION } from '../../sanity/client.js';
import { resolveSanityToken, describeSanityCredentialGap } from '../../sanity/credentials.js';
import { safeMessage } from '../../lib/errors.js';

export const meta = {
  id: 'sanity-document',
  description: 'Writes SEO fields to a Sanity draft document for human review and publication, for pages whose content lives in Sanity rather than in the repo.',
};

// The generator output fields this adapter knows how to place, mapped to their
// real paths in the client's `seo` object (see the post schema's seo field).
// A generator producing anything not listed here is refused rather than
// guessed at — an unmapped field silently dropped is worse than an honest
// failure, because the draft would be marked applied with nothing written.
const FIELD_MAP = {
  metaTitle: 'seo.metaTitle',
  metaDescription: 'seo.metaDescription',
  canonicalUrl: 'seo.canonicalUrl',
  noIndex: 'seo.noIndex',
  ogImage: 'seo.ogImage',
};

// seo.ogImage is a Sanity `image`, not a string: a reference to an asset that
// already exists in the dataset, shaped
// {_type:'image', asset:{_type:'reference', _ref:'image-<hash>-<dims>-<ext>'}}.
// Writing a bare URL there would type-check nowhere and render as nothing —
// Studio would show an empty image field and the site's urlFor() would return
// undefined, so the change would look applied while doing nothing.
//
// Uploading a new asset is a different API (/assets/images/<dataset>) and a
// different kind of act: it puts a permanent binary into the client's dataset.
// This adapter deliberately does not do that. It accepts an ogImage only when
// the generator supplies a real asset reference, and refuses a URL with an
// explanation rather than writing something malformed.
function normalizeOgImage(value) {
  if (typeof value === 'object' && value?.asset?._ref) {
    return { ok: true, value: { _type: 'image', asset: { _type: 'reference', _ref: value.asset._ref } } };
  }
  if (typeof value === 'string' && value.startsWith('image-')) {
    return { ok: true, value: { _type: 'image', asset: { _type: 'reference', _ref: value } } };
  }
  return {
    ok: false,
    error: typeof value === 'string' && /^https?:\/\//.test(value)
      ? `ogImage was given the URL "${value}", but seo.ogImage is a Sanity image reference, not a URL. The asset must already exist in the dataset and be passed as its asset id (image-<hash>-<dims>-<ext>). This adapter does not upload assets.`
      : 'ogImage must be a Sanity asset reference (image-<hash>-<dims>-<ext>) or {asset:{_ref}}',
  };
}

// The client's own schema warns above these lengths (seo.ts). Enforced here as
// hard limits rather than warnings: there is no build step on this path to
// catch an over-long title, and a truncated <title> in a SERP is a real
// regression that would ship silently.
const MAX_LENGTHS = { 'seo.metaTitle': 70, 'seo.metaDescription': 160 };

// Read-back comparison. Scalars compare by value; an image compares by its
// asset reference, because Sanity echoes back a fuller object than the one
// written (it adds _key and may normalize the asset shape), so a strict !==
// on the object would report a mismatch on every successful image write and
// fail the apply that actually worked.
function valueMatches(actual, expected) {
  if (expected && typeof expected === 'object' && expected.asset?._ref) {
    return actual?.asset?._ref === expected.asset._ref;
  }
  return actual === expected;
}

function configError(page, detail) {
  return { ok: false, reason: 'sanity-config-invalid', error: `sanity-document adapter misconfigured for ${page}: ${detail}` };
}

function adapterConfig(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  if (!page) return { error: { ok: false, reason: 'draft-not-ready', error: 'Draft has no page URL' } };
  const config = resolveAdapter(site, page, draft.action_type);
  if (!config) return { error: { ok: false, reason: 'no-file-mapping', error: `No sanity-document adapter route configured for ${page} / ${draft.action_type}` } };
  for (const required of ['projectId', 'dataset', 'documentType', 'slugFromUrl']) {
    if (!config[required]) return { error: configError(page, `missing "${required}"`) };
  }
  return { config, page };
}

function slugFromUrl(config, page) {
  let match;
  try {
    match = new URL(page).pathname.match(new RegExp(config.slugFromUrl));
  } catch {
    match = String(page).match(new RegExp(config.slugFromUrl));
  }
  return match?.[1] || null;
}

// Translates a draft's generated content into {path: value} against the real
// schema. Returns an error result rather than a partial set — a draft that
// carries one recognised field and one unrecognised one is a contract
// mismatch, and applying half of it would leave no trace of the half dropped.
function buildFieldUpdates(draft) {
  const content = draft.content || {};
  const updates = {};
  const unmapped = [];
  for (const [key, value] of Object.entries(content)) {
    // Envelope keys every draft carries — not generator output.
    if (['page', 'appliedFiles', 'rationale', 'evidence', 'title'].includes(key)) continue;
    if (value == null) continue;
    const path = FIELD_MAP[key];
    if (!path) { unmapped.push(key); continue; }
    if (path === 'seo.ogImage') {
      const normalized = normalizeOgImage(value);
      if (!normalized.ok) return { error: { ok: false, reason: 'invalid-edit', error: normalized.error } };
      updates[path] = normalized.value;
      continue;
    }
    updates[path] = value;
  }
  if (unmapped.length) {
    return { error: { ok: false, reason: 'unsupported-field', error: `sanity-document has no mapping for generated field(s): ${unmapped.join(', ')}. Refusing rather than dropping them silently.` } };
  }
  if (!Object.keys(updates).length) {
    return { error: { ok: false, reason: 'draft-not-ready', error: 'Draft carries no field this adapter can write' } };
  }
  for (const [path, value] of Object.entries(updates)) {
    const max = MAX_LENGTHS[path];
    if (max && typeof value === 'string' && value.length > max) {
      return { error: { ok: false, reason: 'invalid-edit', error: `${path} is ${value.length} characters, over the ${max}-character limit the Sanity schema warns at` } };
    }
  }
  return { updates };
}

async function resolveTarget(site, draft) {
  const { config, page, error } = adapterConfig(site, draft);
  if (error) return { error };

  const gap = await describeSanityCredentialGap(site);
  if (gap) return { error: { ok: false, ...gap } };
  const token = await resolveSanityToken(site);

  const slug = slugFromUrl(config, page);
  if (!slug) return { error: configError(page, `slugFromUrl /${config.slugFromUrl}/ did not match this page's path`) };

  const clientConfig = { projectId: config.projectId, dataset: config.dataset, apiVersion: config.apiVersion || DEFAULT_API_VERSION, token };
  return { config, clientConfig, slug, page };
}

export async function apply(site, draft) {
  const resolved = await resolveTarget(site, draft);
  if (resolved.error) return resolved.error;
  const { config, clientConfig, slug, page } = resolved;

  const built = buildFieldUpdates(draft);
  if (built.error) return built.error;
  const { updates } = built;

  try {
    // Resolve the real document by slug. Never trust an id derived from the
    // URL — the slug is the only thing the site itself uses to find this
    // document, so it is the only thing that can be checked against.
    const doc = await sanityQuery(
      clientConfig,
      `*[_type == $type && slug.current == $slug][0]{_id, _type, "slug": slug.current}`,
      { type: config.documentType, slug },
    );
    if (!doc?._id) {
      return { ok: false, reason: 'file-not-found', error: `No published ${config.documentType} document with slug "${slug}" in Sanity dataset ${config.dataset}` };
    }
    if (doc._id.startsWith('drafts.')) {
      return { ok: false, reason: 'invalid-edit', error: `Slug "${slug}" resolves to an unpublished draft document; refusing to write until it has been published once.` };
    }

    const target = draftId(doc._id);
    // createIfNotExists first: if an editor has no draft open, this forks one
    // from the published document so the patch has something to apply to and
    // the published document is never the patch target. If a draft already
    // exists (an editor is mid-edit), createIfNotExists is a no-op and the
    // patch lands on THEIR draft — which is why the read-back below checks
    // only the fields this adapter set, and the human review step matters.
    await sanityMutate(clientConfig, [
      { createIfNotExists: { _id: target, _type: doc._type } },
      { patch: { id: target, set: updates } },
    ]);

    // Read back. The mutation response is the writer's own account of what it
    // did; this is what a subsequent reader actually sees. Same discipline as
    // the GitHub path re-reading a file rather than trusting a commit response.
    const readBack = await sanityQuery(clientConfig, `*[_id == $id][0]`, { id: target });
    if (!readBack) return { ok: false, reason: 'github-error', error: `Wrote ${target} but it could not be read back` };

    const mismatched = Object.entries(updates).filter(([path, expected]) => {
      const actual = path.split('.').reduce((node, key) => (node == null ? node : node[key]), readBack);
      return !valueMatches(actual, expected);
    });
    if (mismatched.length) {
      return { ok: false, reason: 'invalid-edit', error: `Read-back mismatch on ${mismatched.map(([p]) => p).join(', ')} — the write did not take effect as intended` };
    }

    return {
      ok: true,
      cmsDocumentId: target,
      cmsPublishedId: doc._id,
      cmsFields: Object.keys(updates),
      cmsReviewUrl: config.studioUrl ? `${String(config.studioUrl).replace(/\/$/, '')}/desk/${config.documentType};${publishedId(doc._id)}` : null,
      page,
    };
  } catch (err) {
    const { message } = safeMessage('sanity-document.apply', err, 'Sanity write failed');
    return { ok: false, reason: 'github-error', error: message };
  }
}

// The CMS analogue of opening a PR: the change is staged and reviewable, and
// this hands it to a human. It does NOT publish, and deliberately makes no
// Sanity call at all — apply() already wrote and verified the draft document,
// so there is nothing further to do to the CMS here. Publishing is
// publishSanityDraft below, reached only from an explicit human action.
export async function mergeToStage(site, draft) {
  const documentId = draft.cms_document_id || draft.content?.cmsDocumentId;
  if (!documentId) {
    return { ok: false, reason: 'draft-not-ready', error: 'No Sanity draft document recorded for this draft — apply() must run first' };
  }
  return { ok: true, cmsDocumentId: documentId, cmsReviewUrl: draft.cms_review_url || null, awaitingHumanPublish: true };
}

// HUMAN-TRIGGERED ONLY. Not exported through the adapter contract
// (registry.js validates meta/apply/mergeToStage and ignores anything else),
// not reachable from auto-remediation, the Monday ship cycle, the reconciler,
// or any other scheduled path. A route handler behind a real user action calls
// this; the scheduled system's responsibility ends at awaiting_publish.
//
// Publishing in Sanity is not an endpoint — it is moving the draft's content
// onto the published id and deleting the draft, which is what these two
// mutations do atomically in one transaction.
export async function publishSanityDraft(site, draft) {
  const resolved = await resolveTarget(site, draft);
  if (resolved.error) return resolved.error;
  const { clientConfig } = resolved;

  const target = draft.cms_document_id;
  if (!target) return { ok: false, reason: 'draft-not-ready', error: 'No Sanity draft document recorded for this draft' };
  const live = publishedId(target);

  try {
    const current = await sanityQuery(clientConfig, `*[_id == $id][0]`, { id: target });
    if (!current) return { ok: false, reason: 'file-not-found', error: `Sanity draft ${target} no longer exists — it may have been published or discarded in Studio already` };

    const { _id, _rev, _createdAt, _updatedAt, ...fields } = current;
    await sanityMutate(clientConfig, [
      { createOrReplace: { _id: live, ...fields } },
      { delete: { id: target } },
    ]);

    const readBack = await sanityQuery(clientConfig, `*[_id == $id][0]`, { id: live });
    if (!readBack) return { ok: false, reason: 'github-error', error: `Published ${live} but it could not be read back` };
    return { ok: true, cmsPublishedId: live, publishedAt: new Date().toISOString() };
  } catch (err) {
    const { message } = safeMessage('sanity-document.publishSanityDraft', err, 'Sanity publish failed');
    return { ok: false, reason: 'github-error', error: message };
  }
}

export const __testables = { buildFieldUpdates, slugFromUrl, normalizeOgImage, valueMatches, FIELD_MAP, MAX_LENGTHS };
