// Capabilities that are part of the platform and ON unless someone deliberately turns them off.
//
// Why a helper: the learning modules were once behind "=== 'on'" switches that nobody remembered to set, so they never ran.
// For these capabilities the rule is the opposite: unset means ON. Only an explicit off value ('off', 'false', '0', 'no')
// disables one, and startup logs every capability that is off so it can never be off by accident.

const OFF = new Set(['off', 'false', '0', 'no', 'disabled']);

export function onUnlessDisabled(value) {
  if (value == null) return true;
  return !OFF.has(String(value).trim().toLowerCase());
}

// name -> what it does and what turning it off costs. The single list startup validation reports from.
export const CAPABILITIES = Object.freeze({
  LEARNING_EVIDENCE_IN_DECISIONS: { does: 'project memory, behaviour history and industry knowledge are given to the decision engine as evidence' },
  INDUSTRY_INTELLIGENCE_RANKING: { does: 'validated cross-project industry patterns nudge the daily ranking (bounded, never over a more severe tier)' },
  MODEL_REGISTRY: { does: 'a model promoted through the evaluated registry is used for AI calls (no effect until one is promoted)' },
});

export const capabilityEnabled = (name, env = process.env) => onUnlessDisabled(env[name]);

export function capabilityReport(env = process.env) {
  return Object.entries(CAPABILITIES).map(([name, c]) => ({ name, enabled: capabilityEnabled(name, env), does: c.does, raw: env[name] ?? null }));
}
