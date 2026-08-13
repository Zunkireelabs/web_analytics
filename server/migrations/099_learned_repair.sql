-- Cross-client learned repair: lets a fix proven on one client be executed on
-- another BEFORE the issue reaches that client's Action Center.
--
-- agent_fix_memory (097) already stores lessons cross-tenant (site_id NULL =
-- wildcard) and already retrieves them — but only ever into an LLM PROMPT
-- (agent-memory.js's withAgentMemory). Nothing has ever acted on a lesson.
-- The two columns below are what turn a remembered lesson into something
-- executable, and what makes "is this lesson applicable to a DIFFERENT site"
-- a real, inspectable decision rather than text similarity.
--
-- Both are nullable and default NULL, which is the no-behavior-change
-- guarantee: every one of the 58 existing rows stays exactly as useful as it
-- is today (advisory prompt injection), and is structurally excluded from
-- cross-client execution because findPortableRepairs requires both to be
-- non-null.

-- Technology-only token array captured at learn time (server/agents/lib/
-- site-fingerprint.js) — e.g. ["render:eleventy","target-ext:.njk","md:false"].
-- Never a client name, domain, URL, or file path; extensions only. This is
-- what a candidate target site is matched against before any repair runs.
ALTER TABLE agent_fix_memory ADD COLUMN IF NOT EXISTS site_fingerprint JSONB;

-- How to re-perform the repair. Deliberately a CHAIN DESCRIPTOR
-- ({kind:'generator-chain', generatorId, ...}), not a literal
-- {anchor, replacement} edit: an anchor is one site's own source bytes and is
-- meaningless in another repo. The generator re-derives its own anchors from
-- the target's real source at apply time, and its implementer refuses
-- all-or-nothing if they don't match exactly (implementers/lib/
-- exact-match-patch.js). Portable knowledge is WHICH chain resolves this
-- problem class, not WHAT text to write.
ALTER TABLE agent_fix_memory ADD COLUMN IF NOT EXISTS repair_recipe JSONB;

-- Separate from sites.auto_remediation_enabled (089) on purpose, and BOTH are
-- required. That flag means "act unattended on issues found on MY site"; this
-- one means "act using a repair whose only evidence comes from someone
-- else's site". A client can reasonably consent to the first and not the
-- second, and defaulting this to false means merging this migration changes
-- nothing for anybody.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS learned_repair_enabled BOOLEAN NOT NULL DEFAULT false;
