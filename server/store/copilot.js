import { query } from '../db.js';

export async function createConversation(siteId, title = null) {
  const { rows } = await query(
    'INSERT INTO copilot_conversations (site_id, title) VALUES ($1, $2) RETURNING id, site_id, title, created_at',
    [siteId, title]
  );
  return rows[0];
}

export async function listConversations(siteId, limit = 20) {
  const { rows } = await query(
    'SELECT id, title, created_at, updated_at FROM copilot_conversations WHERE site_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [siteId, limit]
  );
  return rows;
}

// Scoped to siteId so one client can never read (or post into) another
// client's conversation by guessing an id — same "trust the session, never
// a client-supplied site param" rule every other route in this app follows.
export async function getConversation(siteId, id) {
  const { rows } = await query(
    'SELECT id, site_id, title, created_at FROM copilot_conversations WHERE site_id = $1 AND id = $2',
    [siteId, id]
  );
  return rows[0] || null;
}

export async function saveMessage(conversationId, role, content, { citedFindingIds = [], followUps = [], agentIdsUsed = [] } = {}) {
  await query(
    `INSERT INTO copilot_messages (conversation_id, role, content, cited_finding_ids, follow_ups, agent_ids_used)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [conversationId, role, content, citedFindingIds, followUps, agentIdsUsed]
  );
  await query('UPDATE copilot_conversations SET updated_at = now() WHERE id = $1', [conversationId]);
}

export async function getMessages(conversationId, limit = 50) {
  const { rows } = await query(
    `SELECT id, role, content, cited_finding_ids, follow_ups, created_at
       FROM copilot_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [conversationId, limit]
  );
  return rows;
}

// Chronological (oldest first) — the shape callLLM's message-history context
// needs, unlike getMessages above which a UI would also use for display.
export async function getRecentMessages(conversationId, limit = 8) {
  const { rows } = await query(
    'SELECT role, content FROM copilot_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2',
    [conversationId, limit]
  );
  return rows.reverse();
}
