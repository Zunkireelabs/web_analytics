// Documentation-only contract for Action Center Generators — no runtime code.
// Every generator module in this directory exports exactly `meta` and
// `generate()`; enforced by the registry at load time (see registry.js) plus
// convention. Mirrors server/agents/types.js's contract shape deliberately —
// same discipline, same reasons.

/**
 * @typedef {Object} GeneratorMeta
 * @property {string} id            stable kebab-case slug, e.g. "meta-title" — used in URLs and drafts.action_type
 * @property {string} name          display name
 * @property {string} description   one sentence, shown by GET /api/action-center/generators
 * @property {string[]} recommendationTags  agent recommendation/gap strings this generator answers
 *                                            (e.g. ["Improve title"]) — used to map an agent's real
 *                                            recommendation to a "Generate Draft" action in the UI.
 */

/**
 * @typedef {Object} GeneratorInput
 * @property {number} siteId
 * @property {Object} params  generator-specific grounding input (page url, query, topic, targetLanguage,
 *                             etc.) — validated by the generator itself, never the router.
 */

/**
 * @typedef {Object} GeneratorOutput
 * @property {Object} content   structured draft content — shape is generator-specific, but always
 *                               real structured fields (e.g. an array of Q&A pairs), never a single
 *                               opaque prose blob, so a future publish step can map fields directly.
 * @property {string} [summary] short human-readable description of what was generated, for display.
 */

/**
 * Every file in server/generators/ (other than types.js, registry.js) must
 * export exactly:
 *
 *   export const meta = { ... };                   // GeneratorMeta
 *   export async function generate(input) { ... }   // (GeneratorInput) => Promise<GeneratorOutput>
 *
 * A generator NEVER writes to any live page/CMS — this framework has no
 * publish capability at all. Every call is a pure function producing draft
 * content; persistence to the `drafts` table happens in the route layer,
 * exactly once per generate() call.
 */
export {};
