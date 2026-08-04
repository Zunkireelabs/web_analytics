import { useEffect, useState, useCallback } from 'react';
import { api, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import StatTile from '../components/StatTile.jsx';
import Sparkline from '../components/Sparkline.jsx';
import RecommendationItem from '../components/RecommendationItem.jsx';
import DraftModal from '../components/DraftModal.jsx';
import { Globe2, ListChecks, History } from 'lucide-react';

const SCORE_TONE = (score) => (score >= 70 ? 'success' : score >= 40 ? 'warning' : 'critical');

function CategoryBreakdown({ categories }) {
  if (!categories) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(categories).map(([cat, val]) => (
        <span key={cat} className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-[11px] text-slate-700 font-extrabold tracking-tight">
          {cat}: {val}/100
        </span>
      ))}
    </div>
  );
}

function AuditHistoryRow({ audit, onOpen }) {
  const score = audit.content?.score?.overall;
  return (
    <button type="button" onClick={() => onOpen(audit)}
      className="w-full flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-slate-200/70 bg-white hover:bg-slate-50/60 hover:border-slate-300 transition-colors text-left cursor-pointer">
      <div className="flex items-center gap-3">
        <span className={`text-xs font-black tabular-nums ${score >= 70 ? 'text-emerald-600' : score >= 40 ? 'text-amber-600' : score != null ? 'text-rose-600' : 'text-slate-400'}`}>
          {score != null ? `${score}/100` : 'No score'}
        </span>
        <span className="text-[11px] font-semibold text-slate-400">{timeAgo(audit.created_at)}</span>
      </div>
      <span className="text-[11px] font-semibold text-slate-500">
        {audit.content?.pagesAnalyzed ?? 0} page{audit.content?.pagesAnalyzed === 1 ? '' : 's'} analyzed
      </span>
    </button>
  );
}

export default function GeoAudit() {
  const [audits, setAudits] = useState(null); // null = loading
  const [recs, setRecs] = useState(null);
  const [triggering, setTriggering] = useState(false);
  const [activeDraft, setActiveDraft] = useState(null);
  const [error, setError] = useState(null);

  const loadAudits = useCallback(() => api.actionCenter.drafts({ actionType: 'geo-audit' }).then(setAudits).catch(() => setAudits([])), []);
  const loadRecs = useCallback(() => api.actionCenter.recommendations().then(setRecs).catch(() => setRecs({ items: [] })), []);

  useEffect(() => { loadAudits(); loadRecs(); }, [loadAudits, loadRecs]);

  const runAudit = async () => {
    setTriggering(true);
    setError(null);
    try {
      // Same generateDraft path as the weekly cron job and the MCP
      // generate_geo_audit tool — one canonical execution, three callers.
      const draft = await api.actionCenter.generate('geo-audit', {}, 'manual');
      await loadAudits();
      setActiveDraft(draft);
    } catch (e) {
      setError(e.message || 'Failed to run GEO audit');
    } finally {
      setTriggering(false);
    }
  };

  const loading = audits === null;
  const latest = audits?.[0] || null;
  const trendScores = (audits || [])
    .slice()
    .reverse()
    .map((a) => a.content?.score?.overall)
    .filter((v) => typeof v === 'number');

  const geoAuditItems = (recs?.items || []).filter((i) => i.source === 'geo-audit');
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const topRecommendations = [...geoAuditItems].sort((a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1)).slice(0, 8);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <PageHeader
        title="GEO Audit"
        subtitle="AI visibility score, crawlability, and generative-engine optimization"
        icon={<Globe2 size={20} />}
        right={
          <button type="button" onClick={runAudit} disabled={triggering}
            className="px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider text-white shadow-lg disabled:opacity-50
                       transition-transform hover:scale-[1.02]"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', boxShadow: '0 8px 20px -4px rgba(108,99,255,0.4)' }}>
            {triggering ? 'Running…' : 'Run Audit'}
          </button>
        }
      />

      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 text-xs font-semibold px-4 py-3">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-400">Loading…</div>
      ) : !audits.length ? (
        <div className="rounded-2xl border border-dashed border-slate-200 px-5 py-10 text-center text-sm text-slate-400">
          No GEO audits have run yet — click "Run Audit" to score this site's AI visibility.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatTile
              label="Overall AI Visibility Score"
              value={latest.content?.score?.overall ?? '—'}
              tone={typeof latest.content?.score?.overall === 'number' ? SCORE_TONE(latest.content.score.overall) : 'default'}
              icon="✨"
            />
            <StatTile label="Pages Analyzed" value={latest.content?.pagesAnalyzed ?? 0} icon="🕐" />
            <StatTile label="Last Audit" value={timeAgo(latest.created_at)} icon="🤖" />
          </div>

          {trendScores.length >= 2 && (
            <div className="card p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Score Trend ({trendScores.length} audits)</div>
              <Sparkline data={trendScores} color="#0ea5e9" stretch height={40} />
            </div>
          )}

          {latest.content?.score?.categories && (
            <div className="card p-4 space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Category Breakdown</div>
              <CategoryBreakdown categories={latest.content.score.categories} />
            </div>
          )}

          <div className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 px-1 flex items-center gap-1.5">
              <ListChecks size={12} className="text-indigo-550" />
              <span>Top Recommendations ({geoAuditItems.length})</span>
            </div>
            {topRecommendations.length ? (
              <div className="space-y-2">
                {topRecommendations.map((item) => (
                  <RecommendationItem key={item.id} item={item} onGenerated={loadRecs} />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 px-5 py-6 text-center text-xs text-slate-400">
                No open recommendations — everything from the latest audit has been actioned, or the audit found nothing to fix.
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 px-1 flex items-center gap-1.5">
              <History size={12} className="text-indigo-550" />
              <span>Recent Audits ({audits.length})</span>
            </div>
            <div className="space-y-2">
              {audits.map((a) => <AuditHistoryRow key={a.id} audit={a} onOpen={setActiveDraft} />)}
            </div>
          </div>
        </>
      )}

      {activeDraft && (
        <DraftModal
          key={activeDraft.id}
          draft={activeDraft}
          onClose={() => setActiveDraft(null)}
          onSaved={(updated) => setActiveDraft(updated)}
          onDeleted={() => { setActiveDraft(null); loadAudits(); }}
        />
      )}
    </div>
  );
}
