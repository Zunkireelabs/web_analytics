import { useState } from 'react';
import { EVIDENCE_LABEL } from './DiscoveryCard.jsx';
import { pagePathFor } from '../api.js';
import { 
  Target, 
  Globe, 
  FileText, 
  BrainCircuit, 
  ChevronDown, 
  ChevronUp, 
  AlertTriangle,
  Settings
} from 'lucide-react';

const CATEGORY_META = {
  seo: { label: 'SEO & Tech', icon: Target, color: '#6C63FF', bgLight: '#6C63FF0c', borderLight: '#6C63FF1e' },
  geo: { label: 'Geo Target', icon: Globe, color: '#0ea5e9', bgLight: '#0ea5e90c', borderLight: '#0ea5e91e' },
  content: { label: 'Content Audit', icon: FileText, color: '#14b8a6', bgLight: '#14b8a60c', borderLight: '#14b8a61e' },
  meta: { label: 'Executive Brief', icon: BrainCircuit, color: '#ec4899', bgLight: '#ec48990c', borderLight: '#ec48991e' }
};

export default function CriticalIssueCard({ finding, generating, onGenerate }) {
  const [expanded, setExpanded] = useState(false);
  const catKey = finding.category || 'seo';
  const cat = CATEGORY_META[catKey] || CATEGORY_META.seo;
  const impact = finding.expectedImpact;
  const action = finding.recommendedAction;

  const detailEntries = [
    finding.agentName && ['agentName', finding.agentName],
    impact?.basis === 'estimate' && ['estimate', 'Model Estimated'],
    ...Object.entries(finding.evidence || {}).filter(([, v]) => v != null && v !== ''),
  ].filter(Boolean);
  const pagePath = pagePathFor(finding.evidence?.page);
  const IconComponent = cat.icon;

  return (
    <div className="rounded-3xl border border-slate-200/60 bg-gradient-to-br from-white to-slate-50/40 p-4 transition-all duration-300 hover:shadow-md hover:border-slate-300 relative group overflow-hidden flex flex-col justify-between shadow-sm">
      {/* Accent Indicator Bar */}
      <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-rose-500 to-rose-300 animate-pulse" />
      
      <div>
        {/* Row 1: Badges */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span 
              className="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border"
              style={{ color: cat.color, backgroundColor: cat.bgLight, borderColor: cat.borderLight }}
            >
              {cat.label}
            </span>
            <span className="text-[9px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full bg-rose-50 border border-rose-100 text-rose-700 flex items-center gap-0.5">
              <AlertTriangle size={8} /> Critical Gap
            </span>
          </div>
          {impact && (
            <span className="text-[9px] font-extrabold text-slate-400 bg-slate-50 px-2.5 py-0.5 rounded-full border border-slate-150">
              {impact.label} Impact
            </span>
          )}
        </div>

        {/* Row 2: Headline & Description */}
        <div className="flex items-start gap-3">
          <span 
            className="w-7 h-7 rounded-xl grid place-items-center shrink-0 border shadow-sm bg-rose-500/5 text-rose-500 border-rose-500/10"
          >
            <IconComponent size={12} strokeWidth={2.25} />
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="text-xs font-extrabold text-slate-900 leading-snug group-hover:text-indigo-650 transition-colors">
              {action?.label || `${cat.label} Critical issue`}
            </h4>
            {pagePath && (
              <span className="inline-block text-[9px] text-slate-400 font-mono mt-0.5 truncate max-w-full">
                on {pagePath}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Collapsible Details & Action Drawer */}
      {!expanded ? (
        <button 
          type="button" 
          onClick={() => setExpanded(true)}
          className="text-[9px] font-black uppercase tracking-wider text-[#6C63FF]/80 hover:text-[#6C63FF] hover:underline mt-2 self-start flex items-center gap-1 py-2 focus:outline-none cursor-pointer"
        >
          Show details & action <ChevronDown size={10} />
        </button>
      ) : (
        <div className="flex flex-col gap-3 pt-2.5 border-t border-slate-100/50 mt-2 animate-slide-down">
          {/* Description */}
          <p className="text-[10px] font-semibold text-slate-505 leading-relaxed break-words bg-slate-50 p-2.5 rounded-xl border border-slate-150 shadow-inner">
            {finding.whyItMatters}
          </p>

          {/* Diagnostic Details */}
          {detailEntries.length > 0 && (
            <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-2.5 space-y-1 shadow-inner">
              <div className="text-[8px] font-black uppercase tracking-wider text-[#8b5cf6] pb-1 border-b border-slate-800/80 mb-1">Watchlist Diagnostics</div>
              {detailEntries.map(([k, v]) => (
                <div key={k} className="flex justify-between items-center text-[9px] font-mono leading-tight">
                  <span className="text-slate-500">{EVIDENCE_LABEL[k] || k}</span>
                  <span className="text-slate-300 font-bold max-w-[150px] truncate text-right">
                    {String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Action Trigger */}
          {action && (
            <button
              type="button"
              onClick={() => onGenerate(finding)}
              disabled={generating}
              className="text-[9px] font-black uppercase tracking-wider py-2 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm hover:shadow-indigo-500/15 cursor-pointer"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
            >
              {generating ? 'Drafting…' : `Fix: ${action.title}`}
            </button>
          )}

          {/* Collapse trigger */}
          <button 
            type="button" 
            onClick={() => setExpanded(false)}
            className="text-[9px] font-black uppercase tracking-wider text-[#6C63FF]/80 hover:text-[#6C63FF] hover:underline mt-1 self-start flex items-center gap-1 focus:outline-none cursor-pointer"
          >
            Hide details <ChevronUp size={10} />
          </button>
        </div>
      )}
    </div>
  );
}
