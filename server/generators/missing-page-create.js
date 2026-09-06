import { getSiteById } from '../store/read.js';
import { callLLMForJson } from '../llm.js';
import { analyzePageUrl, hasSufficientGroundingContent } from '../agents/lib/page-content.js';

// Writes the page a dead internal link was already pointing at, in the shape
// the site's existing sibling pages already use.
//
// The counterpart to broken-link-fix.js, not a replacement for it. That
// generator remains correct whenever a dead URL has nothing to model itself
// on; this one only ever runs after dead-link-intent.js has confirmed the
// site already has real sibling pages under the same path prefix. Those
// siblings are the whole justification: one of them is fetched and its real
// section structure becomes the outline this page must follow, so the result
// reads like the section it joins instead of like generic generated copy
// dropped into an unfamiliar template.
//
// The page is always written at the dead URL's OWN slug
// (resolveMissingPageTarget in implementers/lib/url-file-map.js). Writing it
// anywhere else would leave the original link exactly as broken.
export const meta = {
  id: 'missing-page-create',
  name: 'Missing Page Generator',
  description: 'Writes the page a dead internal link points at, following the structure of that section\'s existing pages.',
  recommendationTags: [],
};

// Below this a "page" is a stub — worse than the dead link it replaces,
// because a thin page is indexable and permanent where a 404 at least reads
// as an honest absence. Same "never publish a stub" rule as blog-outline.js.
const MIN_TOTAL_WORDS = 500;
const MAX_EXPAND_ATTEMPTS = 2;
const GROUNDING_EXCERPT_CHARS = 3000;
// One sibling is fetched as the structural model, not all of them — the
// prompt needs a shape to copy, and more samples would crowd out the real
// grounding text without making the shape any clearer.
const STRUCTURE_MODEL_LIMIT = 3;

function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function totalWords(sections) {
  return sections.reduce((sum, s) => sum + wordCount(s?.body), 0);
}

// The first sibling that actually fetches and has real content — siblings
// come from page_inventory and any individual one may since have gone stale.
async function fetchStructureModel(siblings) {
  for (const sibling of siblings.slice(0, STRUCTURE_MODEL_LIMIT)) {
    const fetched = await analyzePageUrl(sibling).catch(() => ({ ok: false }));
    if (!fetched.ok || !hasSufficientGroundingContent(fetched.analysis)) continue;
    return {
      url: sibling,
      headings: (fetched.analysis.headingOutline || []).map((h) => `${'#'.repeat(h.level)} ${h.text}`).slice(0, 12),
      excerpt: (fetched.analysis.bodyText || '').slice(0, GROUNDING_EXCERPT_CHARS),
    };
  }
  return null;
}

async function expandSections(sections, title) {
  const currentWords = totalWords(sections);
  const shortfall = MIN_TOTAL_WORDS - currentWords;
  const system = 'You are expanding a draft page that is too short to publish. Rewrite it so every section has ' +
    'substantive, complete prose paragraphs — expand thin sections using ONLY facts already present in the draft, ' +
    `never inventing a new fact, statistic, or offering. The draft is ${currentWords} words and MUST reach at least ` +
    `${MIN_TOTAL_WORDS} words (add at least ${shortfall} more). Respond with ONLY a JSON array matching the input ` +
    'shape: [{"heading": "...", "body": "..."}].';
  const user = `Page title: ${title}\n\nCurrent draft:\n${JSON.stringify(sections)}`;
  const expanded = await callLLMForJson(system, user, { maxTokens: 2400 }).catch(() => null);
  if (!Array.isArray(expanded) || !expanded.length) return sections;
  return expanded.filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string');
}

// params: { href, title, siblings: string[], sourcePages?: string[] }
export async function generate({ siteId, params }) {
  const { href, title, siblings, sourcePages } = params || {};
  if (!href) throw Object.assign(new Error('href is required'), { status: 400 });
  if (!title) throw Object.assign(new Error('title is required'), { status: 400 });
  if (!Array.isArray(siblings) || !siblings.length) {
    throw Object.assign(new Error('siblings are required — a page is only ever created in the shape of existing ones'), { status: 400 });
  }

  const [site, structureModel] = await Promise.all([
    getSiteById(siteId),
    fetchStructureModel(siblings),
  ]);

  // Hard gate, unlike blog-outline's best-effort homepage grounding. There
  // the fetch only improves an otherwise-valid draft; here the sibling's
  // structure IS the reason this generator is allowed to write a page at
  // all. Without it there is nothing to match and the correct outcome is to
  // fall back to removing the link, not to invent a shape.
  if (!structureModel) {
    throw Object.assign(
      new Error(`No sibling page under this section could be fetched to model structure on (tried ${Math.min(siblings.length, STRUCTURE_MODEL_LIMIT)}) — remove the dead link instead.`),
      { status: 502, userFacing: true },
    );
  }

  const linkedFrom = Array.isArray(sourcePages) && sourcePages.length ? sourcePages : [];
  const system = 'You are writing a page for an existing website that the site already links to but which was never ' +
    'actually published — visitors clicking that link currently hit a dead page. Write the real page.\n\n' +
    'CRITICAL: match the structure, depth, section pattern, and tone of the existing sibling page given below. It is ' +
    'from the same section of the same site, and the new page must read as though it belongs beside it — same kind ' +
    'of headings, same level of detail, same voice. Do not impose a different structure.\n\n' +
    'Any claim about this specific business (services, offerings, policies, pricing, people) must be grounded ONLY in ' +
    'the sibling page text provided — never invent one. General subject-matter knowledge is fine to write from. If ' +
    'the topic requires business specifics you were not given, write around them rather than fabricating them.\n\n' +
    `This must be publishable as-is: at least ${MIN_TOTAL_WORDS} words of real prose across the sections, never ` +
    'headings with placeholder or note-style text. Respond with ONLY a JSON object: {"title": "...", ' +
    '"metaDescription": "...", "sections": [{"heading": "...", "body": "..."}]}';

  const user = `Page to write: ${title}\nIts URL: ${href}\n` +
    (linkedFrom.length ? `Linked to from: ${linkedFrom.join(', ')}\n` : '') +
    `\nExisting sibling page to match (${structureModel.url})\n` +
    `Its section headings: ${structureModel.headings.join(' | ') || '(none extracted)'}\n` +
    `Its content:\n${structureModel.excerpt}`;

  let parsed;
  try {
    parsed = await callLLMForJson(system, user, { maxTokens: 2500, generatorId: meta.id, siteId });
  } catch {
    throw Object.assign(new Error('Missing-page generation failed: model did not return valid JSON'), { status: 400 });
  }

  let sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string');

  for (let attempt = 0; attempt < MAX_EXPAND_ATTEMPTS && totalWords(sections) < MIN_TOTAL_WORDS; attempt++) {
    sections = await expandSections(sections, title);
  }
  if (totalWords(sections) < MIN_TOTAL_WORDS) {
    throw Object.assign(
      new Error(`Missing-page generation produced only ${totalWords(sections)} words after expansion (need ${MIN_TOTAL_WORDS}+) — remove the dead link instead.`),
      { status: 502, userFacing: true },
    );
  }

  const content = {
    href,
    title: parsed.title || title,
    metaDescription: parsed.metaDescription || '',
    sections,
    // Carried into the draft so the implementer resolves the target directory
    // from the same siblings the decision was made on, and so a reviewer can
    // see which page this was modelled after.
    siblings,
    modelPage: structureModel.url,
    sourcePages: linkedFrom,
  };
  return {
    content,
    summary: `Create missing page "${content.title}" at ${href} (${totalWords(sections)} words, modelled on ${structureModel.url})`,
  };
}
