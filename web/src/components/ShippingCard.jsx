import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../api.js';
import Button from './Button.jsx';
import { cardFor, stepIndex, plainReason } from '../lib/ship-card.js';

// One question from the agent, asked in its popup (bottom-right), never on the pages. It carries approved work to the live site, the same for fixes and for writing:
//   approved -> "open the PR?" -> "merge it to stage?" -> "open the PR to main?" -> a person merges main on GitHub.
// `state` comes from the server (the drafts and PRs themselves), so it is right after a reload and cannot drift. Merging into stage
// happens only when the client presses the button; there is no button that merges main.
export default function ShippingCard({ scope, state, siteId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [snoozed, setSnoozed] = useState(null); // the step the client pressed "Not yet" on, for this visit

  const card = cardFor(state, scope);
  if (!card || (snoozed === state.step && !card.info)) return null;

  const run = async () => {
    setBusy(true); setNote(null);
    try {
      let r;
      if (card.action.id === 'push_branch') {
        r = await api.actionCenter.shipPushBranch(scope, siteId);
        setNote(r.pushed ? `Committed ${r.pushed} ${r.pushed === 1 ? 'change' : 'changes'} to today's branch.`
          : r.failed ? `It could not be put on the branch: ${r.errors?.[0] || 'something went wrong'}. Nothing was changed on your site.` : 'Nothing was ready to put on the branch.');
      } else if (card.action.id === 'open_pr') {
        r = await api.actionCenter.shipOpenPr(scope, siteId);
        setNote(r.opened ? `Opened the PR${r.prNumber ? ` (#${r.prNumber})` : ''}.` : 'There was nothing on the branch to open a PR for.');
      } else if (card.action.id === 'merge_stage') {
        r = await api.actionCenter.shipMergeStage(state.prNumber, siteId);
        setNote('Merged to stage.');
      } else {
        r = await api.actionCenter.shipOpenMain(siteId);
        setNote(r.opened ? `Opened the PR to main (#${r.opened.number}).` : r.waiting ? 'Stage is still being checked. Try again in a few minutes.' : 'Nothing is ready for main yet.');
      }
      await onChanged?.();
    } catch (e) {
      setNote(plainReason({ reason: e.reason, error: e.message }));
    } finally { setBusy(false); }
  };

  const idx = stepIndex(state.step);
  return (
    <div className="rounded-[12px] px-3.5 py-3" style={{ boxShadow: '0 0 0 1px var(--border-canvas)', background: card.info ? '#fff' : 'var(--primary-tint)' }} data-ship-card={state.step}>
      <div className="text-sm font-medium text-fg leading-snug">{card.title}</div>
      <div className="text-[13px] text-text mt-1">{note || card.sub}</div>
      <div className="flex gap-1.5 mt-2.5" aria-hidden>{[0, 1, 2, 3, 4].map((k) => <i key={k} className="h-[3px] w-7 rounded-full" style={{ background: k <= idx ? 'var(--primary)' : 'var(--border-canvas)' }} />)}</div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {!card.info && <Button size="sm" variant="primary" onClick={run} disabled={busy}>{busy ? 'Working…' : card.action.label}</Button>}
        {!card.info && <button type="button" onClick={() => setSnoozed(state.step)} disabled={busy} className="text-[13px] font-medium text-text hover:text-fg px-1">{card.later}</button>}
        {card.link && <a href={card.link} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[13px] underline underline-offset-2 text-text">{card.linkLabel || 'View the PR'}<ExternalLink size={12} /></a>}
      </div>
    </div>
  );
}
