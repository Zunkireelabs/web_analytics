-- Product knowledge beyond "capabilities" (Product Understanding Layer,
-- migration 111). A SaaS product site needs agents to write accurate copy
-- about HOW the product works, WHAT it costs, WHO it is for and WHAT PROOF
-- exists — none of which fit a "capability" row. Rather than a parallel
-- table, the same verified/proposed/rejected gate and tenant scoping are
-- reused: a row just gains a `kind` and a free-form `details_json`.
--
-- Backward compatible by construction: `kind` defaults to 'capability', so
-- every existing row, and every existing reader that asks for capabilities
-- (classifyGapRelevance, the visibility snapshots, the Analyst page), keeps
-- seeing exactly the rows it saw before. The new kinds are only ever read by
-- code that asks for them explicitly (getProductKnowledge).
--
-- Same trust model as 111: only 'verified' rows are ever read by agents; an
-- agent may propose a 'proposed' row, which nothing reads until a human
-- approves it.
ALTER TABLE product_capabilities
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'capability';

ALTER TABLE product_capabilities
  ADD COLUMN IF NOT EXISTS details_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE product_capabilities DROP CONSTRAINT IF EXISTS product_capabilities_kind_check;
ALTER TABLE product_capabilities ADD CONSTRAINT product_capabilities_kind_check
  CHECK (kind IN ('capability', 'flow', 'pricing', 'audience', 'proof'));

CREATE INDEX IF NOT EXISTS idx_product_capabilities_kind
  ON product_capabilities (site_id, kind, status);
