import { pagePathFor } from '../api.js';
import { Target, Globe, FileText, BrainCircuit, TrendingUp, Sparkles, ShieldCheck } from 'lucide-react';

const PRIORITY = {
  high: { color: '#e11d48', label: 'High Priority', bg: '#fff1f2', text: '#e11d48' },
  medium: { color: '#f59e0b', label: 'Medium Priority', bg: '#fffbeb', text: '#d97706' },
  low: { color: '#64748b', label: 'Info', bg: '#f8fafc', text: '#64748b' },
};

const CATEGORY_META = {
  seo: { label: 'SEO', icon: Target, color: '#6C63FF', bgLight: '#6C63FF0c', borderLight: '#6C63FF1e' },
  geo: { label: 'Audience', icon: Globe, color: '#0ea5e9', bgLight: '#0ea5e90c', borderLight: '#0ea5e91e' },
  content: { label: 'Content', icon: FileText, color: '#14b8a6', bgLight: '#14b8a60c', borderLight: '#14b8a61e' },
  meta: { label: 'Overview', icon: BrainCircuit, color: '#ec4899', bgLight: '#ec48990c', borderLight: '#ec48991e' },
  compliance: { label: 'Trust & Compliance', icon: ShieldCheck, color: '#f59e0b', bgLight: '#f59e0b0c', borderLight: '#f59e0b1e' }
};

function headlineFor(finding, cat) {
  if (finding.recommendedAction?.label) return finding.recommendedAction.label;
  if (finding.evidence?.gapType) return finding.evidence.gapType;
  if (finding.id?.includes(':low-ctr:')) return `Low Click-Through Rate (${finding.evidence?.device || 'Device'})`.trim();
  if (finding.id?.includes(':declining:')) return `Declining Traffic Trends (${finding.evidence?.device || 'Device'})`.trim();
  if (finding.id?.startsWith('query-intelligence:dropper:')) return 'Search Query Impressions Drop';
  return `${cat.label} Finding`;
}

export default function DiscoveryCard({ finding, generating, onGenerate }) {
  const catKey = finding.category || 'seo';
  const cat = CATEGORY_META[catKey] || CATEGORY_META.seo;
  const pr = PRIORITY[finding.priority] || PRIORITY.low;
  const pagePath = pagePathFor(finding.evidence?.page);
  const impact = finding.expectedImpact;
  const action = finding.recommendedAction;
  const IconComponent = cat.icon;

  return (
    <div className="rounded-3xl border border-slate-200/50 bg-gradient-to-br from-white to-slate-50/40 p-4 transition-all duration-300 hover:shadow-md hover:border-slate-300 relative overflow-hidden shadow-sm">
      <div className="absolute top-0 inset-x-0 h-1" style={{ background: pr.color }} />

      <div className="flex items-start gap-3">
        <span
          className="w-8 h-8 rounded-xl grid place-items-center shrink-0 border shadow-sm"
          style={{ backgroundColor: cat.bgLight, color: cat.color, borderColor: cat.borderLight }}
        >
          <IconComponent size={14} strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-[9px] font-black uppercase tracking-wider text-slate-400 flex items-center gap-1.5 flex-wrap">
            <span>{cat.label} · {pr.label}</span>
            {pagePath && <span className="text-slate-350 font-mono normal-case truncate">· {pagePath}</span>}
          </div>
          <h4 className="text-[13px] font-extrabold text-slate-900 leading-snug">
            {headlineFor(finding, cat)}
          </h4>
          <p className="text-[11px] font-semibold text-slate-505 leading-relaxed">
            {finding.whyItMatters}
          </p>
          {(impact?.label || finding.confidence != null) && (
            <div className="flex items-center gap-3 flex-wrap pt-0.5 text-[10px] font-bold text-slate-500">
              {impact?.label && (
                <span className="inline-flex items-center gap-1">
                  <TrendingUp size={11} className="text-slate-400" />
                  {impact.label} impact{impact.basis === 'estimate' ? ' (estimate)' : ''}
                </span>
              )}
              {finding.confidence != null && (
                <span className="inline-flex items-center gap-1">
                  <Sparkles size={11} className="text-slate-400" />
                  {Math.round(finding.confidence * 100)}% AI confidence
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {action?.generatorId && (
        <button
          type="button"
          onClick={() => onGenerate(finding)}
          disabled={generating}
          className="w-full mt-3.5 text-[11px] font-black uppercase tracking-wider py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm hover:shadow-indigo-500/20 cursor-pointer"
          style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
        >
          {generating ? 'Generating Fix…' : 'Generate Fix →'}
        </button>
      )}
    </div>
  );
}
