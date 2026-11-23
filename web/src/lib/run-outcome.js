// What a finished bulk run actually did, in words a client can act on.
// "Shipped 0 — committed to one branch, one PR opened" used to show for a run
// that stopped before its first item (2026-11-23: GitHub budget reserve hit,
// 47 items untouched) — the banner only ever knew how to say success. A run
// that shipped nothing now says so, with the reason from the job's own log.
export function runOutcome(result) {
  const shipped = result?.shipped ?? 0;
  const failed = result?.failed ?? 0;
  const prUrl = result?.job?.pr_url || null;
  if (shipped > 0) {
    return { ok: true, text: `Shipped ${shipped}${failed > 0 ? `, ${failed} failed` : ''} — committed to one branch${prUrl ? ', one PR opened' : ''}.` };
  }
  const logs = result?.job?.logs || [];
  const budget = [...logs].reverse().find((l) => /GitHub API budget/i.test(l?.message || ''));
  if (budget) {
    const left = (budget.message.match(/(\d+) item\(s\) left untouched/) || [])[1];
    return { ok: false, text: `Nothing shipped — stopped before starting because GitHub's request limit for this site is nearly used up.${left ? ` ${left} fixes were left untouched` : ' The fixes were left untouched'} and will be tried again on the next run.` };
  }
  const pushFail = [...logs].reverse().find((l) => /Batch push\/PR failed/i.test(l?.message || ''));
  if (pushFail) return { ok: false, text: `Nothing shipped — the fixes were prepared but the push to GitHub failed. ${failed > 0 ? `${failed} will be retried.` : ''}`.trim() };
  if (failed > 0) return { ok: false, text: `Nothing shipped — ${failed} failed. Open the list to see why.` };
  return { ok: false, text: 'Nothing shipped — there was nothing ready to ship right now (already drafted, or waiting for its pacing slot).' };
}
