import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Search, TrendingUp, Send, AlertTriangle, CheckCircle2, ExternalLink, Loader2, Ban } from 'lucide-react';

// Keywords already earning impressions but sitting past page 1. This is the
// honest version of "how much impression will this keyword bring": every
// number here is the site's OWN observed GSC data (keyword_clusters.
// keywords_json, written by the 14-day clustering collector), never an
// estimated or LLM-guessed search volume — no column in this schema stores
// one. A keyword at position 11-30 is already being served to real searchers
// and just isn't being clicked, which makes it the highest-leverage thing to
// improve; ranking below ~30 means the impressions are too thin to act on.
const NEAR_PAGE_ONE_MIN_POSITION = 10;
const NEAR_PAGE_ONE_MAX_POSITION = 30;
const MAX_KEYWORD_ROWS = 15;

// keyword_clusters is append-only — every clustering run writes its own
// snapshot (see migration 079), so one site accumulates the same keyword once
// per run. getKeywordClusters returns newest-first, so keeping the FIRST
// occurrence of each keyword keeps the most recent numbers and drops the
// stale repeats. Without this the list burns its rows on the same handful of
// keywords repeated back to back.
function dedupeByKeyword(rows) {
  const seen = new Set();
  return rows.filter((k) => {
    const key = (k.keyword || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nearPageOne(clusters) {
  const flat = clusters
    .flatMap((c) => (Array.isArray(c.keywords_json) ? c.keywords_json : []).map((k) => ({ ...k, cluster: c.cluster_name })))
    .filter((k) => k.avg_position > NEAR_PAGE_ONE_MIN_POSITION
      && k.avg_position <= NEAR_PAGE_ONE_MAX_POSITION
      && (k.impressions ?? 0) > 0);
  return dedupeByKeyword(flat)
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
    .slice(0, MAX_KEYWORD_ROWS);
}

const PRIORITY_CHIP = { high: 'an-chip-rose', medium: 'an-chip-amber', low: 'an-chip-slate' };
const SOURCE_LABEL = {
  user_request: 'You asked for this',
  claude_research: 'Keyword research',
  internal_analysis: 'Gap analysis',
};

export default function AnalystKeywordOpportunities({ clientId, refreshToken }) {
  const [clusters, setClusters] = useState(null);
  const [gaps, setGaps] = useState(null);
  const [error, setError] = useState(null);
  // Per-gap action state, keyed by gap id: 'sending' | { draftId, draftError }.
  const [gapAction, setGapAction] = useState({});

  // Guards against a slower earlier request overwriting a newer client's data
  // when the selector is changed quickly — only the latest request may commit.
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setClusters(null);
    setGaps(null);
    setError(null);
    setGapAction({});

    Promise.all([api.keywords.clusters(clientId), api.keywords.gaps(clientId)])
      .then(([clusterRows, gapRows]) => {
        if (requestRef.current !== requestId) return;
        setClusters(clusterRows || []);
        setGaps(gapRows || []);
      })
      .catch((e) => {
        if (requestRef.current !== requestId) return;
        setError(e.message || 'Failed to load keyword data.');
      });
  }, [clientId, refreshToken]);

  const keywords = useMemo(() => (clusters ? nearPageOne(clusters) : []), [clusters]);

  // Acting on a gap moves it out of pending_review, which would drop it from
  // this list instantly — taking the "Draft ready in Action Center" confirmation
  // with it. Rows acted on in this session stay visible so the result can be
  // read; they're gone on the next load, by which point the draft is in Action
  // Center where the confirmation pointed.
  //
  // keyword_gaps is append-only for the same reason as keyword_clusters, so
  // the same topic can be queued once per run. Deduped by topic (newest kept,
  // matching getKeywordGaps' newest-first order) so the review queue shows
  // each topic once instead of the same one several times.
  const visibleGaps = useMemo(() => {
    const seen = new Set();
    return (gaps || [])
      .filter((g) => g.status === 'pending_review' || gapAction[g.id])
      .filter((g) => {
        const key = (g.topic || '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [gaps, gapAction]);

  const pendingCount = useMemo(
    () => visibleGaps.filter((g) => g.status === 'pending_review').length,
    [visibleGaps]
  );

  const act = async (gap, status) => {
    setGapAction((prev) => ({ ...prev, [gap.id]: 'sending' }));
    try {
      const updated = await api.keywords.updateGapStatus(clientId, gap.id, status);
      setGaps((prev) => (prev || []).map((g) => (g.id === gap.id ? { ...g, status: updated.status } : g)));
      setGapAction((prev) => ({
        ...prev,
        [gap.id]: {
          draftId: updated.actionCenter?.draftId ?? null,
          draftError: updated.actionCenter?.draftError ?? null,
          rejected: status === 'rejected',
        },
      }));
    } catch (e) {
      setGapAction((prev) => ({ ...prev, [gap.id]: { draftError: e.message || 'Something went wrong.' } }));
    }
  };

  if (error) {
    return (
      <div className="an-panel p-5 border-rose-500/30 bg-rose-500/[0.06] text-rose-600 font-semibold text-xs flex items-center gap-2">
        <AlertTriangle size={15} className="shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  // Loading and genuinely-empty are separate states — showing "no keywords
  // found" while the request is still in flight reads as a real answer.
  const loading = clusters === null || gaps === null;

  return (
    <div className="an-panel p-5 space-y-6">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl grid place-items-center bg-indigo-500/10 border border-indigo-500/25 text-indigo-600 shrink-0">
          <Search size={15} />
        </div>
        <div>
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Keyword Opportunities</h2>
          <p className="text-[11px] font-medium text-slate-500">
            What people search for, and what to publish next
          </p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-11 rounded-xl bg-slate-200/50 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          {/* ── Close to page 1 ───────────────────────────────────────── */}
          <section className="space-y-2.5">
            <div className="flex items-center gap-2">
              <TrendingUp size={12} className="text-emerald-600 shrink-0" />
              <h3 className="an-label">Close to page 1</h3>
            </div>

            {keywords.length === 0 ? (
              <p className="text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
                No keywords ranking between positions {NEAR_PAGE_ONE_MIN_POSITION + 1} and{' '}
                {NEAR_PAGE_ONE_MAX_POSITION} yet. The keyword collector runs every 14 days — this
                fills in once it has clustered enough Search Console data for this client.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse min-w-[440px]">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="an-label py-2 pr-3 font-black">Keyword</th>
                        <th className="an-label py-2 px-3 font-black text-right whitespace-nowrap">Impressions</th>
                        <th className="an-label py-2 pl-3 font-black text-right whitespace-nowrap">Position</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keywords.map((k, i) => (
                        <tr key={`${k.keyword}-${i}`} className="border-b border-slate-100 last:border-0">
                          <td className="py-2.5 pr-3">
                            <div className="text-xs font-bold text-slate-800">{k.keyword}</div>
                            {k.cluster && (
                              <div className="text-[10px] font-medium text-slate-400 mt-0.5">{k.cluster}</div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right text-xs font-black text-slate-800 tabular-nums">
                            {Math.round(k.impressions ?? 0).toLocaleString()}
                          </td>
                          <td className="py-2.5 pl-3 text-right text-xs font-bold text-amber-600 tabular-nums">
                            {(Math.round((k.avg_position ?? 0) * 10) / 10).toFixed(1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] font-medium text-slate-400">
                  Real Search Console impressions this site already earns — not an estimated search
                  volume. These are searches you're being shown for but not clicked on yet.
                </p>
              </>
            )}
          </section>

          {/* ── Content gaps ──────────────────────────────────────────── */}
          <section className="space-y-2.5">
            <div className="flex items-center gap-2">
              <Send size={12} className="text-indigo-600 shrink-0" />
              <h3 className="an-label">Ready to publish</h3>
              {pendingCount > 0 && <span className="an-chip an-chip-violet">{pendingCount} waiting</span>}
            </div>

            {visibleGaps.length === 0 ? (
              <p className="text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
                Nothing waiting for review. Ask the analyst for a keyword you want to grow for and it
                will show up here, ready to send to Action Center.
              </p>
            ) : (
              <div className="space-y-2">
                {visibleGaps.map((gap) => {
                  const state = gapAction[gap.id];
                  const sending = state === 'sending';
                  const done = state && state !== 'sending';
                  return (
                    <div
                      key={gap.id}
                      className="rounded-xl border border-slate-200 bg-slate-100/40 p-3.5 flex flex-col sm:flex-row sm:items-start gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-black text-slate-800">{gap.topic}</span>
                          <span className={`an-chip ${PRIORITY_CHIP[gap.priority] || 'an-chip-slate'}`}>
                            {gap.priority}
                          </span>
                          <span className="an-chip an-chip-slate">
                            {SOURCE_LABEL[gap.source] || gap.source}
                          </span>
                        </div>
                        {gap.reason && (
                          <p className="text-[11px] font-medium text-slate-500 mt-1 line-clamp-2">{gap.reason}</p>
                        )}

                        {done && state.draftId && (
                          <a
                            href="/action-center"
                            className="inline-flex items-center gap-1.5 mt-2 text-[11px] font-bold text-emerald-700 hover:underline"
                          >
                            <CheckCircle2 size={11} />
                            Draft ready in Action Center
                            <ExternalLink size={10} />
                          </a>
                        )}
                        {done && state.rejected && !state.draftError && (
                          <p className="text-[11px] font-bold text-slate-500 mt-2">Dismissed.</p>
                        )}
                        {done && state.draftError && (
                          <p className="text-[11px] font-semibold text-rose-600 mt-2 flex items-start gap-1.5">
                            <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                            <span>
                              Queued in Action Center, but the draft couldn't be generated:{' '}
                              {state.draftError}
                            </span>
                          </p>
                        )}
                        {done && !state.draftId && !state.draftError && !state.rejected && (
                          <p className="text-[11px] font-semibold text-slate-500 mt-2">
                            Queued in Action Center — no draft was generated for this one.
                          </p>
                        )}
                      </div>

                      {!done && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => act(gap, 'approved')}
                            disabled={sending}
                            className="an-grad-btn text-[11px] font-bold px-3 py-2 rounded-xl text-white flex items-center gap-1.5 cursor-pointer"
                          >
                            {sending ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                            {sending ? 'Sending…' : 'Send to Action Center'}
                          </button>
                          <button
                            type="button"
                            onClick={() => act(gap, 'rejected')}
                            disabled={sending}
                            title="Dismiss"
                            aria-label="Dismiss"
                            className="p-2 rounded-xl border border-slate-300 text-slate-400 hover:text-rose-600 hover:border-rose-300 transition disabled:opacity-40 cursor-pointer"
                          >
                            <Ban size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
