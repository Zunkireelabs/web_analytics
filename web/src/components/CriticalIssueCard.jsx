import { CATEGORY } from './AgentCard.jsx';

// The top-of-briefing callout — a small, curated subset of AI Discoveries
// (see command-center.js's `criticalIssues`). Unlike DiscoveryCard, every
// field the spec calls for is explicit and always visible, not progressive:
// title, evidence, why it matters, expected impact, and one clear action —
// this section exists specifically so a user never has to click into
// anything to understand the single most urgent thing.
export default function CriticalIssueCard({ finding, generating, onGenerate }) {
  const cat = CATEGORY[finding.category] || CATEGORY.seo;
  const impact = finding.expectedImpact;
  const action = finding.recommendedAction;

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
          {finding.agentName && <span className="text-[10px] font-medium text-slate-400">· {finding.agentName}</span>}
        </div>
        {impact && (
          <span className="text-[10px] font-semibold text-slate-400 shrink-0 text-right">
            {impact.label} impact{impact.basis === 'estimate' && <span className="block text-slate-300">estimated</span>}
          </span>
        )}
      </div>

      <div>
        <p className="text-[15px] font-bold text-slate-900 leading-snug">{action?.label || finding.agentName}</p>
        <p className="text-[13px] text-slate-500 leading-relaxed mt-1">{finding.whyItMatters}</p>
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
