import { useState } from 'react';
import { pagePathFor } from '../api.js';
import { 
  Target, 
  Globe, 
  FileText, 
  BrainCircuit, 
  ChevronDown,
  ChevronUp,
  TrendingUp,
  AlertCircle
} from 'lucide-react';

const PRIORITY = {
  high: { color: '#e11d48', label: 'High Priority', bg: '#fff1f2', text: '#e11d48' },
  medium: { color: '#f59e0b', label: 'Medium Priority', bg: '#fffbeb', text: '#d97706' },
  low: { color: '#64748b', label: 'Info', bg: '#f8fafc', text: '#64748b' },
};

const CATEGORY_META = {
  seo: { label: 'SEO & Tech', icon: Target, color: '#6C63FF', bgLight: '#6C63FF0c', borderLight: '#6C63FF1e' },
  geo: { label: 'Geo Target', icon: Globe, color: '#0ea5e9', bgLight: '#0ea5e90c', borderLight: '#0ea5e91e' },
  content: { label: 'Content Audit', icon: FileText, color: '#14b8a6', bgLight: '#14b8a60c', borderLight: '#14b8a61e' },
  meta: { label: 'Executive Brief', icon: BrainCircuit, color: '#ec4899', bgLight: '#ec48990c', borderLight: '#ec48991e' }
};

function headlineFor(finding, cat) {
  if (finding.recommendedAction?.label) return finding.recommendedAction.label;
  if (finding.evidence?.gapType) return finding.evidence.gapType;
  if (finding.id?.includes(':low-ctr:')) return `Low Click-Through Rate (${finding.evidence?.device || 'Device'})`.trim();
  if (finding.id?.includes(':declining:')) return `Declining Traffic Trends (${finding.evidence?.device || 'Device'})`.trim();
  if (finding.id?.startsWith('query-intelligence:dropper:')) return 'Search Query Impressions Drop';
  return `${cat.label} Diagnostic Finding`;
}

export const EVIDENCE_LABEL = {
  page: 'Page Route', impressions: 'Impressions Count', clicks: 'Clicks Count', avgPosition: 'Avg. Position',
  score: 'Audit Score', country: 'Country', city: 'City', device: 'Target Device', query: 'Search Query',
  language: 'Target Language', recent: 'Recent Period Clicks', prior: 'Prior Period Clicks', delta: 'Click Delta', ctr: 'Average CTR',
  ctrDeviationPct: 'CTR Variance %', gapType: 'Gap Type', detail: 'Technical Details', entity: 'Identified Entity',
  competitorsWithThisFeature: 'Competitors with citation', competitorsTracked: 'Competitors Tracked',
  agentName: 'Assigned Agent', confidence: 'LLM Confidence Score', estimate: 'Expected Return basis',
  domain: 'Domain', referringDomains: 'Referring Domains', graphRank: 'Graph Rank',
  graphRelease: 'Graph Release', source: 'Data Source', ownDomain: 'Your Domain',
  referringDomainGap: 'Referring Domain Gap',
};

export default function DiscoveryCard({ finding }) {
  const [expanded, setExpanded] = useState(false);
  const catKey = finding.category || 'seo';
  const cat = CATEGORY_META[catKey] || CATEGORY_META.seo;
  const pr = PRIORITY[finding.priority] || PRIORITY.low;

  const extraEntries = [
    finding.agentName && ['agentName', finding.agentName],
    finding.confidence && ['confidence', `${(finding.confidence * 100).toFixed(0)}%`],
    finding.expectedImpact?.basis === 'estimate' && ['estimate', 'Model Estimated'],
  ].filter(Boolean);

  const evidenceEntries = [...extraEntries, ...Object.entries(finding.evidence || {}).filter(([, v]) => v != null && v !== '')];
  const pagePath = pagePathFor(finding.evidence?.page);
  const IconComponent = cat.icon;

  return (
    <div className="rounded-3xl border border-slate-200/50 bg-gradient-to-br from-white to-slate-50/40 p-4 transition-all duration-300 hover:shadow-md hover:border-slate-300 relative group overflow-hidden flex flex-col justify-between shadow-sm">
      {/* Decorative Severity Stripe */}
      <div className="absolute top-0 inset-x-0 h-1" style={{ background: pr.color }} />

      <div>
        {/* Row 1: Badges & Severity */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span 
              className="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border"
              style={{ color: cat.color, backgroundColor: cat.bgLight, borderColor: cat.borderLight }}
            >
              {cat.label}
            </span>
            <span 
              className="text-[9px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full"
              style={{ backgroundColor: pr.bg, color: pr.text }}
            >
              {pr.label}
            </span>
          </div>
        </div>

        {/* Row 2: Headline & Description */}
        <div className="flex items-start gap-3">
          <span 
            className="w-8 h-8 rounded-xl grid place-items-center shrink-0 border shadow-sm"
            style={{ backgroundColor: cat.bgLight, color: cat.color, borderColor: cat.borderLight }}
          >
            <IconComponent size={14} strokeWidth={2.25} />
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="text-[13px] font-extrabold text-slate-900 leading-snug group-hover:text-indigo-650 transition-colors">
              {headlineFor(finding, cat)}
            </h4>
            <p className="text-[11px] font-semibold text-slate-505 leading-relaxed mt-2.5 break-words">
              {finding.whyItMatters}
            </p>
          </div>
        </div>
      </div>

      {/* Detail Drawer */}
      {evidenceEntries.length > 0 && (
        <div className="mt-3">
          {!expanded ? (
            <button 
              type="button" 
              onClick={() => setExpanded(true)}
              className="text-[9px] font-black uppercase tracking-wider text-[#6C63FF]/85 hover:text-[#6C63FF] flex items-center gap-1 py-2 focus:outline-none cursor-pointer"
            >
              Show parameters <ChevronDown size={10} />
            </button>
          ) : (
            <div className="flex flex-col gap-3 pt-3 border-t border-slate-100/50 animate-slide-down">
              <div className="bg-slate-950/85 border border-slate-800 rounded-2xl p-2.5 space-y-1 shadow-inner">
                {evidenceEntries.map(([k, v]) => (
                  <div key={k} className="flex justify-between items-center text-[9px] font-mono leading-tight">
                    <span className="text-slate-500">{EVIDENCE_LABEL[k] || k}</span>
                    <span className="text-slate-300 font-bold max-w-[150px] truncate text-right">
                      {String(v)}
                    </span>
                  </div>
                ))}
              </div>
              <button 
                type="button" 
                onClick={() => setExpanded(false)}
                className="text-[9px] font-black uppercase tracking-wider text-[#6C63FF]/85 hover:text-[#6C63FF] flex items-center gap-1 focus:outline-none cursor-pointer"
              >
                Hide parameters <ChevronUp size={10} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
