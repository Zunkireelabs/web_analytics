import 'dotenv/config';
import { createServer as createHttpServer } from 'node:http';
import express from 'express';
import mcpRouter from './routes/mcp.js';
import oauthRouter from './routes/oauth.js';

// Standalone MCP-only process (see plan: "Split the MCP server onto its own
// subdomain"). Lives in its own top-level folder, mcp-server/, sibling to
// server/ (the main dashboard app) and data-analyst-agent/ — same repo,
// same package.json/node_modules/deploy pipeline, but its own entrypoint and
// its own Docker service. It still reaches into server/ for shared business
// logic (store/, agents/, report/, db.js) via relative imports rather than
// duplicating any of it.
//
// Serves exactly the surface an MCP/OAuth client ever talks to directly:
// POST /api/mcp (mcp-server/routes/mcp.js) and the OAuth 2.1
// authorization-server endpoints + discovery docs (mcp-server/routes/oauth.js).
// Neither reads req.session — auth is 100% bearer-token
// (mcp-server/auth.js) or Postgres-backed OAuth grants
// (mcp-server/oauth-provider.js) — so this process deliberately runs with no
// express-session, no connect-pg-simple, no loginRouter, no SPA static
// serving, and none of server/index.js's cron/catchup/audit-reap startup
// work. The session-gated token-management UI (server/routes/mcp-tokens.js)
// and OAuth consent screen (server/routes/oauth-consent.js) stay on the main
// app, in server/.
const app = express();
app.set('trust proxy', 1); // behind Traefik — req.ip (requireMcpToken's rate
                            // limiter) and req.protocol/req.get('host')
                            // (oauth.js's well-known discovery docs) must
                            // reflect the real client, not Traefik's own IP.
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', mcpRouter); // POST /api/mcp
app.use(oauthRouter);        // /oauth/*, /.well-known/oauth-* (root-mounted, same as server/index.js today)

app.use((err, req, res, _next) => {
  console.error('[mcp-server] error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = Number(process.env.MCP_API_PORT || 3003);
const httpServer = createHttpServer(app);
httpServer.listen(port, () => {
  console.log(`[mcp-server] listening on :${port}`);
});
