// A free trial that has ended still belongs to the person for a while: they can come back to Get Started with their
// email and a code and see their workspace unblurred, with the keywords and prompts they chose (only signing in to the
// app is closed to them). After this many days they are treated as new, exactly like an address we have never seen.
export const ENDED_GRACE_DAYS = 30;

// `access` is what describeAccess() returns. A trial with no recorded end date is never called stale: we would
// rather show someone their workspace than wipe it by mistake.
export function endedBeyondGrace(access, now = new Date()) {
  if (access?.state !== 'ended' || !access.endedAt) return false;
  const ended = new Date(access.endedAt).getTime();
  return Number.isFinite(ended) && now.getTime() - ended > ENDED_GRACE_DAYS * 864e5;
}
