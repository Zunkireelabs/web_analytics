-- Every decision the design gates make, including the ones that did NOT block.
-- (server/store/design-gate-decisions.js)
--
-- The design gates fail CLOSED: when they cannot confirm a draft will match the
-- site, the draft is held. That is the right default for fidelity and a
-- dangerous one to switch on blind — on a fleet where design data is thin it
-- holds nearly everything at once, and takes output to zero. So each gate has
-- a log-only mode that records "this WOULD have been blocked" and ships
-- anyway, and this table is that record. Run log-only, read this table, fix
-- the profiles that would have been held, and only then enforce.
--
-- mode: 'log' = recorded and shipped; 'enforce' = recorded and held.
-- blocked is what the gate decided, regardless of mode, so the two can be
-- compared directly: SELECT count(*) WHERE mode='log' AND blocked.
CREATE TABLE IF NOT EXISTS design_gate_decisions (
  id          BIGSERIAL PRIMARY KEY,
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  draft_id    INT,
  action_type TEXT NOT NULL,
  gate        TEXT NOT NULL,
  mode        TEXT NOT NULL,
  blocked     BOOLEAN NOT NULL,
  reason      TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE design_gate_decisions DROP CONSTRAINT IF EXISTS design_gate_decisions_gate_check;
ALTER TABLE design_gate_decisions ADD CONSTRAINT design_gate_decisions_gate_check
  CHECK (gate IN ('completeness', 'render'));
ALTER TABLE design_gate_decisions DROP CONSTRAINT IF EXISTS design_gate_decisions_mode_check;
ALTER TABLE design_gate_decisions ADD CONSTRAINT design_gate_decisions_mode_check
  CHECK (mode IN ('log', 'enforce'));

-- "How many drafts would each site have lost this week" — the read that
-- decides whether it is safe to enforce.
CREATE INDEX IF NOT EXISTS design_gate_decisions_site_idx
  ON design_gate_decisions (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS design_gate_decisions_blocked_idx
  ON design_gate_decisions (gate, mode, created_at DESC) WHERE blocked;
