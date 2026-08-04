import { Target, Globe, FileText, BrainCircuit, TrendingUp, Sparkles, ShieldCheck } from 'lucide-react';

const CATEGORY_META = {
  seo: { label: 'SEO', icon: Target, color: '#6C63FF', bgLight: '#6C63FF0c', borderLight: '#6C63FF1e' },
  geo: { label: 'Audience', icon: Globe, color: '#0ea5e9', bgLight: '#0ea5e90c', borderLight: '#0ea5e91e' },
  content: { label: 'Content', icon: FileText, color: '#14b8a6', bgLight: '#14b8a60c', borderLight: '#14b8a61e' },
  meta: { label: 'Overview', icon: BrainCircuit, color: '#ec4899', bgLight: '#ec48990c', borderLight: '#ec48991e' },
  compliance: { label: 'Trust & Compliance', icon: ShieldCheck, color: '#f59e0b', bgLight: '#f59e0b0c', borderLight: '#f59e0b1e' }
};

export default function OpportunityCard({ finding, generating, onGenerate }) {
  const catKey = finding.category || 'seo';
  const cat = CATEGORY_META[catKey] || CATEGORY_META.seo;
  const impact = finding.expectedImpact;
  const action = finding.recommendedAction;
  const IconComponent = cat.icon;

  return (
    <div className="rounded-3xl border border-slate-200/50 bg-gradient-to-br from-white to-emerald-50/10 p-4 transition-all duration-300 hover:shadow-md hover:border-emerald-200 relative overflow-hidden shadow-sm">
      <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-emerald-500 to-emerald-300" />

      <div className="flex items-start gap-3">
        <span
          className="w-8 h-8 rounded-xl grid place-items-center shrink-0 border shadow-sm"
          style={{ backgroundColor: `${cat.color}0c`, color: cat.color, borderColor: `${cat.color}1e` }}
        >
          <IconComponent size={14} strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">{cat.label} · Growth Idea</div>
          <h4 className="text-[13px] font-extrabold text-slate-900 leading-snug">
            {finding.recommendedAction?.label || 'Growth Opportunity'}
          </h4>
          <p className="text-[11px] font-semibold text-slate-505 leading-relaxed">
            {finding.whyItMatters}
          </p>
          {(impact?.label || finding.confidence != null) && (
            <div className="flex items-center gap-3 flex-wrap pt-0.5 text-[10px] font-bold text-slate-500">
              {impact?.label && (
                <span className="inline-flex items-center gap-1">
                  <TrendingUp size={11} className="text-emerald-500" />
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
          className="w-full mt-3.5 text-[11px] font-black uppercase tracking-wider py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm hover:shadow-emerald-500/20 cursor-pointer"
          style={{ background: 'linear-gradient(135deg,#10b981,#14b8a6)' }}
        >
          {generating ? 'Generating Fix…' : 'Generate Fix →'}
        </button>
      )}
    </div>
  );
}
