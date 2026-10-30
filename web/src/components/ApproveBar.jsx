import { Check, Info } from 'lucide-react';
import Button from './Button.jsx';

// The bar under a list of things to choose: you SELECT an option on each item, nothing is approved yet, and ONE Approve
// button at the bottom approves everything selected. Only then is it saved for the agent's next run. Shared by the Content
// page and the Action Center's design choices so the two behave the same.
export default function ApproveBar({ selected, approved, busy, onApprove, onClear, noun = 'choice', builtToday = false }) {
  // Approving only saves. The agent builds in its daily run; if today's run already happened, this waits for tomorrow's.
  const when = builtToday ? "Today's run has already happened, so this is built in tomorrow's run, in tomorrow's commit." : 'The agent builds it in its next daily run and puts it in the pull request with the day\'s other fixes.';
  const plural = (n) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return (
    <div className="sticky bottom-3.5 z-10 mt-4">
      <div className="rounded-[14px] px-4 py-3 flex items-center gap-3.5 flex-wrap" style={{ background: '#171717', color: '#fff', boxShadow: '0 18px 40px -16px rgba(0,0,0,.5)' }}>
        <span className="w-8 h-8 rounded-full grid place-items-center shrink-0" style={{ background: selected ? '#f5a524' : approved ? '#3ecf8e' : 'rgba(255,255,255,.14)', color: selected || approved ? '#171717' : '#fff' }}>{selected ? <Check size={15} /> : approved ? <Check size={15} /> : <Info size={15} />}</span>
        <div className="min-w-0 flex-1" style={{ minWidth: 220 }}>
          <div className="text-sm font-semibold">
            {selected ? `${plural(selected)} selected, not approved yet` : approved ? `${plural(approved)} approved for the next run` : 'Nothing selected yet'}
          </div>
          <div className="text-xs" style={{ color: 'rgba(255,255,255,.7)' }}>
            {selected ? `Press Approve to approve everything selected. ${when}`
              : approved ? `Saved. ${when}`
                : 'Select one option on each item, then approve them all here. Nothing is built until you approve.'}
          </div>
        </div>
        {selected > 0 && <button type="button" className="btn btn--ghost" style={{ color: '#fff' }} onClick={onClear} disabled={busy}>Clear</button>}
        {selected > 0 && <Button variant="primary" onClick={onApprove} disabled={busy}><Check size={14} />{busy ? 'Approving…' : `Approve ${selected}`}</Button>}
      </div>
    </div>
  );
}
