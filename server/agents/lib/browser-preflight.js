import { launchBrowser } from '../../design-agent/live-analysis/capture.js';

// Why this exists: font-consistency and visual-quality are the only two
// detection agents that need a real headless browser. On 2026-09-03 both
// were found to have errored on EVERY run against the only real site — four
// runs each, over a month — with the stored reason reading "this run did not
// complete". That string is safeMessage's fallback (lib/errors.js): the real
// exception went to logInternal and the customer-facing column got a
// placeholder, which is the right call for a leak-prone raw exception and
// the wrong outcome for an operator trying to find out why a whole category
// of detection has produced nothing for a month.
//
// A missing/broken browser is not an agent error at all — it is the same
// shape as "no GSC data yet": the agent cannot do its job, through no fault
// of the site's, and nothing it reports would be true. So it belongs in
// `insufficient-data` with an honest message, not `error` with a redacted
// one. That distinction is what makes it visible: an agent that says "the
// browser isn't available on this server" is diagnosable from the Action
// Center; one that says "this run did not complete" is not.
//
// Deliberately NOT interpolating err.message into the returned reason — the
// launch failure of a native binary is exactly the raw-exception shape
// lib/errors.js exists to keep out of customer-facing text. The full error
// still reaches the server log below, which is where the actual stack
// belongs.
export const BROWSER_UNAVAILABLE = 'The headless browser this check needs is not available on this server, so no real page could be rendered. This is a server setup issue, not a problem with the site.';

/**
 * Attempts a real browser launch and closes it again. Returns
 * { ok: true } when a browser is genuinely usable here, or
 * { ok: false, reason } with a customer-safe reason when it is not.
 *
 * Never throws — the whole point is to convert a thrown native-binary
 * failure into a value the caller can report honestly.
 */
export async function checkBrowserAvailable({ launchBrowserFn = launchBrowser } = {}) {
  let browser = null;
  try {
    browser = await launchBrowserFn();
    return { ok: true };
  } catch (err) {
    // The one place the real cause is recorded. Not returned, not persisted
    // to a customer-facing column — logged, the same contract safeMessage
    // follows.
    console.error(`[browser-preflight] headless browser unavailable: ${err.message}`);
    return { ok: false, reason: BROWSER_UNAVAILABLE };
  } finally {
    // A launch that succeeded but whose close fails must not turn a healthy
    // preflight into a failed one — the browser launched, which is the only
    // thing being asserted here.
    if (browser) await browser.close?.().catch(() => {});
  }
}
