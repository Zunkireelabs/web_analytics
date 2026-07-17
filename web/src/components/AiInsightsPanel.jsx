import { Link } from 'react-router-dom';
import { TrendingUp, Search, FileText, Lightbulb } from 'lucide-react';

const num = (v) => Number(v || 0);
const pathname = (v) => { try { return new URL(v).pathname || '/'; } catch { return v || '/'; } };

const TONE = {
  success: { bg: 'rgba(16,185,129,0.06)', fg: '#10b981', border: 'rgba(16,185,129,0.1)' },
  warning: { bg: 'rgba(245,158,11,0.06)', fg: '#f59e0b', border: 'rgba(245,158,11,0.1)' },
  info: { bg: 'rgba(14,165,233,0.06)', fg: '#0ea5e9', border: 'rgba(14,165,233,0.1)' },
  purple: { bg: 'rgba(139,92,246,0.06)', fg: '#8b5cf6', border: 'rgba(139,92,246,0.1)' },
};

function buildInsights({ channels, queries, pages }) {
  const insights = [];

  const totalSessions = (channels || []).reduce((s, c) => s + num(c.sessions), 0);
  const topChannel = [...(channels || [])].sort((a, b) => num(b.sessions) - num(a.sessions))[0];
  if (topChannel && totalSessions > 0) {
    const share = Math.round((num(topChannel.sessions) / totalSessions) * 100);
    if (share >= 70) {
      insights.push({
        tone: 'success', icon: TrendingUp,
        title: `Dominant traffic from ${topChannel.channel}`,
        text: `${share}% of sessions this period came from ${topChannel.channel} traffic.`,
        action: 'Diversify channels', to: '/insights',
      });
    }
  }

  const topQueries = [...(queries || [])].sort((a, b) => num(b.impressions) - num(a.impressions)).slice(0, 5);
  const topQClicks = topQueries.reduce((s, q) => s + num(q.clicks), 0);
  const topQImpr = topQueries.reduce((s, q) => s + num(q.impressions), 0);
  if (topQueries.length && topQClicks === 0 && topQImpr > 0) {
    insights.push({
      tone: 'warning', icon: Search,
      title: 'Zero clicks from top queries',
      text: 'Your top queries by impressions have no clicks yet.',
      action: 'Optimize metadata',
    });
  }

  const topPage = [...(pages || [])].sort((a, b) => num(b.impressions) - num(a.impressions))[0];
  if (topPage) {
    insights.push({
      tone: 'info', icon: FileText,
      title: 'Top landing page drives volume',
      text: `"${pathname(topPage.dim_value)}" brings the highest impressions.`,
      action: 'Improve internal links',
    });
  }

  if (topQueries.length >= 2) {
    insights.push({
      tone: 'purple', icon: Lightbulb,
      title: 'Expansion Opportunity',
      text: `Create focused content around "${topQueries[0].dim_value}" to capture search demand.`,
    });
  }

  return insights.slice(0, 4);
}

// Deliberately not labeled "AI" — buildInsights() below is a plain rules
// engine (threshold checks over real metrics), not an LLM call.
export default function AiInsightsPanel({ channels, queries, pages, loading }) {
  const insights = buildInsights({ channels, queries, pages });

  return (
    <div className="card p-6 flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold text-slate-900 tracking-tight">Quick Insights</h3>
          <span className="text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100/80 border border-slate-200/30 text-slate-500">
            Rule Engine
          </span>
        </div>

        {loading ? (
          <div className="py-14 text-center text-sm text-slate-400 animate-pulse font-medium">Analyzing…</div>
        ) : insights.length === 0 ? (
          <div className="py-14 text-center text-sm text-slate-400 font-medium">Not enough data yet for insights.</div>
        ) : (
          <div className="space-y-3">
            {insights.map((ins, i) => {
              const tone = TONE[ins.tone];
              const Icon = ins.icon;
              return (
                <div 
                  key={i} 
                  className="flex items-start gap-3 p-3 rounded-2xl border transition duration-200 hover:translate-x-0.5"
                  style={{ background: tone.bg, borderColor: tone.border }}
                >
                  <span 
                    className="w-7 h-7 rounded-xl grid place-items-center shrink-0 shadow-sm" 
                    style={{ background: '#fff', color: tone.fg }}
                  >
                    <Icon size={14} strokeWidth={2.5} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-900 leading-snug">{ins.title}</div>
                    <p className="text-[11px] font-medium text-slate-500 leading-relaxed mt-1">
                      {ins.text}{' '}
                      {ins.action && (ins.to
                        ? <Link to={ins.to} className="font-bold text-indigo-600 hover:text-indigo-700 underline decoration-indigo-200/60 decoration-2 underline-offset-1">{ins.action}.</Link>
                        : <span className="font-bold text-slate-700">{ins.action}.</span>)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
