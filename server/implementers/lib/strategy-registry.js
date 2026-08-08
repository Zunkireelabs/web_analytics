import crypto from 'node:crypto';
import { query } from '../../db.js';
import { detectInsertionPoint, detectWithTrustedContainer } from './structural-detect.js';
import { resolveTemplateIdentity } from './template-identity.js';

// The learning layer of the universal insertion engine (see
// insertion-engine.js). Answers one question: "has a safe insertion
// strategy already been figured out for this file — or for the shared
// template it renders through — or does this need real detection right
// now." Three lookups, in order, each strictly cheaper/more-confident than
// the next:
//
//   1. TEMPLATE-IDENTITY hit: a different file already resolved successfully
//      on the same resolved templateIdentity (template-identity.js). This is
//      the actual "learn once, reuse for every page on that template"
//      mechanic — it's what lets a brand-new/thin page (too little of its
//      own content to earn structural confidence independently) inherit an
//      already-proven container immediately, via
//      structural-detect.js's detectWithTrustedContainer.
//   2. OWN-FILE cache hit: this exact file_path was already detected before
//      and its structural_signature hasn't drifted — reuse without
//      re-parsing.
//   3. Fresh detection: neither of the above — run the real detector chain,
//      and if it succeeds, persist a row so future lookups (both future
//      calls for THIS file, and any other page sharing its templateIdentity)
//      hit step 1 or 2 instead of repeating this work.
//
// A signature mismatch against a stored row (the live file's shape no
// longer matches what was learned — a template redesign) discards that row
// and re-detects, so drift never has to be manually invalidated.

function structuralSignature(detection) {
  return crypto.createHash('sha1')
    .update(`${detection.fileKind}::${detection.containerDescription || ''}`)
    .digest('hex');
}

async function getRow(siteId, filePath) {
  const { rows } = await query(
    'SELECT * FROM insertion_strategies WHERE site_id = $1 AND file_path = $2',
    [siteId, filePath]
  );
  return rows[0] || null;
}

async function getTemplateRow(siteId, templateIdentity, excludeFilePath) {
  const { rows } = await query(
    `SELECT * FROM insertion_strategies
     WHERE site_id = $1 AND template_identity = $2 AND file_path != $3 AND confidence = 'high'
     ORDER BY updated_at DESC LIMIT 1`,
    [siteId, templateIdentity, excludeFilePath]
  );
  return rows[0] || null;
}

async function upsertRow(siteId, filePath, templateIdentity, detection) {
  const signature = structuralSignature(detection);
  await query(
    `INSERT INTO insertion_strategies
       (site_id, file_path, template_identity, structural_signature, file_kind, container_description, confidence, last_validated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'high', now(), now())
     ON CONFLICT (site_id, file_path) DO UPDATE SET
       template_identity = EXCLUDED.template_identity,
       structural_signature = EXCLUDED.structural_signature,
       file_kind = EXCLUDED.file_kind,
       container_description = EXCLUDED.container_description,
       confidence = 'high',
       last_validated_at = now(),
       updated_at = now()`,
    [siteId, filePath, templateIdentity, signature, detection.fileKind, detection.containerDescription || null]
  );
}

// Returns the same shape `detectInsertionPoint` returns
// (`{ok, fileKind, insertBeforeOffset, containerDescription}` or
// `{ok:false, reason, error}`), plus `source` (`'template-identity'` |
// `'file-cache'` | `'fresh'`) so callers/tests can tell which path answered.
export async function getOrDetectStrategy(site, filePath, fileContent) {
  const templateIdentity = resolveTemplateIdentity(fileContent, filePath);

  if (templateIdentity) {
    const templateRow = await getTemplateRow(site.id, templateIdentity, filePath);
    if (templateRow) {
      const trusted = detectWithTrustedContainer(fileContent, filePath, templateRow.file_kind, templateRow.container_description);
      if (trusted.ok) {
        await upsertRow(site.id, filePath, templateIdentity, trusted);
        return { ...trusted, source: 'template-identity' };
      }
      // The trusted container genuinely isn't present on this file — this
      // page has diverged from the template it was supposed to share. Fall
      // through to independent detection rather than trusting a stale match.
    }
  }

  const existing = await getRow(site.id, filePath);
  if (existing) {
    // Own-file cache is only trustworthy if the live file's shape still
    // matches what was learned. Re-detecting to check the signature is the
    // same cost as just re-detecting outright for JSX/HTML (both are a
    // single parse pass), so this doesn't try to avoid that parse — the
    // real savings this cache path provides is skipping the
    // template-identity re-resolution/DB round trip on every call, and
    // giving a stable audit trail of "this row hasn't needed to change."
    const fresh = detectInsertionPoint(fileContent, filePath);
    if (fresh.ok && structuralSignature(fresh) === existing.structural_signature) {
      return { ...fresh, source: 'file-cache' };
    }
    if (fresh.ok) {
      // Signature drift — template was redesigned since this row was
      // learned. Re-learn automatically, no manual cache-busting step.
      await upsertRow(site.id, filePath, templateIdentity, fresh);
      return { ...fresh, source: 'fresh' };
    }
    return fresh; // detection now fails outright — report honestly, leave the stale row for now (nothing else references file_path incorrectly since it's keyed by this exact file)
  }

  const fresh = detectInsertionPoint(fileContent, filePath);
  if (fresh.ok) await upsertRow(site.id, filePath, templateIdentity, fresh);
  return { ...fresh, source: 'fresh' };
}
