import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

const INTENT = { informational: 'Informational', commercial: 'Commercial', transactional: 'Transactional' };

// The prompts SuperRank wrote from the person's topics on /get-started: the questions buyers ask AI about their business,
// grouped by topic. They are the starting list the agent measures (AI visibility); Search Console data fills the other
// tabs once Google is connected.
export default function PromptsTab({ data }) {
  const [q, setQ] = useState('');
  const [topic, setTopic] = useState('');
  const prompts = data?.promptList || [];
  const topics = useMemo(() => [...new Set(prompts.map((p) => p.topic).filter(Boolean))], [prompts]);
  const shown = prompts.filter((p) => (!topic || p.topic === topic) && (!q.trim() || p.text.toLowerCase().includes(q.trim().toLowerCase())));
  const groups = [...new Set(shown.map((p) => p.topic || 'Other'))];

  return (
    <div className="rounded-card bg-white" style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' }}>
      <div className="px-4 md:px-5 py-3.5 border-b border-border flex flex-wrap items-center gap-3">
        <div className="min-w-0 mr-auto">
          <h2 className="text-[15px] font-semibold text-fg">Your prompts</h2>
          <p className="text-[13px] text-text mt-0.5">{prompts.length} questions across {topics.length} topic{topics.length === 1 ? '' : 's'}, written from your sign-up.</p>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search prompts" aria-label="Search prompts"
            className="h-8 w-[220px] pl-8 pr-3 rounded-control bg-white text-[13px] text-fg outline-none" style={{ boxShadow: 'var(--ring)' }} />
        </div>
      </div>
      {topics.length > 1 && (
        <div className="px-4 md:px-5 py-2.5 border-b border-border flex flex-wrap gap-1.5">
          {['', ...topics].map((t) => (
            <button key={t || 'all'} type="button" onClick={() => setTopic(t)} aria-pressed={topic === t}
              className={`h-7 px-2.5 rounded-full text-xs ${topic === t ? 'bg-primary-tint text-primary' : 'bg-muted text-text hover:text-fg'}`}>{t || 'All'}</button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="px-4 md:px-5 py-6 text-[13px] text-faint">{prompts.length ? 'No prompts match.' : 'No prompts yet.'}</p>
      ) : groups.map((g) => (
        <div key={g}>
          <p className="px-4 md:px-5 pt-3 pb-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">{g}</p>
          {shown.filter((p) => (p.topic || 'Other') === g).map((p, i) => (
            <div key={`${p.text}-${i}`} className="px-4 md:px-5 py-2.5 border-b border-border last:border-0 flex items-center gap-3">
              <span className="min-w-0 flex-1 text-[13px] text-fg">{p.text}</span>
              {p.intent && <span className="shrink-0 px-2 h-5 inline-flex items-center rounded-full bg-muted text-[11px] text-text">{INTENT[p.intent] || p.intent}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
