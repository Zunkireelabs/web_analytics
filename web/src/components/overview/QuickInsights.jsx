import { Link } from 'react-router-dom';
import { FileText, Lightbulb, Search, TrendingUp } from 'lucide-react';
import { TrayCard } from '../layout/Tray.jsx';
import Badge from '../Badge.jsx';
import { STATUS } from '../../lib/palette.js';

const ICON = { page: FileText, search: Search, idea: Lightbulb, trend: TrendingUp };
const TAG = {
  opportunity: { label: 'Opportunity', color: STATUS.good.text, tint: STATUS.good.tint },
  attention: { label: 'Needs attention', color: STATUS.warning.text, tint: STATUS.warning.tint },
  growth: { label: 'Growth', color: '#2a5db0', tint: '#eaf1fb' },
};
const COLS = { 1: 'xl:grid-cols-1', 2: 'xl:grid-cols-2', 3: 'xl:grid-cols-3' };
const IMPACT = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };

// Plain notes from the numbers on the page (rules, not a model), each with how much it matters and one next step.
// Only an action that goes somewhere is a link; the rest are shown as the suggested step.
export default function QuickInsights({ insights, loading }) {
  return (
    <TrayCard title="Quick insights" subtitle="What changed and what to do next" action={<Badge tone="outline">Rule-based</Badge>}>
      <div className="border-t border-border">
        {loading ? (
          <div className="py-14 text-center text-sm text-faint">Analyzing…</div>
        ) : insights.length === 0 ? (
          <div className="py-14 text-center text-sm text-faint">Not enough data yet for insights.</div>
        ) : (
          <div className={`grid ${COLS[Math.min(insights.length, 3)]}`}>
            {insights.map((ins) => {
              const Icon = ICON[ins.icon] || Lightbulb;
              const tag = TAG[ins.tag];
              return (
                <article key={ins.key} className="px-4 py-4 border-b border-border last:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0 flex flex-col">
                  <span className="w-8 h-8 rounded-control grid place-items-center shrink-0" style={{ background: tag.tint, color: tag.color }}><Icon size={15} /></span>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-2 text-[11px]">
                    <span className="font-semibold uppercase tracking-[.05em]" style={{ color: tag.color }}>{tag.label}</span>
                    <span className="text-faint">· {IMPACT[ins.impact]}</span>
                  </div>
                  <h3 className="mt-0.5 text-[15px] leading-5 font-semibold text-fg">{ins.title}</h3>
                  <p className="mt-2 text-[13.5px] leading-[21px] text-text">
                    {ins.parts.map((p, i) => (p.b ? <strong key={i} className="font-semibold text-fg">{p.t}</strong> : <span key={i}>{p.t}</span>))}
                  </p>
                  {ins.action && (
                    <div className="mt-3 xl:mt-auto xl:pt-3">
                      {ins.to
                        ? <Link to={ins.to} className="btn btn--light btn--sm">{ins.action}</Link>
                        : <span className="text-[13px] text-text">Next step: <span className="font-medium text-fg">{ins.action}</span></span>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
      {!loading && insights.length > 0 && (
        <div className="flex justify-end px-4 py-2.5 border-t border-border text-[13px]">
          <Link to="/insights" className="text-primary font-medium hover:underline">Open the performance report →</Link>
        </div>
      )}
    </TrayCard>
  );
}
