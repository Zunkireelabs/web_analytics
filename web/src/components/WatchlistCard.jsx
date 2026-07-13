import { useState } from 'react';
import { CATEGORY } from './AgentCard.jsx';
import { timeAgo } from '../api.js';

const PRIORITY = {
  high: { color: '#e11d48', label: 'High priority' },
  medium: { color: '#f59e0b', label: 'Medium priority' },
  low: { color: '#94a3b8', label: 'Low priority' },
};

const STATUS = {
  new: { label: 'New', color: '#6C63FF' },
  in_progress: { label: 'In Progress', color: '#f59e0b' },
};

const EVIDENCE_LABEL = {
  page: 'Page', impressions: 'Impressions', clicks: 'Clicks', avgPosition: 'Avg. position',
  score: 'Score', country: 'Country', city: 'City', device: 'Device', query: 'Query',
  language: 'Language', recent: 'Recent', prior: 'Prior', delta: 'Change',
};

// An "intelligent queue," not a static list — every item here was added
// automatically because a real finding qualified (agents/lib/watchlist.js),
// and will close automatically (completed, if a real draft exists as
// evidence; no_longer_applicable otherwise) the moment it falls out of a
// fresh analysis run. The two action buttons below are the only manual
// input this queue takes — starting work, or dismissing something early.
export default function WatchlistCard({ item, generating, onGenerate, onStatusChange }) {
  const [expanded, setExpanded] = useState(false);
  const cat = CATEGORY[item.category] || CATEGORY.seo;
  const pr = PRIORITY[item.priority] || PRIORITY.low;
  const status = STATUS[item.status] || STATUS.new;
  const evidenceEntries = Object.entries(item.evidence || {}).filter(([, v]) => v != null && v !== '');

  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 flex flex-col gap-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
          style={{ color: cat.color, background: `${cat.color}1a` }}>{cat.label}</span>
        <span className="text-[11px] font-bold" style={{ color: pr.color }}>{pr.label}</span>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full ml-auto"
          style={{ color: status.color, background: `${status.color}1a` }}>{status.label}</span>
      </div>

      <div>
        <p className="text-sm font-bold text-slate-900 leading-snug">{item.title}</p>
        <p className="text-[13px] text-slate-500 leading-snug mt-0.5">{item.reason}</p>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-slate-400">
        {item.expectedImpact?.label && (
          <span>{item.expectedImpact.label} impact{item.expectedImpact.basis === 'estimate' ? ' (estimated)' : ''}</span>
        )}
        {item.confidence && <span>{item.confidence} confidence</span>}
        <span className="ml-auto">Discovered {timeAgo(item.discoveredAt)}</span>
      </div>

      {evidenceEntries.length > 0 && (
        <>
          <button type="button" onClick={() => setExpanded((e) => !e)}
            className="text-[11px] font-semibold text-slate-400 hover:text-[#6C63FF] transition-colors self-start
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF] rounded">
            {expanded ? 'Hide evidence ↑' : 'Show evidence →'}
          </button>
          {expanded && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] bg-slate-50 rounded-lg p-2.5 fade-up">
              {evidenceEntries.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 min-w-0">
                  <dt className="text-slate-400 shrink-0">{EVIDENCE_LABEL[k] || k}</dt>
                  <dd className="text-slate-700 font-medium font-mono truncate text-right">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}

      <div className="flex items-center gap-2 pt-1 mt-auto">
        {item.recommendedAction?.generatorId && (
          <button type="button" onClick={() => onGenerate(item)} disabled={generating}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg text-white transition disabled:opacity-60
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]"
            style={{ background: '#6C63FF' }}>
            {generating ? 'Generating…' : `Fix: ${item.recommendedAction.label}`}
          </button>
        )}
        {item.status === 'new' && (
          <button type="button" onClick={() => onStatusChange(item.id, 'in_progress')}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg text-slate-600 bg-slate-50 hover:bg-slate-100 transition">
            Start
          </button>
        )}
        {item.status === 'in_progress' && (
          <button type="button" onClick={() => onStatusChange(item.id, 'completed')}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition">
            Mark complete
          </button>
        )}
        <button type="button" onClick={() => onStatusChange(item.id, 'no_longer_applicable')}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition ml-auto">
          Dismiss
        </button>
      </div>
    </div>
  );
}
