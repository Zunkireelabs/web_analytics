-- 276: what the person asked to be changed on a content idea, saved with the pick.
-- A person picks an option for an idea and can also click a part of it and say what to change ("make this shorter", "mention the free trial"). Those notes
-- travel with the pick, and the scheduled run that builds it follows them. Each note is { "part": "<label of the part, or null for the whole idea>", "text": "<what to change>" }.
ALTER TABLE content_picks ADD COLUMN IF NOT EXISTS notes JSONB NOT NULL DEFAULT '[]'::jsonb;
