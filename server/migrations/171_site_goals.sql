-- Per-site Business Goals (Stage 1 of the goal-driven-prioritization plan).
-- A tenant states 1-3 active goals ("generate leads for booking-software
-- pages", "reduce bounce on service pages"); the goal-alignment evaluator
-- (server/agents/lib/goal-alignment.js) scores every finding against them as
-- an ADDITIONAL decision signal, never a replacement for existing technical
-- impact/evidence/risk/safety gates. Strictly per-site — never a cross-tenant
-- default, same rule already in force for design tokens (see
-- multi-tenant-design-system-scoping) — enforced here the only way that
-- actually holds: every query in server/store/site-goals.js is scoped by
-- site_id, and there is no site_id-nullable "global goal" row shape at all.
--
-- goal_type is a fixed, extensible enum of predefined types clients can pick
-- in the (Stage 2) UI without writing anything technical, plus 'custom' for
-- a free-text goal an admin describes and later confirms/edits an
-- AI-proposed structure for (Stage 2). Adding a new predefined type later is
-- a CHECK-constraint edit, not a schema rewrite.
CREATE TABLE IF NOT EXISTS site_goals (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  goal_type TEXT NOT NULL CHECK (goal_type IN (
    'generate_leads', 'increase_organic_traffic', 'increase_conversions',
    'reduce_bounce_rate', 'increase_organic_visibility', 'increase_qualified_traffic',
    'grow_bookings', 'grow_sales', 'custom'
  )),
  -- Short, human-written label naming what this goal actually is for THIS
  -- site (e.g. "Generate leads for booking software") — required even for a
  -- predefined goal_type, because the type alone ("generate_leads") is not
  -- specific enough for the alignment evaluator to match findings against;
  -- the site owner's own wording of the target IS the machine-readable
  -- context, same "the client's own real words, never invented" discipline
  -- ai-recommendation.js's prompt-generation already follows.
  objective TEXT NOT NULL,
  -- Free-text business area/topic this goal is about (e.g. "booking
  -- software"), matched against a finding's own text (reason/tag/category)
  -- when no page pattern matches directly. Nullable — a goal can be
  -- page-scoped only.
  target_business_area TEXT,
  -- Simple glob patterns ('/booking-software/*', '/pricing') matched against
  -- a finding's page — see matchesPagePattern in goal-alignment.js. Nullable
  -- — a goal can be judged by topic alone with no page scope.
  target_page_patterns TEXT[],
  -- Free text (not a fixed enum): "lead_submission", "organic_traffic",
  -- whatever the site owner's own language for success is. Descriptive only
  -- today — nothing computes against it in Stage 1 beyond display; a future
  -- Goal Progress view (item 7) reads it as a label for the metric fix-impact
  -- already measures.
  primary_metric TEXT,
  -- Optional additional natural-language context (Stage 2's custom-goal
  -- description, or extra color on a predefined goal) — read by the
  -- evaluator's keyword-overlap check same as target_business_area/objective.
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  -- Relative importance AMONG this site's own goals when more than one
  -- matches the same finding — lower number = more important, same
  -- ascending-rank convention insights.js's/ActionCenter.jsx's own
  -- PRIORITY_RANK already uses (0/1/2 = high/medium/low). Ties (equal
  -- importance) are broken by which goal produces the stronger alignment
  -- level for that specific finding.
  importance INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_goals_site_active ON site_goals (site_id, status) WHERE status = 'active';

COMMENT ON TABLE site_goals IS
  'Per-site business goals (1-3 typical) a client/admin sets — see server/agents/lib/goal-alignment.js for how findings are scored against them, and server/store/site-goals.js for the CRUD this table is exclusively read/written through.';

-- Threads goal alignment through to the recommendation a finding became, so
-- (a) the Action Center can show "why this matters to your goal" without
-- re-evaluating anything at read time, and (b) a future Goal Progress view
-- (item 7 of the plan) can trace goal -> recommendation -> draft -> the
-- fix-impact row that already measures shipped outcomes, with zero new
-- measurement infrastructure.
--
-- Both columns are RECOMPUTED on every sync (agents/lib/recommendations.js's
-- buildRecommendations calls the evaluator fresh each run) and written
-- unconditionally on merge, never COALESCE'd — same semantics
-- blocked_reason/risk_tier already use in mergeIntoRecommendation, and for
-- the same reason: a goal that gets paused must make its previously-aligned
-- recommendations fall back to unaligned on the very next sync, not carry a
-- stale alignment forever.
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS goal_id INTEGER REFERENCES site_goals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS goal_alignment JSONB;

COMMENT ON COLUMN recommendations.goal_alignment IS
  '{level: strong|partial|weak|none|insufficient_evidence, rationale: string} — see evaluateGoalAlignment in server/agents/lib/goal-alignment.js. NULL when the site had no active goals at sync time (never fabricated).';
