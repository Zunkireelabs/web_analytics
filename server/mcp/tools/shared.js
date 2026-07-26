import { z } from 'zod';
import { atLeast } from '../permissions.js';

export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// Defense-in-depth re-check for a gated tool's handler — never trusted to
// be dead code just because the tool wasn't registered for a lower tier.
// See server/mcp/permissions.js for tier ordering.
export function requireLevel(permissionLevel, min) {
  if (atLeast(permissionLevel, min)) return null;
  return { isError: true, content: [{ type: 'text', text: `This tool requires "${min}" permission or higher.` }] };
}

// Converts a thrown httpError (server/routes/action-center.js's `.status`
// + reason/confidence/suggestedMode/draftStatus convention) into an MCP
// tool error result carrying the same fields — mirrors that file's own
// sendHttpError for the HTTP side, so both surfaces report identical detail
// for the same failure.
export function errorResult(e) {
  const body = { error: e.message };
  if (e.reason !== undefined) body.reason = e.reason;
  if (e.confidence !== undefined) body.confidence = e.confidence;
  if (e.suggestedMode !== undefined) body.suggestedMode = e.suggestedMode;
  if (e.draftStatus !== undefined) body.status = e.draftStatus;
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}

// Wraps every tool handler registered in this app. Without this, an
// exception that ISN'T one of our own httpErrors (a raw DB error, a
// third-party SDK error, anything unexpected) reaches the MCP SDK's own
// top-level catch (node_modules/@modelcontextprotocol/sdk/dist/esm/server/
// mcp.js), which forwards `error.message` verbatim to whichever AI client/
// provider is connected — there is no generic-message fallback at that
// layer. That's a real gap versus the HTTP surface, whose global error
// handler (server/index.js) always replies with a fixed "Internal server
// error" and logs the real message server-side only. This closes the same
// gap for MCP: a recognized httpError (`.status` set) still reports its
// full detail via errorResult, exactly as before; anything else is logged
// here with full detail and reported to the client as a generic message.
export function withErrorHandling(toolName, handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e.status) return errorResult(e);
      console.error(`[mcp] tool "${toolName}" failed:`, e);
      return { isError: true, content: [{ type: 'text', text: 'Internal server error.' }] };
    }
  };
}
