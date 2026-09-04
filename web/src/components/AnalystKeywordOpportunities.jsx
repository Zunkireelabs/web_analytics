import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Search, TrendingUp, Send, AlertTriangle, CheckCircle2, ExternalLink, Loader2, Ban } from 'lucide-react';

const MAX_KEYWORD_ROWS = 15;

const PRIORITY_CHIP = { high: 'an-chip-rose', medium: 'an-chip-amber', low: 'an-chip-slate' };
const SOURCE_LABEL = {
  user_request: 'You asked for this',
  claude_research: 'Keyword research',
  internal_analysis: 'Gap analysis',
};

// product_relevance/search_intent are classified within a week of a gap
// first appearing (analyst-seo-mapping.js's refreshPendingKeywordGapObservations,
// run weekly) — a genuinely brand-new gap still simply has no chip yet, not
// "unrelated".
const RELEVANCE_CHIP = { direct: 'an-chip-emerald', supporting: 'an-chip-amber', unrelated: 'an-chip-slate' };
const RELEVANCE_LABEL = { direct: 'Product match', supporting: 'Supports product', unrelated: 'Not product-related' };

// Informational only — mirrors gapDraftEligibility's own commercial-intent +
// direct-relevance rule (server/agents/lib/analyst-seo-mapping.js) just
// closely enough to tell a reviewer what clicking "Send to Action Center"
// is actually approving. The backend is the sole authority on what actually
// ships: this never gates the button, and analyst-seo-mapping.js's
// qualifyAndShipContentGaps refuses to auto-approve a "Landing page" gap
// through the unattended biweekly cycle regardless of this label — a human
// clicking here is the ask that generator was held back for.
function predictedShape(gap) {
  if (!gap.product_relevance) return null;
  const commercial = gap.search_intent === 'commercial' || gap.search_intent === 'transactional';
  if (commercial && gap.product_relevance === 'direct') return 'Would create: Landing page';
  return 'Would create: Blog post';
}

export default function AnalystKeywordOpportunities({ clientId, refreshToken }) {
  const [opportunities, setOpportunities] = useState(null);
  const [gaps, setGaps] = useState(null);
  const [error, setError] = useState(null);
  // Per-gap action state, keyed by gap id: 'sending' | { draftId, draftError }.
  const [gapAction, setGapAction] = useState({});

  // Guards against a slower earlier request overwriting a newer client's data
  // when the selector is changed quickly — only the latest request may commit.
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setOpportunities(null);
    setGaps(null);
    setError(null);
    setGapAction({});

    // Close to Page 1 used to read keyword_clusters.keywords_json — a
    // 14-day-cadence, append-only snapshot with no clicks/CTR/page column at
    // all, and a SEPARATE position window (10-30) from the Growth
    // Opportunities section above (10-20), so the two sections could — and
    // for Zunkiree Labs, did — disagree about what counted as "close to page
    // 1." Both now read the exact same growth-opportunities endpoint
    // (server/agents/lib/growth-opportunities.js), filtered to
    // page1-opportunity, so there is exactly one definition on this page.
    Promise.all([api.keywords.growthOpportunities(clientId), api.keywords.gaps(clientId)])
      .then(([oppRows, gapRows]) => {
        if (requestRef.current !== requestId) return;
        setOpportunities(oppRows?.opportunities || []);
        setGaps(gapRows || []);
      })
      .catch((e) => {
        if (requestRef.current !== requestId) return;
        setError(e.message || 'Failed to load keyword data.');
      });
  }, [clientId, refreshToken]);

  const keywords = useMemo(
    () => (opportunities || [])
      .filter((o) => o.type === 'page1-opportunity')
      .sort((a, b) => (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0))
      .slice(0, MAX_KEYWORD_ROWS),
    [opportunities]
  );

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
    const deduped = (gaps || [])
      .filter((g) => g.status === 'pending_review' || gapAction[g.id])
      .filter((g) => {
        const key = (g.topic || '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    // product_relevance is only known once a gap has been approved
    // (classifyGapRelevance runs at approval time, not on every pending
    // gap — classifying all of them eagerly would mean an LLM call per gap
    // shown, most of which are never approved). So a 'direct' match always
    // sorts first when known, but priority is what orders the majority of
    // this list, which is still unclassified.
    const relevanceRank = { direct: 0, supporting: 1, unrelated: 2 };
    const priorityRank = { high: 0, medium: 1, low: 2 };
    return [...deduped].sort((a, b) => {
      const relDiff = (relevanceRank[a.product_relevance] ?? 3) - (relevanceRank[b.product_relevance] ?? 3);
      if (relDiff !== 0) return relDiff;
      return (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3);
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
          // requiresFutureInfrastructure — a real opportunity the system
          // identified (e.g. comparison-page) but has no generator for yet;
          // distinct from blockedReason's other cause (missing per-site repo
          // config), which is fixable by an admin today, so both need to
          // read differently in the UI.
          blockedReason: updated.actionCenter?.blockedReason ?? null,
          requiresFutureInfrastructure: updated.actionCenter?.requiresFutureInfrastructure ?? false,
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
  const loading = opportunities === null || gaps === null;

  if (loading) {
    return (
      <div className="an-panel p-5 space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-11 rounded-xl bg-slate-200/50 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Close to page 1 — real performance data, already ranking ─── */}
      <div className="an-panel p-5 space-y-2.5 border-t-2 border-t-emerald-500/60">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl grid place-items-center bg-emerald-500/10 border border-emerald-500/25 text-emerald-600 shrink-0">
            <TrendingUp size={15} />
          </div>
          <div>
            <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Close to page 1</h2>
            <p className="text-[11px] font-medium text-slate-500">
              Real Search Console impressions this site already earns — the fastest wins
            </p>
          </div>
        </div>

        <div className="pt-1">
            {keywords.length === 0 ? (
              <p className="text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
                No keywords just outside page 1 right now. This fills in once real Search Console
                traffic lands a query at position 10-20 for this client.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse min-w-[560px]">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="an-label py-2 pr-3 font-black">Keyword</th>
                        <th className="an-label py-2 px-3 font-black whitespace-nowrap">Opportunity</th>
                        <th className="an-label py-2 px-3 font-black text-right whitespace-nowrap">Impressions</th>
                        <th className="an-label py-2 px-3 font-black text-right whitespace-nowrap">CTR</th>
                        <th className="an-label py-2 px-3 font-black text-right whitespace-nowrap">Position</th>
                        <th className="an-label py-2 px-3 font-black">Target</th>
                        <th className="an-label py-2 pl-3 font-black">Recommended</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keywords.map((k, i) => (
                        <tr key={`${k.query}-${i}`} className="border-b border-slate-100 last:border-0">
                          <td className="py-2.5 pr-3">
                            <div className="text-xs font-bold text-slate-800">{k.query}</div>
                          </td>
                          <td className="py-2.5 px-3">
                            <span className={`an-chip ${PRIORITY_CHIP[k.severity] || 'an-chip-slate'}`}>
                              {k.severity || 'low'}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-right text-xs font-black text-slate-800 tabular-nums">
                            {Math.round(k.impressions ?? 0).toLocaleString()}
                          </td>
                          <td className="py-2.5 px-3 text-right text-xs font-bold text-slate-600 tabular-nums">
                            {k.ctr != null ? `${(k.ctr * 100).toFixed(1)}%` : '—'}
                          </td>
                          <td className="py-2.5 px-3 text-right text-xs font-bold text-amber-600 tabular-nums">
                            {k.avgPosition != null ? k.avgPosition.toFixed(1) : '—'}
                          </td>
                          <td className="py-2.5 px-3">
                            {k.page ? (
                              <a href={k.page} target="_blank" rel="noreferrer" className="text-[11px] font-bold text-indigo-600 hover:underline inline-flex items-center gap-1">
                                Existing page <ExternalLink size={10} />
                              </a>
                            ) : (
                              <span className="text-[11px] font-semibold text-slate-400">No strong existing page</span>
                            )}
                          </td>
                          <td className="py-2.5 pl-3 text-[11px] font-medium text-slate-500 max-w-[16rem]">
                            {k.recommendedAction}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] font-medium text-slate-400">
                  Not an estimated search volume — these are searches you're already being shown
                  for but not clicked on yet. Same source as Growth Opportunities above, filtered
                  to page-1-adjacent queries.
                </p>
              </>
            )}
        </div>
      </div>

      {/* ── Content gaps — net-new topics to discover and publish ─────── */}
      <div className="an-panel p-5 space-y-2.5 border-t-2 border-t-indigo-500/60 bg-gradient-to-b from-indigo-500/[0.03] to-transparent">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl grid place-items-center bg-indigo-500/10 border border-indigo-500/25 text-indigo-600 shrink-0">
            <Send size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Keyword Discovery</h2>
              {pendingCount > 0 && <span className="an-chip an-chip-violet">{pendingCount} waiting</span>}
            </div>
            <p className="text-[11px] font-medium text-slate-500">
              Topics you don't rank for yet — queued to draft and publish
            </p>
          </div>
        </div>

        <div className="pt-1">
            {visibleGaps.length === 0 ? (
              <p className="text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
                Nothing waiting for review. Ask the analyst for a keyword you want to grow for and it
                will show up here, ready to send to Action Center.
              </p>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5 max-h-[34rem] overflow-y-auto custom-scrollbar pr-1 -mr-1">
                {visibleGaps.map((gap) => {
                  const state = gapAction[gap.id];
                  const sending = state === 'sending';
                  const done = state && state !== 'sending';
                  return (
                    <div
                      key={gap.id}
                      className="rounded-xl border border-indigo-200/60 bg-indigo-500/[0.04] p-3.5 flex flex-col gap-3"
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
                          {gap.product_relevance && (
                            <span className={`an-chip ${RELEVANCE_CHIP[gap.product_relevance] || 'an-chip-slate'}`}>
                              {RELEVANCE_LABEL[gap.product_relevance] || gap.product_relevance}
                            </span>
                          )}
                          {predictedShape(gap) && (
                            <span className="an-chip an-chip-slate">{predictedShape(gap)}</span>
                          )}
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
                        {done && state.requiresFutureInfrastructure && (
                          <p className="text-[11px] font-semibold text-amber-700 mt-2 flex items-start gap-1.5">
                            <Ban size={11} className="shrink-0 mt-0.5" />
                            <span>
                              Real comparison-page opportunity — recorded in Action Center, but no generator can
                              build a standalone comparison page yet. Needs new infrastructure before it can draft.
                            </span>
                          </p>
                        )}
                        {done && !state.draftId && !state.draftError && !state.rejected && !state.requiresFutureInfrastructure && (
                          <p className="text-[11px] font-semibold text-slate-500 mt-2">
                            Queued in Action Center — no draft was generated for this one.
                          </p>
                        )}
                      </div>

                      {!done && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => act(gap, 'approved')}
                            disabled={sending}
                            className="an-grad-btn flex-1 text-[11px] font-bold px-3 py-2 rounded-xl text-white flex items-center justify-center gap-1.5 cursor-pointer"
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
                            className="p-2 rounded-xl border border-slate-300 text-slate-400 hover:text-rose-600 hover:border-rose-300 transition disabled:opacity-40 cursor-pointer shrink-0"
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
        </div>
      </div>
    </div>
  );
}
