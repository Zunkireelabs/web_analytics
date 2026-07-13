import { CATEGORY } from './AgentCard.jsx';

// Growth-framed, deliberately separate from DiscoveryCard's issue framing —
// a pure problem list reads as "your site is broken"; this section is where
// the upside lives (opportunity + country-intelligence findings only).
export default function OpportunityCard({ finding }) {
  const cat = CATEGORY[finding.category] || CATEGORY.seo;

  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 transition-colors hover:border-slate-200">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
          style={{ color: cat.color, background: `${cat.color}1a` }}>{cat.label}</span>
        {finding.expectedImpact?.basis === 'estimate' && (
          <span className="text-[10px] font-medium text-slate-400 border border-slate-200 rounded px-1.5 py-0.5">estimated</span>
        )}
      </div>
      <p className="text-[13.5px] font-semibold text-slate-800 leading-snug mb-1">
        {finding.recommendedAction?.label || finding.agentName}
      </p>
      <p className="text-xs text-slate-500 leading-snug">{finding.whyItMatters}</p>
    </div>
  );
}
