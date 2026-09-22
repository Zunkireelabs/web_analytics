-- The Decision layer's persistence (Phase 1 of the "one intelligence"
-- consolidation plan, fix/system). One row per opportunity/situation the
-- new decision-engine reasons about, whether or not it results in a
-- generator ever being invoked — 'investigate_further' and 'do_nothing' are
-- real, persisted outcomes, not the absence of one. This is deliberately a
-- NEW table, not a repurposing of `recommendations`: a recommendation is
-- "here is a thing to ship", a decision is "here is why, and why not the
-- alternatives" — the reasoning that led to a recommendation (or to
-- explicitly not creating one). action_target, once resolved to a concrete
-- generator/page, is what a caller uses to invoke the existing generator
-- pipeline unchanged (see server/agents/lib/recommendation-gates.js
-- downstream — that gate is unaffected by this table's existence until a
-- future phase wires a call site into it).
--
-- No FK/consumer wiring yet: this migration and decision-engine.js are
-- intentionally unwired (Phase 1) — no cron job, generator, or route reads
-- or writes this table yet. Added now so the schema and module can be
-- reviewed and tested in isolation before any call site touches them.
CREATE TABLE IF NOT EXISTS decisions (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  situation TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]',            -- [{source, summary, ref}]
  root_cause JSONB,                                 -- {hypothesis, confidence, supportingEvidence[]} | null
  missing_evidence JSONB NOT NULL DEFAULT '[]',     -- string[]
  action TEXT NOT NULL CHECK (action IN (
    'improve_page', 'new_page', 'fix_technical', 'fix_metadata',
    'internal_linking', 'investigate_further', 'do_nothing'
  )),
  action_target JSONB,                              -- {generatorId, pageUrl, ...} | null
  rationale TEXT NOT NULL,
  alternatives_considered JSONB NOT NULL DEFAULT '[]', -- [{action, whyRejected}]
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50,
  validation_plan TEXT,
  status TEXT NOT NULL DEFAULT 'decided'
    CHECK (status IN ('decided', 'executing', 'shipped', 'verified', 'failed')),
  outcome_ref TEXT,                                  -- Phase 10: links forward to agent_fix_memory / fix-impact once shipped
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decisions_site ON decisions (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_action ON decisions (action);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status) WHERE status != 'verified';

COMMENT ON TABLE decisions IS
  'Persisted output of decision-engine.js — one row per situation reasoned about, including investigate_further/do_nothing outcomes. Unwired until a later phase connects a call site to it.';
