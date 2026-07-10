-- Cache LLM-detected language + English translation for a raw search query
-- string, keyed by the query text alone (not per-site/date) — the same query
-- phrase means the same thing regardless of which site/day it was searched,
-- so this avoids re-translating the same phrase every time it recurs.
CREATE TABLE IF NOT EXISTS query_translations (
  query       TEXT PRIMARY KEY,
  language    TEXT,
  translation TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
