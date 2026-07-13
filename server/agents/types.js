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
 * @typedef {Object} RecommendedAction
 * @property {string} label        short human-readable action, e.g. "Add FAQ section"
 * @property {string|null} generatorId  id from generators/registry.js this action can draft via
 *                                       Action Center, or null when no generator applies (the
 *                                       finding is still real and worth surfacing, just not
 *                                       draftable) — set directly by the agent that knows the
 *                                       vocabulary, never guessed downstream from free text.
 * @property {Object} [params]     generator input params when generatorId is set (e.g. page, query)
 * @property {'Low'|'Medium'|'High'} [effort]  cost to execute the action itself — a property of
 *                                              the action type (e.g. structural fix vs net-new
 *                                              content), not of the finding's importance.
 */

/**
 * @typedef {Object} ExpectedImpact
 * @property {'High'|'Medium'|'Low'} label
 * @property {'computed'|'estimate'} basis   'computed' = derived directly from this run's real
 *                                            numbers; 'estimate' = a labeled projection/assumption
 *                                            (e.g. opportunity's traffic-gain curve). Never unlabeled.
 * @property {number} [value]      the underlying number the label was computed/estimated from
 */

/**
 * @typedef {Object} Finding
 * One concrete, evidence-backed item within an agent's `facts.findings` — the unit another AI
 * (orchestrator, future chat) or a UI consumes instead of re-parsing `narrative` prose.
 * @property {string} id                 stable, globally-unique slug: `${agentId}:${...}`
 * @property {Object} evidence           the specific real numbers backing this finding — a slice
 *                                        of `facts`, never a re-statement or a new invented number
 * @property {string} whyItMatters       one sentence, must reference `evidence`
 * @property {'high'|'medium'|'low'} priority   computed per agent from a real signal already in
 *                                               `facts` (rank, delta magnitude, score gap) —
 *                                               never a fixed constant
 * @property {RecommendedAction|null} recommendedAction
 * @property {ExpectedImpact} expectedImpact
 */

/**
 * @typedef {Object} AgentOutput
 * @property {AgentMeta} meta
 * @property {'ok'|'insufficient-data'|'error'} status
 * @property {Object|null} facts        plain JS numbers/structures computed BEFORE any LLM call —
 *                                       the ground truth a narrative is never allowed to contradict.
 *                                       Carries `facts.findings: Finding[]` (see above) alongside
 *                                       whatever agent-specific fields already lived here.
 *                                       null when status !== 'ok'.
 * @property {string|null} narrative    LLM prose synthesized on top of `facts` — doubles as the
 *                                       agent's plain-language Summary. Null for a facts-only run,
 *                                       or when status !== 'ok'.
 * @property {DataSource[]} [requiredDataSources] present when status === 'insufficient-data'
 * @property {string} [message]         present when status !== 'ok', explains why in plain language
 * @property {string} generatedAt       ISO timestamp
 */

/**
 * Every file in server/agents/ (other than types.js, registry.js, runner.js, orchestrator.js,
 * and lib/*) must export exactly:
 *
 *   export const meta = { ... };              // AgentMeta
 *   export async function run(input) { ... }  // (AgentInput) => Promise<AgentOutput>
 *
 * This is also the "specialist worker" contract the orchestrator (orchestrator.js) calls agents
 * through — an agent never needs to know whether its caller is a UI button, the orchestrator, or
 * (later) an AI chat; it always receives the same AgentInput and returns the same AgentOutput.
 */

/**
 * @typedef {Object} OrchestratorInput
 * @property {number} siteId
 * @property {string} [start]
 * @property {string} [end]
 * @property {string[]} [agentIds]  which agents to run — omit to run every non-meta registered agent
 * @property {string} [question]    when set, conditions the synthesis narrative to answer this
 *                                   specific question instead of writing a generic briefing (see
 *                                   synthesizeFindings in orchestrator.js). agentIds is still the
 *                                   caller's job to resolve — the AI Copilot (agents/lib/copilot.js)
 *                                   does that resolution itself before calling runOrchestration,
 *                                   rather than orchestrator.js parsing the question itself.
 * @property {boolean} [persistSubAgentRuns]  default false — matches executive-report's existing
 *                                             behavior of not writing N redundant agent_runs rows
 *                                             when composing; callers that want each sub-agent run
 *                                             persisted (e.g. an explicit "run everything" sweep)
 *                                             set this true.
 */

/**
 * @typedef {Object} OrchestratorOutput
 * @property {string[]} ranAgentIds
 * @property {string} generatedAt
 * @property {Finding[]} findings    combined across every ran agent, priority-sorted, each already
 *                                    carrying its source `agentId` via its namespaced `id`
 * @property {Object} perAgent       `{ [agentId]: { status, facts, narrative, message, findingsCount } }` —
 *                                    full sub-agent output, not just a summary, so downstream
 *                                    consumers (e.g. the weekly executive Google Doc) that need a
 *                                    sub-agent's real facts don't have to re-run it themselves
 * @property {string|null} narrative one combined answer synthesized from the structured findings
 *                                    (not a concatenation of each agent's own prose)
 */
export {};
