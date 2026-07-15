import { useState } from 'react';
import { CATEGORY } from './AgentCard.jsx';
import { pagePathFor } from '../api.js';

const PRIORITY = {
  high: { color: '#e11d48', label: 'High priority' },
  medium: { color: '#f59e0b', label: 'Medium priority' },
  low: { color: '#94a3b8', label: 'Low priority' },
};

// Findings with no recommendedAction (device-intelligence, and content-gap's
// structural gaps like alt text) still need a real headline — derived from
// the finding's own evidence/id, using the stable id namespacing each agent
// already sets (see agents/types.js Finding.id). Falls back to the category
// label, never the raw agent name — "Content finding" reads as a real
// headline to a non-technical viewer, "Content Gap" reads as an internal
// system name.
function headlineFor(finding, cat) {
  if (finding.recommendedAction?.label) return finding.recommendedAction.label;
  if (finding.evidence?.gapType) return finding.evidence.gapType;
  if (finding.id?.includes(':low-ctr:')) return `Low click-through rate — ${finding.evidence?.device || ''}`.trim();
  if (finding.id?.includes(':declining:')) return `Declining sessions — ${finding.evidence?.device || ''}`.trim();
  if (finding.id?.startsWith('query-intelligence:dropper:')) return 'Search term losing clicks';
  return `${cat.label} finding`;
}

// Exported so CriticalIssueCard's details panel uses the same vocabulary
// instead of a second, driftable copy of this map.
export const EVIDENCE_LABEL = {
  page: 'Page', impressions: 'Impressions', clicks: 'Clicks', avgPosition: 'Avg. position',
  score: 'Score', country: 'Country', city: 'City', device: 'Device', query: 'Query',
  language: 'Language', recent: 'Recent', prior: 'Prior', delta: 'Change', ctr: 'CTR',
  ctrDeviationPct: 'CTR vs. average', gapType: 'Gap type', detail: 'Detail', entity: 'Entity',
  competitorsWithThisFeature: 'Competitors with this', competitorsTracked: 'Competitors tracked',
  agentName: 'Found by', confidence: 'Confidence', estimate: 'Estimate',
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
  // Agent/confidence/estimate are real signals, just not ones a first-glance
  // reader needs — folded into the same expandable evidence list instead of
  // living on the card face (see the removed inline tags below).
  const extraEntries = [
    finding.agentName && ['agentName', finding.agentName],
    finding.confidence && ['confidence', finding.confidence],
    finding.expectedImpact?.basis === 'estimate' && ['estimate', 'Modeled, not directly measured'],
  ].filter(Boolean);
  const evidenceEntries = [...extraEntries, ...Object.entries(finding.evidence || {}).filter(([, v]) => v != null && v !== '')];
  const pagePath = pagePathFor(finding.evidence?.page);

  return (
    <div className="rounded-2xl border border-slate-100 bg-white overflow-hidden transition hover:border-slate-200 hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] hover:-translate-y-0.5">
      <div className="h-[3px]" style={{ background: `linear-gradient(90deg, ${pr.color}, ${pr.color}55)` }} />
      <div className="p-4 flex gap-3">
        <span className="w-10 h-10 rounded-xl grid place-items-center text-lg shrink-0"
          style={{ background: `${cat.color}1a`, color: cat.color, border: `1px solid ${cat.color}33` }}>{cat.icon}</span>
        <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
            style={{ color: cat.color, background: `${cat.color}1a` }}>{cat.label}</span>
          <span className="inline-flex items-center gap-1 text-[11px] font-bold" style={{ color: pr.color }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: pr.color }} />
            {pr.label}
          </span>
        </div>
        <p className="text-[15px] font-bold text-slate-900 leading-snug">{headlineFor(finding, cat)}</p>
        {pagePath && <p className="text-[11px] text-slate-400 font-mono truncate mt-0.5">on {pagePath}</p>}
        <p className="text-[13px] text-slate-500 leading-snug mt-0.5">{finding.whyItMatters}</p>

        {evidenceEntries.length > 0 && (
          <>
            <button type="button" onClick={() => setExpanded((e) => !e)}
              className="inline-flex items-center gap-1 text-[11px] font-bold mt-2.5 transition-colors
                         text-[#6C63FF] hover:underline
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
    </div>
  );
}
