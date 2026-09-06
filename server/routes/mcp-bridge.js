import { Router } from 'express';

// Temporary migration bridge for the MCP-server split (see plan: "Split the
// MCP server onto its own subdomain"). The main app used to serve these
// paths directly; now the standalone MCP process (mcp-server/index.js) on
// MCP_DOMAIN does. Anything still hardcoded to the old URLs gets redirected
// transparently instead of 404ing.
//
// 307, not 301/302: those preserve HTTP method and body, which matters for
// POST /api/mcp's JSON-RPC calls — many HTTP clients silently turn a
// 301/302 POST into a GET, but 307 is spec-guaranteed not to.
//
// Remove this file and its two mounts in server/index.js once access logs
// (the console.warn below) show nothing hitting it anymore.
function bridge(path) {
  return (req, res) => {
    console.warn(`[mcp-bridge] redirecting stale ${path} request from ${req.ip}`);
    res.redirect(307, `https://${process.env.MCP_DOMAIN}${path}`);
  };
}

export const apiBridgeRouter = Router();
apiBridgeRouter.post('/mcp', bridge('/api/mcp'));

export const rootBridgeRouter = Router();
['/oauth/authorize', '/oauth/token', '/oauth/register', '/oauth/revoke'].forEach((path) =>
  rootBridgeRouter.all(path, bridge(path))
);
rootBridgeRouter.get('/.well-known/oauth-authorization-server', bridge('/.well-known/oauth-authorization-server'));
rootBridgeRouter.get('/.well-known/oauth-protected-resource/api/mcp', bridge('/.well-known/oauth-protected-resource/api/mcp'));
