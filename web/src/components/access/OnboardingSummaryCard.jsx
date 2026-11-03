import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../../api.js';

const INTENT = { informational: 'Informational', commercial: 'Commercial', transactional: 'Transactional' };

// What the person set up on /get-started: the brand, the topics, and the prompts SuperRank wrote. Shown on the Overview
// so their answers are on the dashboard from the first sign-in. Nothing for a project that was not made there.
export default function OnboardingSummaryCard() {
  const [data, setData] = useState(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false); // the prompt list is folded away until asked for, so the page stays calm
  useEffect(() => { api.onboardingSummary().then(setData).catch(() => setData(null)); }, []);
  if (!data || (!data.topics?.length && !data.promptList?.length)) return null;
  const prompts = data.promptList || [];
  const shown = all ? prompts : prompts.slice(0, 6);
  return (
    <section className="mt-3 rounded-card bg-white p-4 md:p-5" style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' }}>
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}><Sparkles size={15} /></span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-fg">Your setup{data.brand ? `: ${data.brand}` : ''}</h3>
          <p className="text-[13px] text-text mt-px">{[data.category, `${data.topics?.length || 0} topics`, `${prompts.length || data.prompts || 0} prompts`, data.competitors?.length ? `${data.competitors.length} competitors` : null].filter(Boolean).join(' · ')}</p>
        </div>
        {prompts.length > 0 && (
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="btn btn--light btn--sm ml-auto shrink-0">{open ? 'Hide prompts' : 'View prompts'}</button>
        )}
      </div>
      {data.topics?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {data.topics.map((t) => <span key={t} className="px-2.5 h-6 inline-flex items-center rounded-full bg-muted text-xs text-fg">{t}</span>)}
        </div>
      )}
      {open && shown.length > 0 && (
        <ul className="mt-3 border-t border-border">
          {shown.map((p, i) => (
            <li key={`${p.text}-${i}`} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
              <span className="min-w-0 flex-1 text-[13px] text-fg">{p.text}</span>
              {p.intent && <span className="shrink-0 px-2 h-5 inline-flex items-center rounded-full bg-muted text-[11px] text-text">{INTENT[p.intent] || p.intent}</span>}
            </li>
          ))}
        </ul>
      )}
      {open && prompts.length > 6 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 text-[13px] text-primary underline underline-offset-2">{all ? 'Show fewer' : `Show all ${prompts.length}`}</button>
      )}
    </section>
  );
}
