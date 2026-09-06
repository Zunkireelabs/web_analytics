# MCP (Model Context Protocol) Integration Plan — Zunkiree Analytics

**Status: planning only — nothing in this document has been built yet.**
No code, migrations, or dependencies described here exist in the repo. This
file is a design/reference doc, not a changelog.

---

## 1. What MCP is

Model Context Protocol is an open standard (created by Anthropic, now also
supported by OpenAI, Google, and most AI tooling) for connecting an AI
application to external tools and data through one common interface —
instead of every AI app needing its own custom integration with every
external system. An MCP **server** exposes:

- **Tools** — functions the model can call (e.g. `get_series(start, end)`).
- **Resources** — readable data pulled into the model's context.
- **Prompts** — reusable prompt templates.

An MCP server can run two ways:
- **stdio (local)** — the AI client spawns the server as a local process.
  This requires having the codebase on the machine running the client.
- **Streamable HTTP (remote)** — the server runs at a URL; any MCP client
  anywhere connects with a bearer token, no local code required.

Since the goal here is letting people use this platform **without having
the codebase**, this plan uses the remote/Streamable HTTP shape: one new
endpoint on the existing Express app, not a separate service.

## 2. Why build this

- **Clients** get natural-language access to their own analytics and AI
  Growth agents directly from whatever AI app they already use (Claude,
  ChatGPT, etc.) — "what were my top query gainers last week" — without
  opening the dashboard.
- **Internal team** gets an ops console via Claude Code/Desktop — run an
  agent, check status, refresh a report, across any client, from chat.
- It's additive, not a rewrite: every tool is a thin wrapper around code
  that already exists (`server/store/read.js`, `server/agents/registry.js`
  + `runner.js`, Action Center's draft/PR functions). No existing route,
  table, or session-auth flow changes.

## 3. Two risks worth keeping distinct (this shaped the design below)

1. **Data reaching a third-party LLM provider.** If a client uses ChatGPT
   instead of Claude, their report data enters OpenAI's context the moment
   *any* tool is called — read or write. This is inherent to using MCP with
   any given client/provider; no token setting prevents it.
2. **An AI autonomously taking a write action** — generating a draft,
   pushing a branch, opening a real GitHub PR. This is a control/safety
   risk, and it **is** something access control can prevent.

This is why tokens get a **scope** (below) rather than being all-or-nothing.

## 4. Confirmed scope

- **Audience**: every onboarded client, not just internal staff. Each
  token maps to exactly one `site_id`, matching the existing multi-tenant
  model (one Postgres instance, many isolated clients).
- **Tool scope**: the full surface exists (read-only analytics, on-demand
  AI agent runs, and the full Action Center draft/PR lifecycle), but each
  **token** is scoped to either:
  - `read_only` (default) — analytics + agent/Action Center status reads
    only. Zero LLM spend beyond what's already read-only, zero external
    side effects.
  - `full` — everything, including triggering agent runs, generating
    drafts, pushing branches, and opening real GitHub PRs.
  A `read_only` token never has the mutating tools registered, regardless
  of which AI client or provider is using it — enforced twice (hidden from
  the tool list, and re-checked inside each mutating handler).

## 5. Implementation plan

### 5.1 New dependencies
```
npm install @modelcontextprotocol/sdk zod
```
Neither exists in `package.json` today. `zod` is required by the SDK for
per-tool input schemas.

### 5.2 New migration: `server/migrations/053_api_tokens.sql`
Highest existing migration is `052_drop_duplicate_commoncrawl_tables.sql`.
Follows the repo's `CREATE TABLE IF NOT EXISTS` convention (no
migration-tracking table, safe to re-run):

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
  id            SERIAL PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT 'MCP token',
  scope         TEXT NOT NULL DEFAULT 'read_only' CHECK (scope IN ('read_only', 'full')),
  token_hash    TEXT NOT NULL UNIQUE,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_site ON api_tokens (site_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash_active ON api_tokens (token_hash) WHERE revoked_at IS NULL;
```

`token_hash` is **SHA-256, not bcrypt**: these are high-entropy 256-bit
random secrets, not human passwords. Bcrypt's deliberately-slow hashing
defends against brute-forcing a low-entropy guessable password — irrelevant
here, and it would add ~100ms+ to every MCP call. SHA-256 gives fast
deterministic lookup while still making a stolen DB dump non-reusable.

### 5.3 New store module: `server/store/api-tokens.js`
Same shape as `server/store/users.js` — thin, query-only, all scoped by
`site_id`:
- `createApiToken(siteId, name, scope)` — `scope` defaults to `'read_only'`
  (safest default; a client must explicitly opt into `'full'`). Generates
  `zkr_mcp_<64 hex chars>` (`crypto.randomBytes(32)`), inserts the SHA-256
  hash, returns `{ id, name, scope, created_at, token }` — plaintext
  returned once, never stored or logged.
- `listApiTokens(siteId)` — metadata including `scope`, never the hash or
  plaintext.
- `revokeApiToken(siteId, id)` — sets `revoked_at`, scoped to own site.
- `getSiteIdForToken(plaintextToken)` — hashes, looks up
  `WHERE token_hash = $1 AND revoked_at IS NULL`, returns
  `{ site_id, id, scope }`. The only function MCP auth calls.
- `touchApiTokenLastUsed(id)` — fire-and-forget, never awaited on the
  request path.

### 5.4 New self-serve token routes: `server/routes/mcp-tokens.js`
Reuses the existing session-based `requireAuth` from
`server/routes/login.js` — a logged-in client already has a verified
`req.siteId`, so no separate internal-only issuance flow is needed:
- `POST /api/mcp-tokens` — `{ name?, scope? }` → `createApiToken(...)`,
  returns the token once.
- `GET /api/mcp-tokens` — list own tokens' metadata.
- `DELETE /api/mcp-tokens/:id` — revoke, scoped to `req.siteId`.

Mount in `server/index.js` grouped with the other `requireAuth`-only
routers, before the internal-only `copilotRouter` line.

### 5.5 New MCP bearer-auth middleware: `server/mcp/auth.js`
The **only** place site scoping and permission scope originate for MCP
requests:

```js
export async function requireMcpAuth(req, res, next) {
  const match = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Missing bearer token.' });
  const row = await getSiteIdForToken(match[1]).catch(() => null);
  if (!row) return res.status(401).json({ error: 'Invalid or revoked token.' });
  req.siteId = row.site_id;   // the ONLY origin of siteId for MCP requests
  req.mcpScope = row.scope;   // the ONLY origin of scope for MCP requests
  touchApiTokenLastUsed(row.id).catch(() => {});
  next();
}
```

Does not read `req.session` (no cookie exists for an MCP client) and does
not accept a `siteId`/`site`/`scope` argument from anywhere in the
request — both the tenant and the permission level are fixed by which
token was presented, never negotiable by the calling AI client.

### 5.6 New MCP tool registration: `server/mcp/tools.js`
`buildMcpServer(siteId, scope)` — a factory called fresh per request (see
5.7), registering tools below. Each handler closes over `siteId`/`scope`
from the factory arguments (**not** a zod-validated tool argument — an LLM
client can never override which site or permission level it's scoped to)
and calls the exact same store/registry/runner/generator function the
corresponding HTTP route already calls. No business logic is duplicated.

**Scope gating, defense in depth**: mutating tools are only registered on
the `McpServer` instance at all when `scope === 'full'`. Each mutating
handler *also* re-checks `scope === 'full'` at the top and throws an MCP
tool error otherwise, so a future refactor that accidentally registers a
tool unconditionally still fails closed rather than open.

**Available on BOTH `read_only` and `full` tokens** — pure reads, zero
external side effects:
- Analytics (wrap `server/store/read.js` + `metrics.js`): `list_sites`,
  `get_report_summary`, `get_date_range`, `get_series`, `get_channels`,
  `get_breakdown`, `get_device_breakdown`, `get_country_breakdown`,
  `get_movers`, `translate_query`, `compare_months`, `compare_range`,
  `ai_compare_months`, `ai_compare_range`.
- Agent/Action Center status (read-only views): `list_agents`,
  `get_agent_status`, `get_agent_activity`, `get_agent_runs`,
  `get_command_center`, `get_agentic_stats`, `get_recommendations`,
  `list_generators`, `list_drafts`, `get_draft`.

**Available ONLY on `full` tokens** — triggers a fresh LLM run, spends
compute/API budget, or writes to GitHub:
- `run_agent` (→ `runAgent(id, { siteId, start, end, params })` per the
  `AgentInput` contract in `server/agents/types.js`),
  `refresh_command_center`, `refresh_recommendations`.
- Action Center draft/PR lifecycle (wraps `server/store/drafts.js`,
  `server/generators/*`, `server/github/client.js`): `generate_draft`,
  `update_draft`, `delete_draft`, `submit_draft`, `approve_draft`,
  `push_draft_branch` (pushes a real git branch), `open_draft_pr` (opens a
  real GitHub PR), `check_pr_status`, `mark_draft_implemented`,
  `rollback_draft`.

### 5.7 New MCP HTTP route: `server/routes/mcp.js`
```js
router.post('/mcp', requireMcpAuth, async (req, res) => {
  const server = buildMcpServer(req.siteId, req.mcpScope);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```
Stateless mode (`sessionIdGenerator: undefined`) — no in-memory MCP session
store needed, since every tool call is a discrete request/response (unlike
`agents/live`'s long-lived SSE feed). `req.body` is already parsed by the
global `express.json()` middleware. Express req/res work directly with the
SDK since they extend Node's http primitives.

`server/index.js` changes: import and mount `mcpTokensRouter` and
`mcpRouter` under `app.use('/api', ...)`, grouped with the other
`requireAuth`-scoped routers, before the internal-only block.

### 5.8 Frontend: self-serve token management
- **New page** `web/src/pages/Settings.jsx` at route `/settings` — uses
  the existing `PageHeader` convention, renders `McpTokensCard`.
- **New component** `web/src/components/McpTokensCard.jsx`:
  - Lists tokens via `api.mcpTokens.list()`, showing each one's scope.
  - "Generate token" → a scope choice (radio, defaulting to **Reports
    only**): *"Reports only — this key can read your analytics and agent
    status, nothing else"* vs *"Full access — also allows generating
    content drafts and opening real GitHub pull requests."* Then shows the
    plaintext once in a copy-to-clipboard box with matching warning copy.
  - Revoke button per token, with a confirm dialog (matches existing
    destructive-action patterns like draft delete).
  - A static "how to connect" panel with copyable snippets for Claude Code
    (`claude mcp add --transport http ...`) and Claude Desktop/Claude.ai's
    remote-connector JSON config.
- **`web/src/api.js`**: add an `mcpTokens` group (`list`/`create`/`revoke`)
  using the existing `req()` wrapper.
- **`web/src/App.jsx`**: add the `/settings` route inside the existing
  `<Routes>` block, no `isInternal` gate (every client gets this).
- **`web/src/components/Sidebar.jsx`**: add `{ to: '/settings', label:
  'Settings', icon: Settings }` to the base `NAV` array (`Settings` icon
  from `lucide-react`, already a dependency).

## 6. Security notes (document, don't block v1 on)

- **Scoping controls write actions, not data exposure.** Even a
  `read_only` token sends report data into whatever AI client/provider is
  calling it — that's inherent to how any MCP client works, not something
  a token setting can prevent. State this plainly in the Settings page
  copy so clients don't mistake "Reports only" for "nothing leaves our
  servers."
- **A `full` token = site-scoped access including PR-opening.** State this
  in the generate-token UI copy and in a comment atop `server/mcp/auth.js`.
- **No rate limiting exists anywhere in this app today.** A misbehaving
  MCP client could call `run_agent`/`generate_draft`/`open_draft_pr` far
  faster than a human clicking a dashboard button. Recommend a small
  in-memory per-token sliding-window limiter inside `requireMcpAuth` (e.g.
  30 req/min) — acceptable given this app has no horizontal scaling today.
  If deferred, track it explicitly as a known gap.
- **Revocation is immediate** — `getSiteIdForToken` checks
  `revoked_at IS NULL` on every call, no caching layer. Keep it that way.

## 7. Verification plan

1. `npm run migrate` — confirms `053_api_tokens.sql` applies cleanly.
2. Mint a token via the Settings UI (or `curl -X POST /api/mcp-tokens`
   with a session cookie) — confirm plaintext returned once, never again
   on a follow-up `GET`.
3. Connect a real client, e.g. Claude Code:
   `claude mcp add --transport http zunkiree-analytics-local
   http://localhost:3002/api/mcp --header "Authorization: Bearer <token>"`.
4. Call a read tool (`get_series` or `list_sites`) and confirm the data
   matches what the session-authed HTTP route returns for the same site.
5. Call `run_agent` (with a `full` token) and confirm the response matches
   `POST /api/agents/:id/run`'s shape, and a new row appears in
   `agent_runs`.
6. **Cross-tenant isolation check**: mint a second token for a different
   site, call the same tool, confirm it returns the second site's data
   only — no tool argument can override this.
7. Revoke a token, immediately retry a call with it, confirm `401` with no
   propagation delay.
8. **Scope check**: connect with a `read_only` token and confirm
   `generate_draft`/`run_agent`/etc. don't appear in the tool list; attempt
   one directly anyway (bypassing the client's own UI) and confirm the
   server rejects it — proves the defense-in-depth check, not just the
   listing.
9. Optional: with a `full` token, `generate_draft` for a low-risk generator
   and confirm a new `drafts` row — skip `push_draft_branch`/`open_draft_pr`
   unless a disposable test repo is set up, since those touch a real
   GitHub remote.

### Critical files
- `server/mcp/auth.js` (new)
- `server/mcp/tools.js` (new)
- `server/routes/mcp.js` (new)
- `server/routes/mcp-tokens.js` (new)
- `server/store/api-tokens.js` (new)
- `server/migrations/053_api_tokens.sql` (new)
- `server/index.js` (mount new routers)
- `web/src/pages/Settings.jsx`, `web/src/components/McpTokensCard.jsx` (new)
- `web/src/api.js`, `web/src/App.jsx`, `web/src/components/Sidebar.jsx` (edits)
