// ONE alert per site per blocked-design episode — never one per draft.
//
// When the design gates run in 'enforce' they hold drafts, and on a site whose
// design capture is thin that can be every draft, every day. Telling the owner
// about each one would reproduce exactly the alert flood the alert gate exists
// to stop. The owner needs to hear once: "new pages for this site are being
// held until its design is captured", with the reason. After that the held
// drafts are visible on the board and the log table is the record.
//
// An episode is a cooldown window, not a tracked state: a second block inside
// the window is the same episode. The window is long on purpose — the fix is a
// human or a re-derivation, neither of which happens in an hour.
export const DESIGN_BLOCKED_COOLDOWN_DAYS = 7;
export const DESIGN_BLOCKED_TYPE = 'design-blocked';

const REASON_TEXT = {
  'design-incomplete': "its captured design does not yet cover what these pages render",
  'render-deviation': 'pages rendered into its real layout measure differently from the rest of the site',
  'needs-human-review': 'there is no comparable real page to check new pages against',
  'unverifiable-low-confidence': 'new pages could not be verified against the site',
};

// Pure: the event for a site and a block reason.
export function designBlockedEvent(site, { reason, actionType }) {
  const why = REASON_TEXT[reason] || 'its design could not be matched';
  return {
    type: DESIGN_BLOCKED_TYPE,
    severity: 'medium',
    title: `${site?.name || 'This site'}: new pages are on hold until the design is captured`,
    body: `New ${actionType || 'page'} drafts are being held rather than published because ${why}. ` +
      'Nothing is broken on the live site. The held drafts are on the board, and re-capturing the design (or a quick review) releases them.',
    // A stable identity: the alert gate's per-key cooldown needs one, and the
    // site is the only thing that identifies an episode.
    insightId: `design-blocked:${site?.id}`,
  };
}

// Sends the event unless one already went out this episode. The cooldown is
// checked HERE with hasRecentNotification, not left to the alert gate, because
// the gate is itself behind a flag and this must hold with the flag off.
// Never throws: telling someone about a held draft must not be able to fail
// the ship path that held it.
export async function notifyDesignBlocked(site, info, deps = {}) {
  try {
    const hasRecent = deps.hasRecent || (await import('../store/notifications.js')).hasRecentNotification;
    const deliver = deps.deliver || (await import('./channels/index.js')).deliverToAllChannels;
    if (await hasRecent(site.id, DESIGN_BLOCKED_TYPE, DESIGN_BLOCKED_COOLDOWN_DAYS)) return { sent: false, reason: 'same-episode' };
    await deliver(site.id, [designBlockedEvent(site, info)]);
    return { sent: true };
  } catch (err) {
    console.warn(`[design-blocked] could not notify site ${site?.id}: ${err.message}`);
    return { sent: false, reason: 'error' };
  }
}
