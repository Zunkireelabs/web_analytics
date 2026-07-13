import { useState } from 'react';
import { CATEGORY } from './AgentCard.jsx';

const PRIORITY = {
  high: { color: '#e11d48', label: 'High priority' },
  medium: { color: '#f59e0b', label: 'Medium priority' },
  low: { color: '#94a3b8', label: 'Low priority' },
};

const CONFIDENCE_COLOR = { high: '#16A34A', medium: '#f59e0b', low: '#94a3b8' };

// Findings with no recommendedAction (device-intelligence, and content-gap's
// structural gaps like alt text) still need a real headline, not the agent's
// own name repeated (redundant with the category badge, and unhelpful) —
// derived from the finding's own evidence/id instead, using the stable id
// namespacing each agent already sets (see agents/types.js Finding.id).
function headlineFor(finding) {
  if (finding.recommendedAction?.label) return finding.recommendedAction.label;
  if (finding.evidence?.gapType) return finding.evidence.gapType;
  if (finding.id?.includes(':low-ctr:')) return `Low click-through rate — ${finding.evidence?.device || ''}`.trim();
  if (finding.id?.includes(':declining:')) return `Declining sessions — ${finding.evidence?.device || ''}`.trim();
  if (finding.id?.startsWith('query-intelligence:dropper:')) return 'Search term losing clicks';
  return finding.agentName;
}

const EVIDENCE_LABEL = {
  page: 'Page', impressions: 'Impressions', clicks: 'Clicks', avgPosition: 'Avg. position',
  score: 'Score', country: 'Country', city: 'City', device: 'Device', query: 'Query',
  language: 'Language', recent: 'Recent', prior: 'Prior', delta: 'Change', ctr: 'CTR',
  ctrDeviationPct: 'CTR vs. average', gapType: 'Gap type', detail: 'Detail', entity: 'Entity',
};

// Evidence-first, not metric-first — the specific real numbers backing a
// finding are shown inline (whyItMatters is already evidence-grounded text
// from the agent). A colored left stripe encodes severity before the text is
// even read. The full structured evidence object is one click away for
// anyone who wants to verify it — Perplexity's "answer visible, source one
// click away" pattern, not buried behind a generic "view raw data" dump.
export default function DiscoveryCard({ finding }) {
  const [expanded, setExpanded] = useState(false);
  const cat = CATEGORY[finding.category] || CATEGORY.seo;
  const pr = PRIORITY[finding.priority] || PRIORITY.low;
  const evidenceEntries = Object.entries(finding.evidence || {}).filter(([, v]) => v != null && v !== '');

  return (
    <div className="flex rounded-xl border border-slate-100 bg-white overflow-hidden transition-colors hover:border-slate-200">
      <div className="w-[3px] shrink-0" style={{ background: pr.color }} />
      <div className="p-4 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
            style={{ color: cat.color, background: `${cat.color}1a` }}>{cat.label}</span>
          <span className="text-[11px] font-bold" style={{ color: pr.color }}>{pr.label}</span>
          {finding.confidence && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
              style={{ color: CONFIDENCE_COLOR[finding.confidence], background: `${CONFIDENCE_COLOR[finding.confidence]}1a` }}>
              {finding.confidence} confidence
            </span>
          )}
          {finding.expectedImpact?.basis === 'estimate' && (
            <span className="text-[10px] font-medium text-slate-400 border border-slate-200 rounded px-1.5 py-0.5">estimated</span>
          )}
        </div>
        <p className="text-sm font-semibold text-slate-800 leading-snug">{headlineFor(finding)}</p>
        <p className="text-[13px] text-slate-500 leading-snug mt-0.5">{finding.whyItMatters}</p>

        {evidenceEntries.length > 0 && (
          <>
            <button type="button" onClick={() => setExpanded((e) => !e)}
              className="text-[11px] font-semibold text-slate-400 hover:text-[#6C63FF] mt-2 transition-colors
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF] rounded">
              {expanded ? 'Hide evidence ↑' : 'Show evidence →'}
            </button>
            {expanded && (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] bg-slate-50 rounded-lg p-2.5 fade-up">
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
      </div>
    </div>
  );
}
