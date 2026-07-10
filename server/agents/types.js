// Documentation-only contract for AI Agents — no runtime code. Every agent
// module in this directory exports exactly `meta` and `run()`; there is no
// base class, the shapes below are enforced by the registry at load time
// (see registry.js) plus convention.

/**
 * @typedef {Object} DataSource
 * @property {string} id                       stable slug, e.g. "ai-citation-tracking"
 * @property {'connected'|'not-connected'} status
 * @property {string} [description]
 */

/**
 * @typedef {Object} AgentMeta
 * @property {string} id            stable kebab-case slug, e.g. "opportunity" — used in URLs
 * @property {string} name          display name
 * @property {string} description   one sentence, shown by GET /api/agents
 * @property {string} category      "seo" | "content" | "geo" | "meta"
 * @property {number} version       bump when the `facts` shape changes (stored per-row in agent_runs)
 * @property {string[]} [requires]  ids of sub-agents this one composes (meta-agents only, e.g. executive-report)
 * @property {DataSource[]} [dataSources] external data sources this agent depends on beyond the
 *                                          existing GSC/GA4 tables. Absent/empty = fully self-sufficient
 *                                          today. An agent whose sources are all "not-connected" must
 *                                          return status "insufficient-data" rather than a fabricated estimate.
 */

/**
 * @typedef {Object} AgentInput
 * @property {number} siteId
 * @property {string} [start]   YYYY-MM-DD, inclusive range start
 * @property {string} [end]     YYYY-MM-DD, inclusive range end
 * @property {Object} [params]  agent-specific knobs, validated by the agent itself — never the router
 */

/**
 * @typedef {Object} AgentOutput
 * @property {AgentMeta} meta
 * @property {'ok'|'insufficient-data'|'error'} status
 * @property {Object|null} facts        plain JS numbers/structures computed BEFORE any LLM call —
 *                                       the ground truth a narrative is never allowed to contradict.
 *                                       null when status !== 'ok'.
 * @property {string|null} narrative    LLM prose synthesized on top of `facts`, or null for a
 *                                       facts-only run, or when status !== 'ok'.
 * @property {DataSource[]} [requiredDataSources] present when status === 'insufficient-data'
 * @property {string} [message]         present when status !== 'ok', explains why in plain language
 * @property {string} generatedAt       ISO timestamp
 */

/**
 * Every file in server/agents/ (other than types.js, registry.js, runner.js)
 * must export exactly:
 *
 *   export const meta = { ... };              // AgentMeta
 *   export async function run(input) { ... }  // (AgentInput) => Promise<AgentOutput>
 */
export {};
