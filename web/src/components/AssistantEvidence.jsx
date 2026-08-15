import { useState } from 'react';
import {
  Eye, Compass, Target, Globe, FileText, BrainCircuit, AlertCircle,
} from 'lucide-react';

// Cited-findings block for an assistant reply grounded in real agent
// findings (ask_growth_copilot's citedFindings) — ported from the old
// CopilotPanel so both Assistant surfaces keep the same evidence + Generate
// Draft affordance that made a traffic-drop answer actionable, not just
// informative.

const EVIDENCE_LABEL = {
  page: 'Page Route', impressions: 'Impressions Count', clicks: 'Clicks Count', avgPosition: 'Avg. Position',
  score: 'Audit Score', country: 'Country', city: 'City', device: 'Target Device', query: 'Search Query',
  language: 'Target Language', recent: 'Recent Period Clicks', prior: 'Prior Period Clicks', delta: 'Click Delta', ctr: 'Average CTR',
  ctrDeviationPct: 'CTR Variance %', gapType: 'Gap Type', detail: 'Technical Details', entity: 'Identified Entity',
  competitorsWithThisFeature: 'Competitors with citation', competitorsTracked: 'Competitors Tracked',
  agentName: 'Assigned Agent', confidence: 'LLM Confidence Score', estimate: 'Expected Return basis',
};

function findingHeadline(f) {
  if (f.actionable?.tag) return f.actionable.tag;
  if (f.evidence?.gapType) return f.evidence.gapType;
  if (f.id?.includes(':low-ctr:')) return `Low CTR (${f.evidence?.device || 'Device'})`;
  if (f.id?.includes(':declining:')) return `Declining Traffic (${f.evidence?.device || 'Device'})`;
  if (f.id?.includes('query-intelligence:dropper:')) return 'Query Impressions Drop';
  if (f.id?.includes('seo:')) return 'SEO Diagnostic';
  if (f.id?.includes('performance:')) return 'Performance Issue';
  const parts = f.id?.split(':') || [];
  const name = parts[parts.length - 1] || 'Finding';
  return name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function evidenceIcon(id) {
  if (id?.startsWith('query-intelligence') || id?.includes('seo:')) return Target;
  if (id?.startsWith('geo')) return Globe;
  if (id?.startsWith('content')) return FileText;
  if (id?.startsWith('executive')) return BrainCircuit;
  return AlertCircle;
}

export default function AssistantEvidence({ findings, onGenerateDraft, generatingId }) {
  const [activeIndex, setActiveIndex] = useState(null);
  if (!findings?.length) return null;

  return (
    <div className="mt-3 pt-3 border-t border-slate-100 flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-400">
        <Eye size={11} className="text-indigo-500" />
        <span>Supporting Evidence ({findings.length})</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {findings.slice(0, 5).map((f, i) => {
          const headline = findingHeadline(f);
          const Icon = evidenceIcon(f.id);
          const isActive = activeIndex === i;
          return (
            <button key={f.id} type="button" onClick={() => setActiveIndex(isActive ? null : i)}
              className={`flex items-center gap-1.5 text-[10.5px] font-bold px-3 py-1.5 rounded-xl border transition-all duration-200 active:scale-95 ${
                isActive
                  ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm shadow-indigo-600/20'
                  : 'bg-slate-50 border-slate-200/70 hover:border-slate-350 text-slate-655 hover:text-slate-800'
              }`}>
              <Icon size={11} className={isActive ? 'text-white' : 'text-slate-400'} />
              <span>{headline}</span>
              <span className={`text-[9px] opacity-60 font-medium ${isActive ? 'text-white' : 'text-slate-450'}`}>#{i + 1}</span>
            </button>
          );
        })}
      </div>

      {activeIndex !== null && findings[activeIndex] && (() => {
        const f = findings[activeIndex];
        const entries = Object.entries(f.evidence || {}).filter(([k, v]) => v != null && v !== '' && k !== 'whyItMatters');
        return (
          <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-2xl flex flex-col gap-3 shadow-inner">
            <div>
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">Why This Matters</div>
              <p className="text-[11.5px] font-medium text-slate-600 leading-relaxed italic">
                "{f.whyItMatters || 'This issue was detected during active intelligence monitoring.'}"
              </p>
            </div>
            {entries.length > 0 && (
              <div>
                <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5">Key Parameters & Metrics</div>
                <div className="grid grid-cols-2 gap-2 bg-white border border-slate-150 rounded-xl p-2.5">
                  {entries.map(([k, v]) => (
                    <div key={k} className="flex justify-between items-center text-[10px] border-b border-slate-50 last:border-0 pb-1 last:pb-0">
                      <span className="text-slate-450 font-bold">{EVIDENCE_LABEL[k] || k}</span>
                      <span className="text-slate-700 font-extrabold truncate max-w-[155px]" title={String(v)}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {f.actionable && onGenerateDraft && (
              <div className="flex justify-end pt-1 border-t border-slate-200/50">
                <button type="button" onClick={() => onGenerateDraft(f)} disabled={generatingId === f.id}
                  className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-xl px-4 py-2.5 transition-all shadow-sm active:scale-95">
                  {generatingId === f.id ? 'Generating Draft…' : 'Generate Action Draft →'}
                </button>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
