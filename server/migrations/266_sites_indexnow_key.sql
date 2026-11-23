-- IndexNow (generators/indexnow.js, lib/indexnow.js): each project has ONE key. The key is also the name of the file the site serves at its
-- root (<key>.txt, containing the key), which is how the protocol proves the sender controls the host, so it must stay the same once the
-- file is live. The key is not a secret: it is published at the site root by design.
-- Additive and idempotent; no data statements.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS indexnow_key TEXT;
