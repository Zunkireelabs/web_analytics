import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadOnlyTools } from './read-only.js';
import { registerAiActionsTools } from './ai-actions.js';
import { registerAutomationTools } from './automation.js';
import { registerAdminTools } from './admin.js';
import { registerResearchReadTools, registerResearchLiveTools } from './research.js';
import { atLeast } from '../permissions.js';

// buildMcpServer(siteId, permissionLevel, tokenId) — a fresh factory call
// per request (stateless mode, no connection setup to amortize). Read Only
// tools are always registered; AI Actions/Automation/Admin tiers register
// conditionally on permissionLevel. tokenId (the calling token's own id) is
// only used by the admin tier, to record provenance when it mints another
// token — see mcp-server/tools/admin.js.
export function buildMcpServer(siteId, permissionLevel, tokenId) {
  const server = new McpServer({ name: 'zunkiree-analytics', version: '1.0.0' });

  registerReadOnlyTools(server, siteId);
  // Research reads are stored-data reads like every other read-only tool, so they are always available. The LIVE
  // research tools each make a paid provider call, so they are gated to the automation tier and above — the same
  // boundary that already separates "look at our data" from "do something that has consequences".
  registerResearchReadTools(server, siteId);
  if (atLeast(permissionLevel, 'ai_actions')) {
    registerAiActionsTools(server, siteId, permissionLevel);
  }
  if (atLeast(permissionLevel, 'automation')) {
    registerAutomationTools(server, siteId, permissionLevel);
    registerResearchLiveTools(server, siteId);
  }
  if (atLeast(permissionLevel, 'admin')) {
    registerAdminTools(server, siteId, permissionLevel, tokenId);
  }

  return server;
}
