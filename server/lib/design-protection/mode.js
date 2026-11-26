// DESIGN_PROTECTION_MODE: 'off' runs nothing; 'log' (the default) runs every check, records what WOULD have been held, and lets the change through (the
// existing gates keep enforcing meanwhile); 'enforce' holds. Same three-state rollout as DESIGN_GATE_MODE, so the log-only period produces the table
// (protectionSummary) that says whether enforcing would take a client's output to zero BEFORE it is allowed to.
export const designProtectionMode = (env = process.env) => {
  const v = String(env.DESIGN_PROTECTION_MODE || 'log').toLowerCase();
  return ['off', 'log', 'enforce'].includes(v) ? v : 'log';
};
// Bounded repair: how many times a failing change may be repaired and re-checked before it is quarantined.
export const designRepairAttempts = (env = process.env) => Math.max(0, Math.min(Number(env.DESIGN_PROTECTION_REPAIR_ATTEMPTS ?? 2) || 0, 3));
