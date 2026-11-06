import { query as dbQuery } from '../db.js';
import { getSetting, putSettingQuiet } from './platform-settings.js';

// Automatic first baseline for projects onboarded AFTER the Master Agent went live (owner decision 2026-11-06).
//
// The baseline re-runs every analysis agent and costs real money, so it stays a deliberate step for every project that existed
// before the Master Agent went live, exactly as today. Once the Master Agent is live, a NEW project that is connected and has no baseline
// yet gets one started for it, limited to a few a day so one busy day cannot spend without bound. Nothing here runs unless the Master
// Agent is live (lib/master-agent.js passes this only in 'on' mode).

export const LIVE_SINCE_KEY = 'master_agent_live_since';   // ISO time the Master Agent last went live
export const STATE_KEY = 'master_auto_baselines';          // { day: 'YYYY-MM-DD', started: { [siteId]: ISO time } }
export const DEFAULT_DAILY_CAP = 3;
export const REPEAT_HOURS = 12;                            // a project whose baseline is still running is not started again

export const dailyCap = (env = process.env) => {
  const n = Number(env.MASTER_AUTO_BASELINES_PER_DAY);
  return Number.isFinite(n) && n >= 0 && env.MASTER_AUTO_BASELINES_PER_DAY !== undefined && env.MASTER_AUTO_BASELINES_PER_DAY !== '' ? Math.floor(n) : DEFAULT_DAILY_CAP;
};
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

/** Pure. Should this project get an automatic baseline right now? Returns { ok, reason }. */
export function decide({ site, liveSince, state, now = new Date(), cap = DEFAULT_DAILY_CAP }) {
  if (!liveSince) return { ok: false, reason: 'master-agent-not-live' };
  if (cap <= 0) return { ok: false, reason: 'automatic-baselines-off' };
  if (site.onboarded_at) return { ok: false, reason: 'already-baselined' };
  // Only projects created after the Master Agent went live. Everything older keeps starting its baseline by hand.
  if (!site.created_at || new Date(site.created_at) < new Date(liveSince)) return { ok: false, reason: 'existing-project' };
  const today = dayOf(now);
  const started = state?.day === today ? (state.started || {}) : {};
  const recent = started[site.id] && now - new Date(started[site.id]) < REPEAT_HOURS * 3600e3;
  if (recent) return { ok: false, reason: 'already-started' };
  if (Object.keys(started).length >= cap) return { ok: false, reason: 'daily-limit-reached' };
  return { ok: true, reason: null };
}

const defaultStart = (site) => {
  // Fire and forget: a baseline takes minutes and has its own per-project lock, so a second request while it runs is simply refused.
  import('../routes/clients.js')
    .then((m) => m.runBaselineSequence(site.id, site))
    .catch((err) => console.error(`[auto-baseline] site ${site.id}: ${String(err?.message || err).slice(0, 160)}`));
};

/** What the Master Agent hands to the Agent Factory: `allow(site)` decides, `run(site)` records it and starts the baseline. */
export async function makeAutoBaselinePolicy({ query = dbQuery, now = new Date(), env = process.env, start = defaultStart } = {}) {
  const cap = dailyCap(env);
  const liveSince = (await getSetting(LIVE_SINCE_KEY, { query }).catch(() => null))?.value || null;
  let state = (await getSetting(STATE_KEY, { query }).catch(() => null))?.value || null;
  const today = dayOf(now);
  if (!state || state.day !== today) state = { day: today, started: {} };
  return {
    cap, liveSince,
    allow: async (site) => decide({ site, liveSince, state, now, cap }),
    run: async (site) => {
      state = { day: today, started: { ...state.started, [site.id]: now.toISOString() } };
      await putSettingQuiet(STATE_KEY, state, { query }); // recorded BEFORE it starts, so a crash can never start the same one twice
      start(site);
      return { started: true };
    },
    startedToday: () => Object.keys(state.started).length,
  };
}

/** For the Platform page: when it went live, the daily limit, and how many have started today. Never throws. */
export async function autoBaselineStatus({ query = dbQuery, now = new Date(), env = process.env } = {}) {
  try {
    const liveSince = (await getSetting(LIVE_SINCE_KEY, { query }))?.value || null;
    const state = (await getSetting(STATE_KEY, { query }))?.value || null;
    const startedToday = state?.day === dayOf(now) ? Object.keys(state.started || {}).length : 0;
    return { liveSince, cap: dailyCap(env), startedToday };
  } catch { return { liveSince: null, cap: dailyCap(env), startedToday: 0 }; }
}
