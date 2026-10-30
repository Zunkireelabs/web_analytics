import { query } from '../db.js';

// The /get-started "finish" step (migration 218). Pure rules live here so the route only has to say yes or no.

// The page's goals (SEO, AEO, GEO, agents, content, reporting) in the app's own goal vocabulary
// (store/workspaces.js GOAL_KEYS). 'clients' (report to clients) has no preset, so it is the custom goal.
const GOAL_MAP = { seo: 'key_rankings', aeo: 'ai_answers', geo: 'ai_answers', agentic: 'ai_answers', content: 'google_visitors' };
export function mapGoals(pageGoals) {
  const out = [];
  for (const g of Array.isArray(pageGoals) ? pageGoals : []) {
    const key = g === 'clients' ? 'custom' : GOAL_MAP[g];
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (v, count, max) => (Array.isArray(v) ? v : []).map((x) => text(x, max)).filter(Boolean).slice(0, count);

// The document kept with the project. Every free-text field is length-capped and every list is count-capped,
// so a crafted request cannot store an unbounded blob.
export function cleanOnboarding(body) {
  const b = body || {};
  const p = b.profile || {};
  const m = b.markets || {};
  return {
    brand: text(b.brand, 120),
    entityCountry: text(b.entityCountry, 2).toUpperCase(),
    run: { country: text(b.run?.country, 2).toUpperCase(), language: text(b.run?.language, 8), city: text(b.run?.city, 80), timeZone: text(b.run?.timeZone, 64) },
    profile: {
      description: text(p.description, 1200), category: text(p.category, 120),
      identity: list(p.identity, 20, 120), products: list(p.products, 30, 120), personas: list(p.personas, 20, 120), competitors: list(p.competitors, 20, 120),
    },
    goals: list(b.goals, 6, 20),
    markets: { scope: ['global', 'region', 'country'].includes(m.scope) ? m.scope : 'global', items: list(m.items, 80, 80) },
    topics: list(b.topics, 50, 120),
    focus: text(b.focus, 20),
    brandedShare: Math.min(100, Math.max(0, Math.round(Number(b.brandedShare) || 0))),
    prompts: (Array.isArray(b.prompts) ? b.prompts : []).slice(0, 200).map((x) => ({
      text: text(x?.text ?? x, 400), topic: text(x?.topic, 120), intent: text(x?.intent, 20), branded: x?.branded === true,
    })).filter((x) => x.text),
    auditId: text(b.auditId, 80) || null,
  };
}

// A project this person already has for this website (they own or belong to its workspace), so pressing
// finish twice, or coming back later, reuses it instead of making a second workspace.
export async function findExistingProject(userId, domain) {
  const { rows } = await query(
    `SELECT s.id, s.name, s.website_domain, s.workspace_id
       FROM sites s JOIN workspace_members m ON m.workspace_id = s.workspace_id
      WHERE m.user_id = $1 AND lower(s.website_domain) = lower($2) AND s.status IS DISTINCT FROM 'soft_deleted'
      ORDER BY s.id LIMIT 1`, [userId, domain]);
  return rows[0] || null;
}

export async function saveOnboarding(siteId, data, userId) {
  await query(
    `INSERT INTO site_onboarding (site_id, data, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (site_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [siteId, JSON.stringify(data), userId ?? null]);
}

// ───────── who started a trial from /get-started (migration 217) ─────────

// Notes that an address asked to start (before it is verified). Asking again only refreshes the row.
export async function noteGetStartedSignup(email, { via = 'email' } = {}) {
  await query(
    `INSERT INTO get_started_signups (email, via) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET updated_at = now()`, [email, via]);
}

// Notes that the address proved it is theirs and which login it became.
export async function markGetStartedVerified(email, userId, { via = 'email' } = {}) {
  await query(
    `INSERT INTO get_started_signups (email, via, user_id, verified_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id, verified_at = COALESCE(get_started_signups.verified_at, now()), updated_at = now()`,
    [email, via, userId]);
}
