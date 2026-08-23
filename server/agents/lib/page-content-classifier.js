import { getPageContentType, upsertPageContentType } from '../../store/page-content-classification.js';

// The third applicability layer for cross-client learned repair (alongside
// site-fingerprint.js's technical/structural tokens): what KIND of page is
// this. A repair proven technically and structurally compatible can still be
// wrong to reuse if the target page is a different kind of page than the one
// it was proven on — a FAQ-tone fix learned on a blog page has no business
// running unattended on a product page.
//
// Deliberately a small closed vocabulary, not embeddings or free text — same
// "inspectable, not a cosine distance" discipline site-fingerprint.js states
// for itself. A wrong classification is debuggable ("content-type:blog !=
// content-type:product"); a wrong cosine distance is not.
export const CONTENT_TYPES = ['product', 'service', 'blog', 'landing', 'faq', 'category', 'legal', 'other'];

// Below this, a classification is treated as UNCERTAIN, not trusted — the
// caller must then treat the page as unclassified (no token pushed), which
// site-fingerprint.js's required-token refusal already turns into a refusal
// rather than an assumed match. This is what makes "for missing/uncertain
// context, do not assume compatibility" hold without a separate code path.
const MIN_CONFIDENCE = 0.6;

// Deterministic, free, no fetch required — checked before ever spending an
// LLM call. Mirrors the path-hint APPROACH page-content.js's inferSchemaType
// already uses for a related but distinct purpose (which schema.org @type to
// recommend adding) — not reused directly, because that function's vocabulary
// (schema.org types) and this one's (the 8-value CONTENT_TYPES set above)
// serve different consumers and must be free to diverge.
const PATH_HINTS = [
  [/\/(products?|shop|store|item)\//i, 'product'],
  [/\/(services?|solutions?)\//i, 'service'],
  [/\/(blog|articles?|news|guides?)\//i, 'blog'],
  [/\/(faq|faqs)(\/|$)/i, 'faq'],
  [/\/(category|categories|collections?)\//i, 'category'],
  [/\/(privacy|terms|legal|cookie-policy)(\/|$)/i, 'legal'],
];

function classifyFromPath(pageUrl) {
  let path = '';
  try { path = new URL(pageUrl).pathname; } catch { return null; }
  for (const [re, contentType] of PATH_HINTS) {
    if (re.test(path)) return { contentType, confidence: 0.95, classifiedBy: 'path-heuristic' };
  }
  // A bare root path is a landing/home page far more often than anything
  // else — same reasoning inferSchemaType applies to 'Organization'.
  if (path === '/' || path === '') return { contentType: 'landing', confidence: 0.9, classifiedBy: 'path-heuristic' };
  return null; // genuinely ambiguous from the path alone — LLM fallback decides
}

const SYSTEM = `Classify a website page's content type from its URL alone. Respond with ONLY a JSON object: {"contentType": one of [${CONTENT_TYPES.join(', ')}], "confidence": a number from 0 to 1}. Use "other" with low confidence if you genuinely cannot tell from the URL.`;

async function classifyFromLlm(pageUrl, { siteId } = {}) {
  // Dynamic import, not a top-level one — llm.js pulls in the OpenAI/
  // Anthropic SDKs, and learned-repair.js (this module's real caller) is a
  // small, widely-imported module (code-self-repair.js, fix-verification.js,
  // routes/action-center.js...) that must NOT gain a heavy, eager SDK
  // dependency just because ONE of its many callers occasionally needs an
  // LLM fallback. Same reasoning learned-repair.js already applies to its
  // own auto-remediation.js dependency (see its lazy `await import()`).
  const { callLLMForJson } = await import('../../llm.js');
  const result = await callLLMForJson(SYSTEM, `URL: ${pageUrl}`, { maxTokens: 60, generatorId: 'page-content-classifier', siteId });
  if (!CONTENT_TYPES.includes(result?.contentType)) return null; // never persist a value outside the closed vocabulary
  const confidence = Number(result.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { contentType: result.contentType, confidence, classifiedBy: 'llm' };
}

// Returns { contentType, confidence } or null — null on ANY failure
// (LLM error, invalid/out-of-vocabulary response, low confidence). Never
// throws: a classification failure must fail OPEN to "unclassified", which
// the caller then treats as a missing required token, not a crash and not
// an assumed match.
//
// Cached in page_content_classification (migration 122) — a hit is a plain
// DB read, no LLM call, so this only ever costs real money on a page's
// FIRST evaluation as a learned-repair candidate (see learned-repair.js /
// fix-verification.js — both only call this for items that already cleared
// the cheaper gates).
export async function getOrClassifyPageContentType(siteId, pageUrl) {
  if (!siteId || !pageUrl) return null;

  try {
    const cached = await getPageContentType(siteId, pageUrl);
    if (cached && cached.confidence >= MIN_CONFIDENCE) return cached;
  } catch (err) {
    console.error(`[page-content-classifier] site ${siteId} cache read failed for ${pageUrl}:`, err.message);
    // Fall through and try to classify live — a broken cache read must not
    // permanently block this page from ever being classified.
  }

  let result;
  try {
    result = classifyFromPath(pageUrl) || await classifyFromLlm(pageUrl, { siteId });
  } catch (err) {
    console.error(`[page-content-classifier] site ${siteId} classification failed for ${pageUrl}:`, err.message);
    return null;
  }
  if (!result || result.confidence < MIN_CONFIDENCE) return null;

  try {
    return await upsertPageContentType({ siteId, page: pageUrl, ...result });
  } catch (err) {
    // Still usable for THIS decision even if the write failed — it just
    // won't be cached, so the next candidate on this page re-classifies.
    console.error(`[page-content-classifier] site ${siteId} could not persist classification for ${pageUrl}:`, err.message);
    return result;
  }
}
