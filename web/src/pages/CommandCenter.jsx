import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, daysAgo, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import HealthScoreCard from '../components/HealthScoreCard.jsx';
import ExecutiveSummaryPanel from '../components/ExecutiveSummaryPanel.jsx';
import StatTile from '../components/StatTile.jsx';
import CriticalIssueCard from '../components/CriticalIssueCard.jsx';
import DiscoveryCard from '../components/DiscoveryCard.jsx';
import OpportunityCard from '../components/OpportunityCard.jsx';
import ActionRow from '../components/ActionRow.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import ChangesTimeline from '../components/ChangesTimeline.jsx';
import DraftModal from '../components/DraftModal.jsx';
import IntegrationHealthCard from '../components/IntegrationHealthCard.jsx';
import WatchlistCard from '../components/WatchlistCard.jsx';

const STATUS_INFO = {
  complete: { label: 'Analysis complete', dotClass: 'bg-emerald-500', textClass: 'text-emerald-700', bgClass: 'bg-emerald-50' },
  partial: { label: 'Partial analysis', dotClass: 'bg-amber-500', textClass: 'text-amber-700', bgClass: 'bg-amber-50' },
  error: { label: 'Analysis error', dotClass: 'bg-rose-500', textClass: 'text-rose-700', bgClass: 'bg-rose-50' },
  'never-run': { label: 'Not yet analyzed', dotClass: 'bg-slate-400', textClass: 'text-slate-500', bgClass: 'bg-slate-100' },
};

function SectionHeader({ title, desc, count }) {
  return (
    <div className="mb-3.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-bold tracking-tight text-slate-900">{title}</h2>
        {count != null && <span className="text-xs font-mono font-semibold text-slate-400">{count}</span>}
      </div>
      {desc && <p className="text-[13px] text-slate-500 mt-1 max-w-2xl">{desc}</p>}
    </div>
  );
}

function CardSkeleton({ h = 'h-24' }) {
  return <div className={`card ${h} animate-pulse`} />;
}
function GridSkeleton({ count, className }) {
  return (
    <div className={className}>
      {Array.from({ length: count }).map((_, i) => <CardSkeleton key={i} />)}
    </div>
  );
}

// The default landing experience after login for the internal team — "an AI
// analyst that already did the work," not a menu of 7 tools to run one at a
// time. Reads only already-persisted agent runs by default (instant); the
// 7-agent grid this replaced as the primary view still exists at
// /ai-growth/advanced for anyone who wants to run or inspect one agent.
export default function CommandCenter() {
  const [data, setData] = useState(null); // null = loading
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [generatingId, setGeneratingId] = useState(null);
  const [activeDraft, setActiveDraft] = useState(null);
  const [integrations, setIntegrations] = useState(null); // null = loading
  const [checkingId, setCheckingId] = useState(null);

  const load = () => api.commandCenter.get().then(setData).catch((e) => setError(e.message || 'Failed to load'));
  useEffect(() => { load(); }, []);
  useEffect(() => { api.integrations.health().then(setIntegrations).catch(() => setIntegrations([])); }, []);

  const checkIntegration = async (id) => {
    setCheckingId(id);
    try {
      const result = await api.integrations.check(id);
      setIntegrations((prev) => (prev || []).map((i) => (i.id === id ? { ...i, ...result } : i)));
    } catch {
      // leave prior status in place — the check itself failing (network, etc.)
      // isn't the same as the integration being unhealthy.
    } finally {
      setCheckingId(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await api.commandCenter.refresh(daysAgo(7), daysAgo(0));
      setData(fresh);
    } catch (e) {
      setError(e.message || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  // Normalized generate — Recommended Actions items (buildRecommendations
  // shape: {id, source, generatorId, params}) and Critical Issue findings
  // ({id, agentId, recommendedAction: {generatorId, params}}) both adapt to
  // this one call so there's a single draft-generation path, not two.
  const generate = async ({ id, generatorId, params, source }) => {
    setGeneratingId(id);
    setError(null);
    try {
      const draft = await api.actionCenter.generate(generatorId, params, source);
      setActiveDraft(draft);
    } catch (e) {
      setError(e.message || 'Generation failed');
    } finally {
      setGeneratingId(null);
    }
  };
  const generateFromAction = (item) => generate(item);
  const generateFromFinding = (finding) => generate({
    id: finding.id, generatorId: finding.recommendedAction?.generatorId,
    params: finding.recommendedAction?.params, source: finding.agentId,
  });
  const generateFromWatchlistItem = (item) => generate({
    id: `watchlist:${item.id}`, generatorId: item.recommendedAction?.generatorId,
    params: item.recommendedAction?.params, source: item.agentId,
  });

  // User-driven status change on a watchlist item (Start / Mark complete /
  // Dismiss) — optimistic locally, since the item leaves the "open" list
  // immediately once it's completed/dismissed and there's nothing to roll
  // back to if the request fails beyond showing the error.
  const setWatchlistStatus = async (id, status) => {
    setError(null);
    try {
      await api.watchlist.setStatus(id, status);
      setData((d) => d && {
        ...d,
        watchlist: status === 'in_progress'
          ? d.watchlist.map((w) => (w.id === id ? { ...w, status } : w))
          : d.watchlist.filter((w) => w.id !== id),
      });
    } catch (e) {
      setError(e.message || 'Could not update watchlist item');
    }
  };

  const status = STATUS_INFO[data?.stats?.analysisStatus] || STATUS_INFO['never-run'];
  const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-9">
      {/* Executive Header — greeting, analysis status, and last-run time all
          answer one question before anything else: is this fresh? */}
      <PageHeader
        title="Good morning — here's what your AI analyst found."
        icon="🧠"
        right={
          <button type="button" onClick={refresh} disabled={refreshing}
            className={`text-xs font-semibold px-3.5 py-2 rounded-lg text-white transition disabled:opacity-60 ${focusRing}`}
            style={{ background: '#6C63FF' }}>
            {refreshing ? 'Refreshing… (~1-2 min)' : 'Refresh analysis'}
          </button>
        }
      />
      <div className="flex items-center gap-3 -mt-5 flex-wrap text-xs text-slate-500">
        <span className={`inline-flex items-center gap-1.5 font-semibold px-2.5 py-1 rounded-full ${status.textClass} ${status.bgClass}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dotClass}`} />
          {status.label}
        </span>
        {data?.stats?.lastAnalyzedAt && <span>Last analyzed {timeAgo(data.stats.lastAnalyzedAt)}</span>}
      </div>

      {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 fade-up">{error}</div>}

      {/* Website Health + Executive AI Briefing — the hero. A number never
          appears without its explanation next to it. */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        <div className="card overflow-hidden">
          <HealthScoreCard score={data?.health?.score} trendWeek={data?.health?.trendWeek} loading={data === null} />
        </div>
        <ExecutiveSummaryPanel
          text={data?.executiveSummary?.narrative}
          source={data?.executiveSummary?.narrative ? 'executive-report' : null}
          generatedAt={data?.executiveSummary?.generatedAt}
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Critical Issues" value={data?.stats?.criticalIssues ?? '—'} tone="critical" sub="Needs attention this week" loading={data === null} />
        <StatTile label="New Opportunities" value={data?.stats?.newOpportunities ?? '—'} tone="accent" sub="Actionable, ready to draft" loading={data === null} />
        <StatTile label="Analysis Status" value={status.label.split(' ')[0]} sub="7 specialist agents" loading={data === null} />
        <StatTile label="Last Analysis" value={data?.stats?.lastAnalyzedAt ? timeAgo(data.stats.lastAnalyzedAt) : '—'} sub="Refresh anytime" loading={data === null} />
      </div>

      {/* Critical Issues — the top-of-briefing callout, small and curated on
          purpose ("avoid overwhelming users"); the full breadth lives in AI
          Discoveries below. */}
      <section>
        <SectionHeader title="Critical Issues" count={data ? `${data.criticalIssues.length} shown` : null}
          desc="The highest-priority problems only — title, evidence, why it matters, and one clear fix." />
        {data === null ? (
          <GridSkeleton count={3} className="grid grid-cols-1 md:grid-cols-3 gap-3" />
        ) : data.criticalIssues.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-400">No critical issues right now.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 fade-up">
            {data.criticalIssues.map((f) => (
              <CriticalIssueCard key={f.id} finding={f} generating={generatingId === f.id} onGenerate={generateFromFinding} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeader
          title="AI Discoveries"
          count={data ? `${data.discoveries.length} shown` : null}
          desc="What your analyst noticed, backed by real evidence — the specific things that changed and why they matter, not a summary of metrics."
        />
        {data === null ? (
          <GridSkeleton count={6} className="grid grid-cols-1 md:grid-cols-2 gap-2.5" />
        ) : data.discoveries.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-400">No discoveries yet — run a refresh to analyze your site.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 fade-up">
            {data.discoveries.map((f) => <DiscoveryCard key={f.id} finding={f} />)}
          </div>
        )}
      </section>

      <section>
        <SectionHeader
          title="Growth Opportunities"
          count={data ? `${data.growthOpportunities.length} shown` : null}
          desc="Findings that could increase traffic, rankings, or AI visibility — kept separate from issues so the upside never gets buried."
        />
        {data === null ? (
          <GridSkeleton count={4} className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" />
        ) : data.growthOpportunities.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-400">No growth opportunities detected this period.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 fade-up">
            {data.growthOpportunities.map((f) => <OpportunityCard key={f.id} finding={f} />)}
          </div>
        )}
      </section>

      {/* Opportunity Watchlist — a persistent queue, not a snapshot of this
          run: items stay here across visits until they're resolved (closed
          automatically once real evidence — a generated draft — shows the
          action was taken) or no longer qualify (closed automatically once
          the underlying finding disappears with no such evidence). */}
      <section>
        <SectionHeader
          title="Opportunity Watchlist"
          count={data ? `${data.watchlist.length} open` : null}
          desc="High-value opportunities tracked until they're resolved — not a snapshot of today's run, a queue that updates itself as new analyses come in."
        />
        {data === null ? (
          <GridSkeleton count={3} className="grid grid-cols-1 md:grid-cols-3 gap-3" />
        ) : data.watchlist.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-400">Nothing on the watchlist yet — high-value opportunities are added automatically as they're found.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 fade-up">
            {data.watchlist.map((item) => (
              <WatchlistCard key={item.id} item={item} generating={generatingId === `watchlist:${item.id}`}
                onGenerate={generateFromWatchlistItem} onStatusChange={setWatchlistStatus} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeader
          title="Recommended Actions"
          count={data ? `${data.recommendedActions.length} shown` : null}
          desc="One click from insight to draft — nothing here publishes automatically."
        />
        {data === null ? (
          <CardSkeleton h="h-48" />
        ) : data.recommendedActions.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-400">No draftable actions yet.</div>
        ) : (
          <div className="card divide-y divide-slate-50 fade-up">
            {data.recommendedActions.map((item) => (
              <ActionRow key={item.id} item={item} generating={generatingId === item.id} onGenerate={generateFromAction} />
            ))}
          </div>
        )}
      </section>

      {/* Integration Health — is the machinery itself working. Grows
          automatically as more integrations are registered (server/integrations/*.js);
          today that's just Google OAuth. */}
      <section>
        <SectionHeader
          title="Integration Health"
          count={integrations ? `${integrations.length} tracked` : null}
          desc="Live status of every external connection this platform depends on."
        />
        {integrations === null ? (
          <GridSkeleton count={1} className="grid grid-cols-1 lg:grid-cols-2 gap-3" />
        ) : integrations.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-400">No integrations registered yet.</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 fade-up">
            {integrations.map((i) => (
              <IntegrationHealthCard key={i.id} integration={i} checking={checkingId === i.id}
                onCheck={() => checkIntegration(i.id)} />
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <SectionHeader title="AI Activity" desc="What your analyst has been doing in the background — every line is a real completed run." />
          {data === null ? <CardSkeleton h="h-56" /> : <ActivityFeed items={data.activity} />}
        </section>
        <section>
          <SectionHeader title="Recent Changes" desc="What's new since your last visit, and what's already been resolved." />
          {data === null ? <CardSkeleton h="h-56" /> : <ChangesTimeline items={data.recentChanges} />}
        </section>
      </div>

      <div className="text-center pt-2 border-t border-slate-100">
        <Link to="/ai-growth/advanced"
          className={`inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#6C63FF] transition rounded ${focusRing}`}>
          Looking for a specific agent? Open Advanced Analysis →
        </Link>
      </div>

      {activeDraft && <DraftModal draft={activeDraft} onClose={() => setActiveDraft(null)} onSaved={setActiveDraft} onDeleted={() => setActiveDraft(null)} />}
    </div>
  );
}
