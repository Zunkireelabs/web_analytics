import { Link } from 'react-router-dom';
import { TrendingUp, Search, FileText, Lightbulb } from 'lucide-react';
import { TrayCard } from './layout/Tray.jsx';
import Badge from './Badge.jsx';

const num = (v) => Number(v || 0);
const pathname = (v) => { try { return new URL(v).pathname || '/'; } catch { return v || '/'; } };

// Icon-tile colour per insight tone; only 'warning' is tinted, the rest are neutral.
const TONE = {
  success: 'bg-muted text-text',
  warning: 'bg-[#fdf3e1] text-[#8a5300]',
  info: 'bg-muted text-text',
  purple: 'bg-muted text-text',
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
    <TrayCard title="Quick insights" subtitle="What changed and what to do next" action={<Badge tone="outline">Rule-based</Badge>}>
      <div className="border-t border-border">
        {loading ? (
          <div className="py-14 text-center text-sm text-faint">Analyzing…</div>
        ) : insights.length === 0 ? (
          <div className="py-14 text-center text-sm text-faint">Not enough data yet for insights.</div>
        ) : (
          insights.map((ins, i) => {
            const Icon = ins.icon;
            return (
              <div key={i} className="flex gap-3 px-4 py-3.5 border-b border-border last:border-0">
                <span className={`w-7 h-7 rounded-control grid place-items-center shrink-0 ${TONE[ins.tone]}`}>
                  <Icon size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg">{ins.title}</div>
                  <p className="text-[13px] text-text mt-0.5">
                    {ins.text}{' '}
                    {ins.action && (ins.to
                      ? <Link to={ins.to} className="text-primary font-medium hover:underline">{ins.action}.</Link>
                      : <span className="text-fg font-medium">{ins.action}.</span>)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </TrayCard>
  );
}
