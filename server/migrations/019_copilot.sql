-- AI Copilot conversation threads — persisted (not an in-memory chat widget)
-- so a page reload doesn't lose history, matching a ChatGPT/Copilot-style
-- thread model rather than a stateless dashboard chatbot.
CREATE TABLE IF NOT EXISTS copilot_conversations (
  id         SERIAL PRIMARY KEY,
  site_id    INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  title      TEXT, -- short label from the first question, for a future conversation list
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS copilot_messages (
  id                SERIAL PRIMARY KEY,
  conversation_id   INT NOT NULL REFERENCES copilot_conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content           TEXT NOT NULL,
  cited_finding_ids TEXT[] NOT NULL DEFAULT '{}', -- Finding.id references the answer drew on (evidence chips)
  follow_ups        TEXT[] NOT NULL DEFAULT '{}', -- suggested next questions (assistant messages only)
  agent_ids_used    TEXT[] NOT NULL DEFAULT '{}', -- which agents were consulted this turn (never shown to the end user as raw names)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_copilot_messages_conversation ON copilot_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_copilot_conversations_site ON copilot_conversations (site_id, updated_at DESC);
