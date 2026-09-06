-- Lets ai_prompt_runs (migration 036) record which AI provider a probe was
-- actually run against, instead of assuming OpenAI forever — the AI
-- Recommendation Agent (server/agents/ai-recommendation.js) is moving from a
-- single hardcoded OpenAI probe to a pluggable provider list
-- (server/agents/lib/model-providers/). Every existing row really was
-- OpenAI, so the DEFAULT backfills them correctly with no data migration
-- needed; every new row passes an explicit provider id.
ALTER TABLE ai_prompt_runs ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openai';

-- Real cited-source domains, ONLY for providers whose API responses include
-- them (Perplexity's `citations`/`search_results` fields; OpenAI/Anthropic
-- return none). Nullable and never backfilled/guessed for a provider that
-- doesn't supply this — same no-fabrication discipline as every other
-- optional-evidence column in this codebase. Populated by a later phase;
-- the column exists now so the schema doesn't need a second migration when
-- that phase lands.
ALTER TABLE ai_prompt_runs ADD COLUMN IF NOT EXISTS cited_domains JSONB;

-- The query shape every new per-provider read (facts.providers breakdown,
-- per-provider history) needs — site_id + provider, newest first.
CREATE INDEX IF NOT EXISTS idx_ai_prompt_runs_site_provider_date
  ON ai_prompt_runs (site_id, provider, run_date DESC);
