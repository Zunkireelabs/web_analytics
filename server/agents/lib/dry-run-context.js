import { AsyncLocalStorage } from 'node:async_hooks';

// "Dry run" = this agent run must leave no trace: no rotation-ledger advance,
// no hash/classifier-cache writes. Distinct from runAgent's `persist:false`,
// which only means "don't write the agent_runs row" and is used by REAL runs
// too (bulk-audit chunks, the on-demand recommendation re-check) whose side
// effects must still land. An AsyncLocalStorage context so store helpers a
// dozen agents share (markPagesChecked) can honour it without each agent
// threading a flag through.
const als = new AsyncLocalStorage();
export const runAsDryRun = (fn) => als.run({ dryRun: true }, fn);
export const isDryRun = () => als.getStore()?.dryRun === true;
