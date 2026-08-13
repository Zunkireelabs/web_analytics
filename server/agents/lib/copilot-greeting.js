import { getUserById } from '../../store/users.js';
import { getSiteById } from '../../store/read.js';
import { getRecommendations } from './recommendation-coordinator.js';

// The Copilot's opening line, and the reason it differs by who is reading it.
//
// The Copilot is now client-facing (routes/copilot.js dropped its
// platform_admin-only gate), which means one chat surface is read by two
// audiences with genuinely different needs — not just different tones:
//
//   * A staff/platform admin wants operational state: what is queued, what is
//     blocked, what is waiting on them. They know what an agent is, and
//     naming one is useful signal rather than jargon.
//   * A client wants to know what happened on THEIR site and what to do next.
//     Agent ids, risk tiers, and draft lifecycle states are internal
//     vocabulary that would only make the product feel like someone else's
//     admin console.
//
// Everything below is derived from real persisted state (recommendations the
// coordinator has actually grounded) — never a generic "Welcome back!" with
// invented numbers. When there's genuinely nothing to report it says so,
// consistent with copilot.js's existing honest-gap discipline.

// Deliberately conservative: an email local-part is a poor human name
// ("info.zunkireelabs"), so it's only used when it plausibly reads as one.
// Otherwise the greeting simply drops the name rather than saying something
// that sounds wrong to the person reading it.
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  if (!local) return null;
  // Reject role addresses and anything that reads as a handle rather than a
  // name (digits, dots-as-separators beyond one, generic mailbox names).
  if (/^(info|admin|contact|hello|support|sales|team|noreply|no-reply|office)\b/i.test(local)) return null;
  if (/\d/.test(local)) return null;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

export function resolveDisplayName(user) {
  return user?.display_name?.trim() || nameFromEmail(user?.email) || null;
}

// One sentence of real, current state — the thing that makes this a greeting
// from something that has actually been working, rather than a chat box.
function summarize(items) {
  const open = items.length;
  const blocked = items.filter((i) => i.designBlockedReason).length;
  const highPriority = items.filter((i) => i.priority === 'high').length;
  return { open, blocked, highPriority, actionable: open - blocked };
}

// Up to three real things the reader could actually do next, drawn from their
// own open recommendations — never invented, and never a blocked item (which
// by definition cannot be actioned yet, see the design gate).
function suggestedActions(items, { isAdmin }) {
  return items
    .filter((i) => !i.designBlockedReason)
    .sort((a, b) => (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0))
    .slice(0, 3)
    .map((i) => (isAdmin
      ? `${i.tag} — ${i.params?.page || 'site-wide'} (${i.generatorId})`
      : `${i.tag}${i.params?.page ? ` on ${i.params.page}` : ''}`));
}

export async function buildGreeting({ siteId, userId }) {
  const [user, site, recs] = await Promise.all([
    userId ? getUserById(userId).catch(() => null) : null,
    getSiteById(siteId).catch(() => null),
    getRecommendations(siteId).catch(() => ({ items: [] })),
  ]);

  const isAdmin = user?.role === 'platform_admin';
  const name = resolveDisplayName(user);
  const siteLabel = site?.website_domain || site?.name || 'your site';
  const stats = summarize(recs.items || []);

  const hello = name ? `Hi ${name}` : 'Hi';

  let message;
  if (isAdmin) {
    // Operational framing: what needs a human, stated plainly.
    const parts = [];
    if (stats.actionable) parts.push(`${stats.actionable} open recommendation${stats.actionable === 1 ? '' : 's'} ready to action`);
    if (stats.blocked) parts.push(`${stats.blocked} blocked pending design verification`);
    message = parts.length
      ? `${hello} — on ${siteLabel}: ${parts.join(', ')}.`
      : `${hello} — ${siteLabel} is clear right now; nothing is open or blocked.`;
  } else {
    // Client framing: their site, in their language, with a way in.
    if (!stats.open) {
      message = `${hello} — I keep an eye on ${siteLabel} and there's nothing needing your attention right now. Ask me anything about how your search traffic is doing.`;
    } else if (stats.actionable) {
      message = `${hello} — I've been looking at ${siteLabel} and found ${stats.actionable} thing${stats.actionable === 1 ? '' : 's'} worth improving${stats.highPriority ? `, ${stats.highPriority} of them high priority` : ''}. Want me to walk you through them?`;
    } else {
      // Everything open is blocked — say so honestly rather than implying
      // there's nothing to do or offering actions that can't be taken.
      message = `${hello} — I've found some improvements for ${siteLabel}, but they're waiting on a design check before I can prepare them. I'll let you know as soon as they're ready.`;
    }
  }

  return {
    message,
    audience: isAdmin ? 'admin' : 'client',
    name,
    site: siteLabel,
    stats,
    suggestedActions: suggestedActions(recs.items || [], { isAdmin }),
  };
}

// Role-shaped system prompt for the answering loop. The two differ in
// vocabulary and in what they're allowed to expose, not merely in politeness:
// the client prompt forbids internal identifiers outright, matching the
// existing rule in copilot.js's answerQuestion that agent ids travel back as
// metadata only and never in user-facing copy.
export function systemPromptFor({ isAdmin, name, siteLabel }) {
  const who = name ? `You are speaking with ${name}.` : '';
  if (isAdmin) {
    return `You are the AI Copilot for the Zunkiree growth platform, speaking with a platform administrator. ${who} ` +
      'They operate this system across multiple client sites, so you may reference agents, recommendations, risk tiers, ' +
      'drafts and pull requests by name — that vocabulary is useful to them, not jargon. Be direct and operational: ' +
      'lead with what needs a decision, state real numbers, and never pad. If you do not have real data for something, ' +
      'say so plainly rather than estimating.';
  }
  return `You are the AI Copilot for ${siteLabel}, speaking with the site's owner. ${who} ` +
    'Talk like a knowledgeable colleague, not a dashboard: plain English, short sentences, no unexplained SEO jargon. ' +
    'Never mention internal machinery — no agent names or ids, no risk tiers, no draft statuses, no pull requests. ' +
    'Explain what you found on their site, why it matters to their traffic, and what happens next. Always ground ' +
    'what you say in the real data you were given; if you do not have it, say so honestly instead of guessing. ' +
    'When they seem unsure what to ask, offer a concrete next step.';
}
