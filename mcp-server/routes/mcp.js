import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireMcpToken } from '../auth.js';
import { buildMcpServer } from '../tools/index.js';

// Stateless mode (sessionIdGenerator: undefined) — every MCP tool call is a
// discrete request/response, same as every other route in this app, so
// there's no in-memory MCP session store to maintain. A fresh McpServer +
// transport pair per request is cheap: tool registration is just closures
// over siteId, no connection setup to amortize.
const router = Router();

router.post('/mcp', requireMcpToken, async (req, res, next) => {
  try {
    const server = buildMcpServer(req.mcpSiteId, req.mcpPermissionLevel, req.mcpTokenId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) { next(e); }
});

export default router;
