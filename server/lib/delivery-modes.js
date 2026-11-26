// ONE PLACE for the switches that make each part of the delivery system reversible without a code rollback. Defaults are the SAFE first-deploy values:
//   DELIVERY_RECORD_MODE         on | off          the day record and item ledger (observation only: it writes to its own tables and never changes what ships)
//   DELIVERY_CONSOLIDATION_MODE  log | on | off    the 16:30 step that opens each project's PR / preserves the work. log = say what it WOULD do, touch nothing on GitHub
//   DELIVERY_ALERTS_MODE         log | on | off    on = critical and high alerts are also emailed to staff; log = logged and shown on the status view only
//   GITHUB_CONDITIONAL_GETS_MODE on | off          ETag conditional reads (a 304 costs no rate limit); off = every read is unconditional, as before
// A value that is not one of the listed ones falls back to the default, never to "on".
const pick = (value, allowed, dflt) => { const v = String(value ?? '').trim().toLowerCase(); return allowed.includes(v) ? v : dflt; };
export const deliveryRecordMode = (env = process.env) => pick(env.DELIVERY_RECORD_MODE, ['on', 'off'], 'on');
export const consolidationMode = (env = process.env) => pick(env.DELIVERY_CONSOLIDATION_MODE, ['log', 'on', 'off'], 'log');
export const alertsMode = (env = process.env) => pick(env.DELIVERY_ALERTS_MODE, ['log', 'on', 'off'], 'log');
export const conditionalGetsMode = (env = process.env) => pick(env.GITHUB_CONDITIONAL_GETS_MODE, ['on', 'off'], 'on');
