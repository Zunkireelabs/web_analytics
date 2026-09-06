-- Per-site Sanity write credential, following the same indirection
-- github_pat_env_var established in 028: the column holds the NAME of an env
-- var, never a secret value. No credential material is ever stored in this
-- database.
--
-- Deliberately has NO default, unlike github_pat_env_var's 'GITHUB_PAT'.
-- That default made sense when one repo existed and a shared token was the
-- pragmatic answer; migration 106 then documented at length why it doesn't
-- scale, and server/github/credentials.js records the security cost directly:
-- a silent fallback to a shared credential "would let a misconfigured deploy
-- authenticate tenant B's repo with tenant A's credential."
--
-- A Sanity token is scoped to one project and dataset, so a shared default is
-- not merely untidy here — it would be a token for somebody else's content.
-- NULL means "this site has no Sanity write capability", and
-- server/sanity/credentials.js fails closed on it rather than reaching for
-- anything global. Failing to find a credential is recoverable and loud;
-- using the wrong tenant's is neither.
--
-- Project id and dataset are NOT stored here. They are per-URL-pattern
-- adapter config in sites.url_file_map (see resolveAdapter in
-- implementers/lib/url-file-map.js and the shape documented in
-- implementers/adapters/sanity-document.js), because a single site can
-- legitimately source different URL shapes from different datasets, and
-- because that is where every other adapter's own config already lives.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS sanity_write_token_env_var TEXT;

COMMENT ON COLUMN sites.sanity_write_token_env_var IS
  'Name of the env var holding this site''s Sanity write token — never the token itself. NULL means this site has no Sanity write capability; resolution fails closed rather than falling back to any shared credential (see server/sanity/credentials.js).';
