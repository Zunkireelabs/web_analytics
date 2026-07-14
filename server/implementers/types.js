// Documentation-only contract for Action Center Implementers — no runtime
// code. Mirrors server/generators/types.js's contract shape deliberately.
//
// An implementer takes an APPROVED draft and turns it into a real GitHub
// pull request against the site's own repo — the step generators never do
// (generators only ever produce draft content, see generators/types.js).
// Work is split by domain, not one monolithic "apply" function: each module
// in this directory declares which generator ids it `handles`, mirroring how
// a human dev team would split frontend vs. backend work, with the actual
// commit/PR mechanics shared via lib/github-ops.js so neither implementer
// re-implements GitHub plumbing.

/**
 * @typedef {Object} ImplementerMeta
 * @property {string} id            stable kebab-case slug, e.g. "backend"
 * @property {string} name          display name
 * @property {string} description   one sentence
 * @property {string[]} handles     generator ids (drafts.action_type values) this implementer applies
 */

/**
 * @typedef {Object} ApplyResult
 * @property {boolean} ok
 * @property {string} [branchName]  set when ok:true
 * @property {string} [prUrl]       set when ok:true
 * @property {number} [prNumber]    set when ok:true
 * @property {string} [reason]      set when ok:false — a stable machine-readable code,
 *                                    e.g. "no-file-mapping" | "merge-strategy-not-implemented" | "github-error"
 * @property {string} [error]       set when ok:false — a human-readable explanation
 */

/**
 * Every file in server/implementers/ (other than types.js, registry.js, and
 * the lib/ helpers) must export exactly:
 *
 *   export const meta = { ... };                      // ImplementerMeta
 *   export async function apply(site, draft) { ... }   // (site row, drafts row) => Promise<ApplyResult>
 *
 * apply() must NEVER throw for a foreseeable failure (no file mapping, an
 * unimplemented merge strategy, a GitHub API error) — it returns an honest
 * {ok:false, reason, error} instead, the same never-fabricate discipline
 * server/agents/ai-visibility.js and content-gap.js use for
 * status:'insufficient-data'. apply() must NEVER merge a pull request —
 * merging is always a human, on GitHub itself.
 */
export {};
