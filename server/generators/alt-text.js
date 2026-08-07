import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';

// 'manual' risk tier (risk-tiers.js) — deliberately, not an oversight.
// Unlike JSON-LD (marker-merge.js) or array-content (data-array-content.js),
// there's no implementer capability yet to splice alt="" back into an
// arbitrary <img> tag inside a target repo's own templates, so this
// generator's draft is applied by a human today. Still worth drafting and
// auto-routing to (page-content.js's GAP_TYPE_TO_GENERATOR) rather than
// leaving the gap unreachable from the manual Generate/Submit/Approve UI.
export const meta = {
  id: 'alt-text',
  name: 'Image Alt Text Generator',
  description: 'Drafts real, grounded alt text for images missing it, using each image\'s filename and real nearby page text — never guesses unseen visual detail.',
  recommendationTags: ['Missing alt text'],
};

const SYSTEM = 'You are an accessibility specialist. For each image given below (its filename and, if available, real nearby page ' +
  'text), draft concise, honest alt text (under 125 characters each). Ground it ONLY in the filename and nearby text given — never ' +
  'invent specific visual details you cannot actually know (an exact color, an exact person, an exact brand) unless the filename or ' +
  'nearby text actually says so. If the filename and nearby text give no real clue what the image shows, write a short, honest, ' +
  'generic description of its likely role instead (e.g. "Decorative image accompanying this section") rather than fabricating ' +
  'specifics. Respond with ONLY a JSON array of strings, in the exact same order as the images given: ["alt text 1", "alt text 2", ...]';

// params: { page: string }
export async function generate({ siteId, params }) {
  const { page } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });

  const images = fetched.analysis.imagesMissingAlt || [];
  if (!images.length) {
    throw Object.assign(new Error('No images missing alt text were found on this page.'), { status: 400, userFacing: true });
  }

  const user = images.map((img, i) => {
    const filename = (img.src.split('/').pop() || img.src).split('?')[0];
    return `${i + 1}. filename: "${filename}"${img.nearbyText ? `, nearby text: "${img.nearbyText.slice(0, 200)}"` : ''}`;
  }).join('\n');

  let altTexts;
  try {
    altTexts = await callLLMForJson(SYSTEM, user, { maxTokens: 500, generatorId: meta.id, siteId });
    if (!Array.isArray(altTexts)) throw new Error('not an array');
  } catch {
    throw Object.assign(new Error('Alt text generation failed: model did not return valid JSON'), { status: 400 });
  }

  const items = images
    .map((img, i) => ({ src: img.src, alt: (altTexts[i] || '').toString().trim() }))
    .filter((item) => item.alt);

  const content = { page, items };
  return { content, summary: `${items.length} alt text draft(s) for ${page}` };
}
