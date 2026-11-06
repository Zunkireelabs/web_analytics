import { query, pool } from '../db.js';
import { encryptSecret, decryptSecret, secretBoxConfigured } from '../lib/secret-box.js';
import { refreshAccessToken } from '../integrations/posthog-connect.js';

// Each project's own optional PostHog connection (migration 239). Same discipline as project-google.js: the
// credential is encrypted at rest and NEVER returned by the read a UI calls — a screen needs to know a connection
// exists and whether it works, never the key itself.

/** What the connection screen may see. Deliberately no key or token, encrypted or otherwise. */
export async function getPosthogConnection(siteId) {
  const { rows } = await query(
    `SELECT project_id, project_name, host, auth_method, connected_email, connected_by, status, status_error, status_at, created_at, updated_at
       FROM project_posthog_connections WHERE site_id = $1`,
    [siteId]
  );
  const r = rows[0];
  if (!r) return null;
  // `pending`: signed in on PostHog but has not yet chosen which PostHog project is this website.
  return { ...r, method: r.auth_method, pending: r.project_id == null };
}

/** The non-secret state any project MEMBER may read (the Overview decides what to show from it). */
export async function getPosthogConnectionState(siteId) {
  const { rows } = await query('SELECT project_id, status FROM project_posthog_connections WHERE site_id = $1', [siteId]);
  const r = rows[0];
  return { connected: Boolean(r && r.project_id != null), status: r && r.project_id != null ? r.status : null };
}

// Run fn(client) in one transaction. The connection row and the days stored for it must change together: a half-done switch
// would leave one project's data under another project's name.
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// What the stored days belong to. A row from before data_key existed is read from its own host and project.
const dataKeyOf = (row) => (row ? (row.data_key ?? (row.project_id ? `${row.host}|${row.project_id}` : null)) : null);

// Days stored for a PostHog project that is no longer the chosen one would be shown as the new project's, and mixed with its
// days. They are cleared the moment the project or host changes (and when the connection goes), not left to be noticed.
async function clearDaysIfSourceChanged(client, siteId, previousKey, newKey) {
  if (previousKey && previousKey !== newKey) await client.query('DELETE FROM posthog_daily WHERE site_id = $1', [siteId]);
}

export async function savePosthogConnection(siteId, { projectId, host, apiKey, connectedBy = null }) {
  if (!secretBoxConfigured()) {
    // Refusing is the only safe answer: storing the key in plaintext because the server is misconfigured would be a
    // silent, permanent leak of a client credential.
    throw new Error('SECRETS_ENCRYPTION_KEY is not set on this server, so a PostHog key cannot be stored safely.');
  }
  const trimmedProject = String(projectId || '').trim();
  const trimmedKey = String(apiKey || '').trim();
  if (!trimmedProject) throw new Error('A PostHog project ID is required.');
  if (!trimmedKey) throw new Error('A PostHog personal API key is required.');
  const normalizedHost = normalizeHost(host);
  const newKey = `${normalizedHost}|${trimmedProject}`;

  return inTransaction(async (client) => {
    const { rows: before } = await client.query('SELECT host, project_id, data_key FROM project_posthog_connections WHERE site_id = $1 FOR UPDATE', [siteId]);
    await clearDaysIfSourceChanged(client, siteId, dataKeyOf(before[0]), newKey);
    const { rows } = await client.query(
      `INSERT INTO project_posthog_connections (site_id, project_id, host, api_key_enc, connected_by, status, status_at, auth_method, data_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', now(), 'key', $6)
       ON CONFLICT (site_id) DO UPDATE SET
         project_id = EXCLUDED.project_id, host = EXCLUDED.host, api_key_enc = EXCLUDED.api_key_enc, data_key = EXCLUDED.data_key,
         -- A pasted key replaces any sign-in: leaving the old tokens beside it would leave two live credentials.
         auth_method = 'key', refresh_token_enc = NULL, access_token_enc = NULL, access_expires_at = NULL, scopes = NULL,
         oauth_client_id = NULL, connected_email = NULL, project_name = NULL,
         connected_by = COALESCE(EXCLUDED.connected_by, project_posthog_connections.connected_by),
         -- A re-connect resets the verdict: a new key has not been checked yet, and carrying the old 'ok' forward
         -- would show a working connection that may not be.
         status = 'pending', status_error = NULL, status_at = now(), updated_at = now()
       RETURNING project_id, host, status`,
      [siteId, trimmedProject, normalizedHost, encryptSecret(trimmedKey), connectedBy, newKey]
    );
    return rows[0];
  });
}

// ── OAuth sign-in (migration 244) ───────────────────────────────────────────

/** Store the grant from "Connect with PostHog". No project yet: the person picks one next. */
export async function saveOauthSignIn(siteId, { host, clientId, tokens, email = null, connectedBy = null }) {
  if (!secretBoxConfigured()) {
    throw new Error('SECRETS_ENCRYPTION_KEY is not set on this server, so a PostHog sign-in cannot be stored safely.');
  }
  if (!tokens?.refreshToken || !tokens?.accessToken) throw new Error('A PostHog sign-in needs both an access and a refresh token.');
  const { rows } = await query(
    `INSERT INTO project_posthog_connections
       (site_id, project_id, project_name, host, api_key_enc, auth_method, refresh_token_enc, access_token_enc, access_expires_at,
        scopes, oauth_client_id, connected_email, connected_by, status, status_at)
     VALUES ($1, NULL, NULL, $2, NULL, 'oauth', $3, $4, $5, $6, $7, $8, $9, 'pending', now())
     ON CONFLICT (site_id) DO UPDATE SET
       -- A new sign-in is a new account until proven otherwise: the project chosen for the old one is not known to be
       -- readable by this one, so it is chosen again, and the verdict resets.
       project_id = NULL, project_name = NULL, host = EXCLUDED.host, api_key_enc = NULL, auth_method = 'oauth',
       refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_enc = EXCLUDED.access_token_enc,
       access_expires_at = EXCLUDED.access_expires_at, scopes = EXCLUDED.scopes, oauth_client_id = EXCLUDED.oauth_client_id,
       connected_email = EXCLUDED.connected_email,
       connected_by = COALESCE(EXCLUDED.connected_by, project_posthog_connections.connected_by),
       status = 'pending', status_error = NULL, status_at = now(), updated_at = now()
     RETURNING host, auth_method`,
    [siteId, normalizeHost(host), encryptSecret(tokens.refreshToken), encryptSecret(tokens.accessToken), tokens.expiresAt,
      (tokens.scopes || []).join(' '), clientId, email, connectedBy]
  );
  return rows[0];
}

/** The person chose which PostHog project is this website. Choosing a DIFFERENT project (or host) clears the old one's days. */
export async function selectOauthProject(siteId, { projectId, projectName = null }) {
  const id = String(projectId || '').trim();
  if (!id) throw new Error('A PostHog project is required.');
  return inTransaction(async (client) => {
    const { rows: before } = await client.query(
      "SELECT host, project_id, data_key FROM project_posthog_connections WHERE site_id = $1 AND auth_method = 'oauth' FOR UPDATE", [siteId]);
    if (!before[0]) return null;
    const newKey = `${before[0].host}|${id}`;
    await clearDaysIfSourceChanged(client, siteId, dataKeyOf(before[0]), newKey);
    const { rows } = await client.query(
      `UPDATE project_posthog_connections
          SET project_id = $2, project_name = $3, data_key = $4, status = 'pending', status_error = NULL, status_at = now(), updated_at = now()
        WHERE site_id = $1 AND auth_method = 'oauth'
      RETURNING project_id, project_name, host`,
      [siteId, id, projectName ? String(projectName).slice(0, 200) : null, newKey]
    );
    return rows[0] || null;
  });
}

const REFRESH_EARLY_MS = 120 * 1000;
const REVOKED_MESSAGE = 'PostHog access was revoked or has expired. Reconnect PostHog to keep this project\'s data up to date.';

/**
 * A usable access token for an OAuth connection, refreshing it when it is close to expiring.
 *
 * The row is locked while refreshing: PostHog may rotate the refresh token, so two processes (the web app and the nightly
 * job) refreshing at once with the same one would leave one of them holding a dead token. The second waits, then finds a
 * fresh token already stored and uses that.
 *
 * Returns { ok:true, host, projectId, accessToken } or { ok:false, reason, detail }. NEVER throws for a PostHog-side
 * failure (revoked, unreachable): the ingest loop also serves every other project. A revoked grant is also written to the
 * connection as status 'error' with a plain message, which is what the connection screen shows.
 */
export async function getFreshPosthogAccess(siteId, { fetchImpl = fetch, now = Date.now(), refresh = refreshAccessToken } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT project_id, host, auth_method, refresh_token_enc, access_token_enc, access_expires_at, oauth_client_id
         FROM project_posthog_connections WHERE site_id = $1 FOR UPDATE`, [siteId]);
    const r = rows[0];
    if (!r || r.auth_method !== 'oauth') { await client.query('ROLLBACK'); return { ok: false, reason: 'not_connected' }; }

    const expires = r.access_expires_at ? new Date(r.access_expires_at).getTime() : 0;
    if (r.access_token_enc && expires - now > REFRESH_EARLY_MS) {
      await client.query('COMMIT');
      return { ok: true, host: r.host, projectId: r.project_id, accessToken: decryptSecret(r.access_token_enc) };
    }

    const out = await refresh({ host: r.host, refreshToken: decryptSecret(r.refresh_token_enc), clientId: r.oauth_client_id }, { fetchImpl, now });
    if (!out.ok) {
      if (out.reason === 'unauthorized') {
        await client.query(
          `UPDATE project_posthog_connections SET status = 'error', status_error = $2, status_at = now(), updated_at = now() WHERE site_id = $1`,
          [siteId, REVOKED_MESSAGE]);
      }
      await client.query('COMMIT');
      return { ok: false, reason: out.reason, detail: out.reason === 'unauthorized' ? REVOKED_MESSAGE : (out.detail || 'PostHog could not be reached.') };
    }
    await client.query(
      `UPDATE project_posthog_connections
          SET access_token_enc = $2, access_expires_at = $3, refresh_token_enc = $4, updated_at = now()
        WHERE site_id = $1`,
      [siteId, encryptSecret(out.accessToken), out.expiresAt, encryptSecret(out.refreshToken)]);
    await client.query('COMMIT');
    return { ok: true, host: r.host, projectId: r.project_id, accessToken: out.accessToken };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, reason: 'failed', detail: err.message };
  } finally {
    client.release();
  }
}

/**
 * The credential, for the ingest path only. Returns null when the project has no usable connection (normal), or — for a
 * sign-in that cannot be used right now — an object carrying `authError` so the caller reports the real reason instead of
 * "not connected". The shape is the same for a pasted key and for a sign-in: `apiKey` is whatever goes after "Bearer".
 */
export async function getPosthogCredentials(siteId, opts = {}) {
  const { rows } = await query(
    'SELECT project_id, host, auth_method, api_key_enc FROM project_posthog_connections WHERE site_id = $1',
    [siteId]
  );
  const r = rows[0];
  if (!r || r.project_id == null) return null; // none, or signed in but no project chosen yet
  if (r.auth_method !== 'oauth') return { projectId: r.project_id, host: r.host, apiKey: decryptSecret(r.api_key_enc) };

  const fresh = await getFreshPosthogAccess(siteId, opts);
  if (!fresh.ok) return { projectId: r.project_id, host: r.host, apiKey: null, authError: { reason: fresh.reason, detail: fresh.detail } };
  return { projectId: r.project_id, host: r.host, apiKey: fresh.accessToken };
}

/** What revoking at PostHog needs, read BEFORE the row is deleted. Null when there is no sign-in to revoke. */
export async function getPosthogRevokeInfo(siteId) {
  const { rows } = await query(
    "SELECT host, refresh_token_enc, oauth_client_id FROM project_posthog_connections WHERE site_id = $1 AND auth_method = 'oauth'", [siteId]);
  const r = rows[0];
  if (!r?.refresh_token_enc) return null;
  try { return { host: r.host, token: decryptSecret(r.refresh_token_enc), clientId: r.oauth_client_id }; } catch { return null; }
}

export async function recordPosthogStatus(siteId, ok, error = null) {
  await query(
    `UPDATE project_posthog_connections
        SET status = $2, status_error = $3, status_at = now(), updated_at = now()
      WHERE site_id = $1`,
    [siteId, ok ? 'ok' : 'error', ok ? null : String(error || '').slice(0, 500)]
  );
}

// A failure that says something about the CONNECTION (the key or grant was refused, the project or address cannot be used) marks
// it 'error' and stops the nightly job until it is fixed. A failure that says something about tonight (a timeout, an HTTP 5xx,
// a rate limit, PostHog being down) must not: it changes nothing and is simply retried the next night.
const PERMANENT_FAILURES = new Set(['unauthorized', 'project_not_found', 'bad_host']);
export const isPermanentPosthogFailure = (reason) => PERMANENT_FAILURES.has(reason);

/** Record a failed attempt. Returns true when it marked the connection as an error, false when it left the status alone. */
export async function recordPosthogFailure(siteId, reason, detail) {
  if (!isPermanentPosthogFailure(reason)) return false;
  await recordPosthogStatus(siteId, false, detail || reason);
  return true;
}

export async function deletePosthogConnection(siteId) {
  // The days go with the connection: left behind, they would keep appearing on the Overview and in reports of a project that
  // is no longer connected, and be mixed with a different PostHog project's if one is connected later.
  return inTransaction(async (client) => {
    await client.query('DELETE FROM posthog_daily WHERE site_id = $1', [siteId]);
    const { rowCount } = await client.query('DELETE FROM project_posthog_connections WHERE site_id = $1', [siteId]);
    return rowCount > 0;
  });
}

export async function listPosthogConnectedSites() {
  const { rows } = await query(
    `SELECT s.id, s.name, s.timezone, c.project_id, c.host, c.status
       FROM project_posthog_connections c
       JOIN sites s ON s.id = c.site_id
      WHERE c.status <> 'error' AND c.project_id IS NOT NULL
      ORDER BY s.id`
  );
  return rows;
}

// A self-hosted or EU instance is a different host; a trailing slash or a missing scheme would otherwise produce a
// URL that silently fetches nothing.
function normalizeHost(host) {
  const raw = String(host || '').trim();
  if (!raw) return 'https://us.posthog.com';
  // https only: a credential is sent to this address. (The route also refuses loopback and private addresses; see
  // integrations/posthog-connect.js validatePosthogHost, which needs DNS and so cannot live in this synchronous helper.)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https:\/\//i.test(raw)) throw new Error('A PostHog address must use https.');
  const withScheme = /^https:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

// ── Daily metrics (migration 240) ───────────────────────────────────────────

// A metric PostHog did not return is stored as NULL, never 0: "nobody converted" and "we could not measure" are
// different facts. A re-fetch of the same day replaces it — PostHog backfills late events, so a later read of the
// same date is the better number, not a duplicate.
export async function upsertPosthogDay(siteId, { date, totals = {}, dropOffs = [], topActions = [] }) {
  const { rows } = await query(
    // Written only while a project is connected: a fetch that finishes after a disconnect must not bring the data back.
    `INSERT INTO posthog_daily (site_id, date, events, people, pageviews, sessions, drop_offs, top_actions, fetched_at)
     SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, now()
      WHERE ${LIVE_CONNECTION_SQL}
     ON CONFLICT (site_id, date) DO UPDATE SET
       events = EXCLUDED.events, people = EXCLUDED.people,
       pageviews = EXCLUDED.pageviews, sessions = EXCLUDED.sessions,
       -- Drop-offs and actions are only replaced when the new fetch actually found some, so a day whose query failed
       -- does not erase a good earlier result for the same date.
       drop_offs = CASE WHEN jsonb_array_length(EXCLUDED.drop_offs) > 0 THEN EXCLUDED.drop_offs ELSE posthog_daily.drop_offs END,
       top_actions = CASE WHEN jsonb_array_length(EXCLUDED.top_actions) > 0 THEN EXCLUDED.top_actions ELSE posthog_daily.top_actions END,
       fetched_at = now()
     RETURNING site_id, date`,
    [siteId, date, nullableInt(totals.events), nullableInt(totals.people), nullableInt(totals.pageviews),
      nullableInt(totals.sessions), JSON.stringify(dropOffs || []), JSON.stringify(topActions || [])]
  );
  return rows[0];
}

// Reads only ever show a CONNECTED project's days. Without this, anything left behind by a disconnect, a switch of project, or
// a half-finished sign-in would keep being shown as if it were current.
const LIVE_CONNECTION_SQL = 'EXISTS (SELECT 1 FROM project_posthog_connections c WHERE c.site_id = $1 AND c.project_id IS NOT NULL)';

export async function getPosthogRange(siteId, start, end) {
  const { rows } = await query(
    `SELECT date, events, people, pageviews, sessions, drop_offs, top_actions, fetched_at
       FROM posthog_daily
      WHERE site_id = $1 AND date BETWEEN $2 AND $3 AND ${LIVE_CONNECTION_SQL}
      ORDER BY date`,
    [siteId, start, end]
  );
  return rows;
}

// Range totals, plus the drop-offs and the most-used actions added up across the period. SUM ignores NULLs, so a day
// PostHog could not measure lowers nothing — and `measured_days` says how many days the total actually covers, which is
// what stops a partial period reading as a complete one. Works for ANY range, so the previous period is the same call.
export async function getPosthogSummary(siteId, start, end) {
  const { rows } = await query(
    `SELECT COUNT(*)::int                              AS days,
            COUNT(events)::int                         AS measured_days,
            SUM(events)::int                           AS events,
            SUM(pageviews)::int                        AS pageviews,
            SUM(sessions)::int                         AS sessions,
            MAX(people)::int                           AS peak_daily_people
       FROM posthog_daily
      WHERE site_id = $1 AND date BETWEEN $2 AND $3 AND ${LIVE_CONNECTION_SQL}`,
    [siteId, start, end]
  );
  const summary = rows[0] || {};
  if (!summary.days) return null; // no PostHog data for this range: a normal state for an unconnected project

  // People cannot be summed across days — the same person visiting twice is one person, and adding daily counts
  // would double-count them. The peak day is reported instead, labelled as such.
  const { rows: tops } = await query(
    `SELECT d.event, SUM(COALESCE(d."sessionsEndingHere", 0))::int AS sessions_ending_here
       FROM posthog_daily p
       CROSS JOIN LATERAL jsonb_to_recordset(p.drop_offs) AS d(event text, "sessionsEndingHere" int)
      WHERE p.site_id = $1 AND p.date BETWEEN $2 AND $3 AND d.event IS NOT NULL
      GROUP BY d.event
      ORDER BY sessions_ending_here DESC
      LIMIT 10`,
    [siteId, start, end]
  ).catch(() => ({ rows: [] }));

  // The same label on different days is the same action, so it is added up by label. `raw` is the event name for a custom
  // event (null for a click, which has no name of its own).
  const { rows: actions } = await query(
    `SELECT d.label, MAX(d.raw) AS raw, SUM(COALESCE(d.times, 0))::int AS times
       FROM posthog_daily p
       CROSS JOIN LATERAL jsonb_to_recordset(p.top_actions) AS d(label text, raw text, times int)
      WHERE p.site_id = $1 AND p.date BETWEEN $2 AND $3 AND d.label IS NOT NULL
      GROUP BY d.label
      ORDER BY times DESC, d.label
      LIMIT 10`,
    [siteId, start, end]
  ).catch(() => ({ rows: [] }));

  // Per-day points for the Overview chart. A day with no row is simply absent (not zero), a metric PostHog did not return
  // is null, and people is the day's own distinct count (never summed).
  const { rows: series } = await query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, pageviews, sessions, events, people
       FROM posthog_daily WHERE site_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date`,
    [siteId, start, end]
  );

  return { ...summary, topDropOffs: tops, topActions: actions, series };
}

const nullableInt = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
