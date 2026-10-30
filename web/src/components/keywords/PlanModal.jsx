import { useEffect, useState } from 'react';
import { Hash } from 'lucide-react';
import { api, SELF } from '../../api.js';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';
import Badge from '../Badge.jsx';
import ChoiceCard from '../workspace/ChoiceCard.jsx';
import { Pill, num } from './shared.jsx';

const INTENT = { informational: 'People want to learn', commercial: 'People are comparing options', transactional: 'People are ready to buy' };
const RELEVANCE = { direct: 'Fits what you sell', supporting: 'Related to what you sell', unrelated: 'Not what you sell' };

// The question after "Add" or "Go after this": what should be created for this keyword. The agent's pick is
// selected and explained, using the same rule that decides what gets drafted (keyword-plan.js), so what is
// recommended here is always something the server will really create. Nothing is saved until the person
// confirms; a keyword typed fresh is only created at that moment, so cancelling leaves no trace.
//
//   keyword       the keyword text
//   gapId         set for a keyword that is already collected (the choice is saved against it)
//   recommended   { plan, reason } when it is already known (a collected keyword); otherwise asked of the server
//   volume        monthly searches, when known
//   currentPlan   a keyword that is only being tracked can still be turned into a blog or a landing page
export default function PlanModal({ keyword, gapId = null, recommended = null, volume = null, onClose, onDone }) {
  const [rec, setRec] = useState(recommended);
  const [choice, setChoice] = useState(recommended?.plan || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (recommended) return undefined;
    let live = true;
    api.keywords.recommend(SELF, keyword)
      .then((r) => { if (live) { setRec(r); setChoice(r.plan); } })
      .catch(() => { if (live) { setRec({ plan: 'blog', reason: 'A blog post is the safest way to start on this keyword.' }); setChoice('blog'); } });
    return () => { live = false; };
  }, [keyword, recommended]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const res = gapId ? await api.keywords.setGapPlan(SELF, gapId, choice) : await api.keywords.createGap(SELF, keyword, choice);
      const planned = res.planned || res;
      onDone(outcomeMessage(keyword, choice, planned));
    } catch (e) {
      setError(e.message || 'Could not save that. Please try again.');
      setBusy(false);
    }
  };

  const chips = rec && [
    volume != null && `About ${num(volume)} searches a month`,
    INTENT[rec.intent],
    RELEVANCE[rec.relevance],
    rec.alreadyRanks && 'Your site already ranks for this',
  ].filter(Boolean);

  return (
    <Modal isOpen onClose={busy ? () => {} : onClose} icon={Hash} title="What should we create for this keyword?" subtitle={keyword} maxWidth="max-w-[480px]"
      footer={(
        <>
          <Button variant="light" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button write variant="primary" onClick={save} disabled={!rec || !choice || busy}>
            {busy ? (choice === 'landing' ? 'Drafting the page… this can take a minute' : 'Saving…') : gapId ? 'Save' : 'Add keyword'}
          </Button>
        </>
      )}>
      {!rec ? (
        <p className="text-[13px] text-faint">Looking at what people want when they search this…</p>
      ) : (
        <>
          {chips.length > 0 && <div className="flex flex-wrap items-center gap-1.5">{chips.map((c) => <Pill key={c}>{c}</Pill>)}</div>}
          <p className="text-[13px] text-text">{rec.reason}</p>
          <div className="space-y-2" role="radiogroup" aria-label="What to create">
            <ChoiceCard selected={choice === 'blog'} onSelect={() => setChoice('blog')}
              title={<span className="flex items-center gap-2">Blog post{rec.plan === 'blog' && <Badge tone="primary">Recommended</Badge>}</span>}
              description="A guide that answers the search, then points people to what you sell." />
            <ChoiceCard selected={choice === 'landing'} onSelect={() => setChoice('landing')}
              title={<span className="flex items-center gap-2">Landing page{rec.plan === 'landing' && <Badge tone="primary">Recommended</Badge>}</span>}
              description="A page built to win this search and turn visitors into customers." />
            <ChoiceCard selected={choice === 'track'} onSelect={() => setChoice('track')}
              title={<span className="flex items-center gap-2">Neither, just track it{rec.plan === 'track' && <Badge tone="primary">Recommended</Badge>}</span>}
              description="We watch how it ranks and create nothing." />
          </div>
          <p className="text-xs text-faint">A blog post is written in an upcoming daily run and opened as a pull request on your repository, one blog at a time. A landing page is drafted now and waits for your approval in Action Center. Nothing is published without you.</p>
          {error && <p className="text-[13px]" style={{ color: '#b42318' }}>{error}</p>}
        </>
      )}
    </Modal>
  );
}

// What to tell the person after they chose, in plain words and truthfully: including when the site cannot
// publish that kind of page yet, or when nothing could be created.
export function outcomeMessage(keyword, choice, planned) {
  if (planned?.notCreated) return `We could not create anything for "${keyword}" right now, so it stays in your list to go after.`;
  if (choice === 'track') return `"${keyword}" is added. We will track how it ranks.`;
  const what = choice === 'landing' ? 'landing page' : 'blog post';
  if (planned?.alreadyPlanned) return `"${keyword}" already has a ${what} planned.`;
  const blocked = planned?.actionCenter?.blockedReason;
  if (blocked) return `"${keyword}" is saved as a ${what}, but it cannot be created yet: ${blocked}`;
  return choice === 'landing'
    ? `"${keyword}" is added. The landing page draft is waiting for your approval in Action Center.`
    : `"${keyword}" is added. A blog post will be written in an upcoming daily run.`;
}
