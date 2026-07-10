import { Link } from 'react-router-dom';
import { TrendingUp, Search, FileText, Lightbulb, Sparkles } from 'lucide-react';

const num = (v) => Number(v || 0);
const pathname = (v) => { try { return new URL(v).pathname || '/'; } catch { return v || '/'; } };

const TONE = {
  success: { bg: '#ecfdf5', fg: '#059669' },
  warning: { bg: '#fff7ed', fg: '#c2410c' },
  info: { bg: '#eff6ff', fg: '#2563eb' },
  purple: { bg: '#f5f3ff', fg: '#7c3aed' },
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
        title: `Most traffic is from ${topChannel.channel}`,
        text: `${share}% of sessions this period came from ${topChannel.channel} traffic.`,
        action: 'Diversify your channels', to: '/insights',
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
      action: 'Improve meta titles and descriptions',
    });
  }

  const topPage = [...(pages || [])].sort((a, b) => num(b.impressions) - num(a.impressions))[0];
  if (topPage) {
    insights.push({
      tone: 'info', icon: FileText,
      title: 'Top landing page drives most traffic',
      text: `${pathname(topPage.dim_value)} brings the highest impressions.`,
      action: 'Optimize and build internal links',
    });
  }

  if (topQueries.length >= 2) {
    insights.push({
      tone: 'purple', icon: Lightbulb,
      title: 'Opportunity to grow',
      text: `Consider more content around "${topQueries[0].dim_value}" and similar high-impression queries.`,
    });
  }

  return insights.slice(0, 4);
}

export default function AiInsightsPanel({ channels, queries, pages, loading }) {
  const insights = buildInsights({ channels, queries, pages });

  return (
    <div className="card p-6 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[15px] font-semibold text-slate-900 tracking-tight">AI Insights</h3>
        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full bg-indigo-50 text-indigo-600">
          <Sparkles size={11} strokeWidth={2.5} /> Smart analysis
        </span>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-slate-400 animate-pulse">Analyzing…</div>
      ) : insights.length === 0 ? (
        <div className="py-10 text-center text-sm text-slate-400">Not enough data yet for insights.</div>
      ) : (
        <div className="space-y-4 flex-1">
          {insights.map((ins, i) => {
            const tone = TONE[ins.tone];
            const Icon = ins.icon;
            return (
              <div key={i} className="flex items-start gap-3">
                <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0" style={{ background: tone.bg, color: tone.fg }}>
                  <Icon size={15} strokeWidth={2.25} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-slate-800 leading-snug">{ins.title}</div>
                  <p className="text-xs text-slate-500 leading-relaxed mt-0.5">
                    {ins.text}{' '}
                    {ins.action && (ins.to
                      ? <Link to={ins.to} className="font-medium text-indigo-600 hover:text-indigo-700">{ins.action}.</Link>
                      : <span className="font-medium text-slate-600">{ins.action}.</span>)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
