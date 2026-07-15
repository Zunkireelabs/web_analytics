import { useState } from 'react';
import { CATEGORY } from './AgentCard.jsx';
import { EVIDENCE_LABEL } from './DiscoveryCard.jsx';
import { pagePathFor } from '../api.js';

// The top-of-briefing callout — a small, curated subset of AI Discoveries
// (see command-center.js's `criticalIssues`). Title, evidence, why it
// matters, expected impact, and one clear action are always visible so a
// user never has to click into anything to understand the single most
// urgent thing — but which agent found it, its confidence, and the raw
// evidence backing it are internal detail, not headline material, so those
// live behind the same "Show details" pattern DiscoveryCard already uses.
export default function CriticalIssueCard({ finding, generating, onGenerate }) {
  const [expanded, setExpanded] = useState(false);
  const cat = CATEGORY[finding.category] || CATEGORY.seo;
  const impact = finding.expectedImpact;
  const action = finding.recommendedAction;
  const detailEntries = [
    finding.agentName && ['agentName', finding.agentName],
    impact?.basis === 'estimate' && ['estimate', 'Modeled, not directly measured'],
    ...Object.entries(finding.evidence || {}).filter(([, v]) => v != null && v !== ''),
  ].filter(Boolean);
  const pagePath = pagePathFor(finding.evidence?.page);

  return (
    <div className="rounded-2xl border border-slate-100 bg-white overflow-hidden transition hover:border-slate-200 hover:shadow-[0_4px_16px_-4px_rgba(225,29,72,0.12)] flex flex-col">
      <div className="h-[3px] shrink-0 bg-gradient-to-r from-rose-500 to-rose-300" />
      <div className="p-5 flex flex-col gap-3 flex-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="w-6 h-6 rounded-lg grid place-items-center text-[12px] shrink-0 bg-rose-50">🚨</span>
          <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
            style={{ color: cat.color, background: `${cat.color}1a` }}>{cat.label}</span>
          <span className="text-[11px] font-bold text-rose-600">Critical</span>
        </div>
        {impact && <span className="text-[10px] font-semibold text-slate-400 shrink-0 text-right">{impact.label} impact</span>}
      </div>

      <div>
        <p className="text-[15px] font-bold text-slate-900 leading-snug">{action?.label || `${cat.label} issue`}</p>
        {pagePath && <p className="text-[11px] text-slate-400 font-mono truncate mt-0.5">on {pagePath}</p>}
        <p className="text-[13px] text-slate-500 leading-relaxed mt-1">{finding.whyItMatters}</p>

        {detailEntries.length > 0 && (
          <>
            <button type="button" onClick={() => setExpanded((e) => !e)}
              className="inline-flex items-center gap-1 text-[11px] font-bold mt-2.5 transition-colors
                         text-[#6C63FF] hover:underline
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF] rounded">
              {expanded ? 'Hide details ↑' : 'Show details →'}
            </button>
            {expanded && (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] bg-slate-50 rounded-lg p-2.5 fade-up">
                {detailEntries.map(([k, v]) => (
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

      <div className="mt-auto pt-1">
        {action?.generatorId ? (
          <button type="button" onClick={() => onGenerate(finding)} disabled={generating}
            className="text-xs font-semibold px-3.5 py-2 rounded-lg text-white transition disabled:opacity-60
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]"
            style={{ background: '#6C63FF' }}>
            {generating ? 'Generating…' : `Fix: ${action.label}`}
          </button>
        ) : (
          <span className="text-xs text-slate-400">Needs manual review — no draftable fix for this yet.</span>
        )}
      </div>
      </div>
    </div>
  );
}
