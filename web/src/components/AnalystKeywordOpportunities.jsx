import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Send, AlertTriangle, CheckCircle2, ExternalLink, Loader2, Ban } from 'lucide-react';
import { STATUS } from '../lib/palette.js';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import { Tray, TrayCard } from './layout/Tray.jsx';

const MAX_KEYWORD_ROWS = 15;

const PRIORITY_TONE = { high: 'red', medium: 'amber', low: 'grey' };
const SOURCE_LABEL = {
  user_request: 'You asked for this',
  claude_research: 'Keyword research',
  internal_analysis: 'Gap analysis',
  dataforseo_demand: 'Market demand',
};

// product_relevance/search_intent are classified within a week of a gap
// first appearing (analyst-seo-mapping.js's refreshPendingKeywordGapObservations,
// run weekly) — a genuinely brand-new gap still simply has no chip yet, not
// "unrelated".
const RELEVANCE_LABEL = { direct: 'Product match', supporting: 'Supports product', unrelated: 'Not product-related' };

// Coverage verdicts (server/agents/lib/keyword-coverage.js). SAME TOPIC DOES NOT
// MEAN SAME SEO TARGET, so a keyword another page covers only in a different
// language, country or intent is shown as an expansion, never hidden as covered.
const COVERAGE_LABEL = {
  opportunity: 'New opportunity', market_gap: 'Market gap', language_gap: 'Language gap', intent_gap: 'Intent gap',
  covered: 'Already covered', duplicate: 'Already targeted', uncertain: 'Uncertain',
};
// Order is the order sections appear. A gap with no verdict yet is a new opportunity.
const COVERAGE_GROUPS = [
  { id: 'opportunity', title: 'New opportunities', hint: 'No existing page covers these', match: (g) => !g.coverage_status || g.coverage_status === 'opportunity' },
  { id: 'market_gap', title: 'International expansion', hint: 'Covered for another country, not this one', match: (g) => g.coverage_status === 'market_gap' },
  { id: 'language_gap', title: 'Language expansion', hint: 'Covered in another language', match: (g) => g.coverage_status === 'language_gap' },
  { id: 'intent_gap', title: 'Intent expansion', hint: 'Covered, but for a different search intent', match: (g) => g.coverage_status === 'intent_gap' },
  { id: 'covered', title: 'Already covered', hint: 'An existing page already satisfies these', match: (g) => g.coverage_status === 'covered' || g.coverage_status === 'duplicate' },
  { id: 'uncertain', title: 'Uncertain', hint: 'Not enough evidence to decide', match: (g) => g.coverage_status === 'uncertain' },
];

// What will really happen if this gap is sent to Action Center — computed by the
// backend from the same rules that decide whether a draft is created, so this
// can never promise "Blog post" for a gap the server will not draft.
function recommendedAction(gap) {
  const a = gap.recommended_action;
  return a?.label ? { label: a.label, reason: a.reason || null, kind: a.kind } : null;
}

// Read-only mirror of hasStableOrGrowingDemand's own two-most-recent-
// snapshots comparison (server/agents/lib/analyst-seo-mapping.js) — never
// reimplements the qualification threshold itself, just labels what that
// same comparison would say so a reviewer can see the trend the autonomous
// ship cycle is actually gating on, before it's ever eligible to ship.
const TREND_LABEL = { new: 'New — no trend yet', rising: 'Rising demand', stable: 'Stable demand', falling: 'Falling demand' };
function evidenceTrend(gap) {
  const snapshots = Array.isArray(gap.evidence_snapshots) ? gap.evidence_snapshots : [];
  if (snapshots.length < 2) return 'new';
  const [prior, latest] = snapshots.slice(-2);
  const priorImpressions = Number(prior?.impressions) || 0;
  const latestImpressions = Number(latest?.impressions) || 0;
  if (latestImpressions > priorImpressions) return 'rising';
  if (latestImpressions === priorImpressions) return 'stable';
  return 'falling';
}

function formatSeenDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// "English: …" under (or beside) a keyword that isn't English. Renders nothing
// for English terms and while translations are still loading.
function Gloss({ translation, inline = false }) {
  if (!translation) return null;
  return (
    <span className={`${inline ? '' : 'block mt-0.5 '}text-xs text-faint`}>
      <Badge tone="grey" className="mr-1.5">{translation.language}</Badge>
      {translation.english}
    </span>
  );
}

export default function AnalystKeywordOpportunities({ clientId, refreshToken }) {
  const [opportunities, setOpportunities] = useState(null);
  const [gaps, setGaps] = useState(null);
  const [error, setError] = useState(null);
  // Per-gap action state, keyed by gap id: 'sending' | { draftId, draftError }.
  const [gapAction, setGapAction] = useState({});
  // English glosses for non-English keywords, keyed by the exact term. Loaded
  // after the table renders and never blocks it; a failure just shows no gloss.
  const [translations, setTranslations] = useState({});

  // Guards against a slower earlier request overwriting a newer client's data
  // when the selector is changed quickly — only the latest request may commit.
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setOpportunities(null);
    setGaps(null);
    setError(null);
    setGapAction({});
    setTranslations({});

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

        const terms = [
          ...(oppRows?.opportunities || []).filter((o) => o.type === 'page1-opportunity').map((o) => o.query),
          ...(gapRows || []).filter((g) => g.status === 'pending_review').map((g) => g.topic),
        ].filter(Boolean);
        if (terms.length === 0) return;
        api.keywords.translate(clientId, terms)
          .then((res) => { if (requestRef.current === requestId) setTranslations(res?.translations || {}); })
          .catch(() => {}); // decorative — the keywords are already on screen
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
      <div className="rounded-card px-4 py-3 text-[13px] flex items-center gap-2" style={{ background: STATUS.critical.tint, color: STATUS.critical.text }}>
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
      <Tray>
        <TrayCard>
          <div className="p-4 space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-11 rounded-control bg-muted animate-pulse" />
            ))}
          </div>
        </TrayCard>
      </Tray>
    );
  }

  return (
    <Tray>
      {/* ── Close to page 1 — real performance data, already ranking ─── */}
      <TrayCard
        title="Close to page 1"
        subtitle="Real Search Console impressions this site already earns — the fastest wins"
      >
        {keywords.length === 0 ? (
          <p className="mx-4 mb-4 text-[13px] text-text bg-muted rounded-card px-4 py-3">
            No keywords just outside page 1 right now. This fills in once real Search Console
            traffic lands a query at position 10-20 for this client.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto border-t border-border">
              <table className="tbl min-w-[640px]">
                <thead>
                  <tr>
                    <th>Keyword</th>
                    <th>Opportunity</th>
                    <th className="num">Impressions</th>
                    <th className="num">CTR</th>
                    <th className="num">Position</th>
                    <th>Target</th>
                    <th>Recommended</th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.map((k, i) => (
                    <tr key={`${k.query}-${i}`}>
                      <td>
                        <div className="font-medium">{k.query}</div>
                        <Gloss translation={translations[k.query]} />
                      </td>
                      <td>
                        <Badge tone={PRIORITY_TONE[k.severity] || 'grey'}>{k.severity || 'low'}</Badge>
                      </td>
                      <td className="num">{Math.round(k.impressions ?? 0).toLocaleString()}</td>
                      <td className="num text-text">{k.ctr != null ? `${(k.ctr * 100).toFixed(1)}%` : '—'}</td>
                      <td className="num" style={{ color: STATUS.warning.text }}>{k.avgPosition != null ? k.avgPosition.toFixed(1) : '—'}</td>
                      <td>
                        {k.page ? (
                          <a href={k.page} target="_blank" rel="noreferrer" className="text-[13px] text-primary hover:underline inline-flex items-center gap-1">
                            Existing page <ExternalLink size={11} />
                          </a>
                        ) : (
                          <span className="text-xs text-faint">No strong existing page</span>
                        )}
                      </td>
                      <td className="text-xs text-text max-w-[16rem]">{k.recommendedAction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-xs text-faint border-t border-border">
              Not an estimated search volume — these are searches you're already being shown
              for but not clicked on yet. Same source as Growth Opportunities above, filtered
              to page-1-adjacent queries.
            </p>
          </>
        )}
      </TrayCard>

      {/* ── Content gaps — net-new topics to discover and publish ─────── */}
      <TrayCard
        title="Keyword discovery"
        subtitle="Topics you don't rank for yet — queued to draft and publish"
        action={pendingCount > 0 ? <Badge tone="primary">{pendingCount} waiting</Badge> : null}
      >
        <div className="px-4 pb-4">
          {visibleGaps.length === 0 ? (
            <p className="text-[13px] text-text bg-muted rounded-card px-4 py-3">
              Nothing waiting for review. Ask the analyst for a keyword you want to grow for and it
              will show up here, ready to send to Action Center.
            </p>
          ) : (
            <div className="max-h-[34rem] overflow-y-auto custom-scrollbar pr-1 -mr-1 space-y-4">
              {COVERAGE_GROUPS.map((group) => {
                const items = visibleGaps.filter(group.match);
                if (!items.length) return null;
                return (
                  <div key={group.id} className="space-y-2">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <h3 className="text-[13px] font-medium text-fg">{group.title}</h3>
                      <span className="text-xs text-faint">{items.length} · {group.hint}</span>
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      {items.map((gap) => {
                        const state = gapAction[gap.id];
                        const sending = state === 'sending';
                        const done = state && state !== 'sending';
                        return (
                          <div
                            key={gap.id}
                            className="rounded-card bg-white p-3.5 flex flex-col gap-3"
                            style={{ boxShadow: 'var(--ring)' }}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[13px] font-medium text-fg">{gap.topic}</span>
                                <Gloss translation={translations[gap.topic]} inline />
                                <Badge tone={PRIORITY_TONE[gap.priority] || 'grey'}>{gap.priority}</Badge>
                                {recommendedAction(gap) && (
                                  <Badge tone="outline" title={recommendedAction(gap).reason || undefined}>
                                    {recommendedAction(gap).label}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-faint mt-1.5" title="Based on the two most recent weekly demand snapshots">
                                {[
                                  SOURCE_LABEL[gap.source] || gap.source,
                                  gap.product_relevance && (RELEVANCE_LABEL[gap.product_relevance] || gap.product_relevance),
                                  gap.coverage_status && (COVERAGE_LABEL[gap.coverage_status] || gap.coverage_status),
                                  TREND_LABEL[evidenceTrend(gap)],
                                ].filter(Boolean).join(' · ')}
                              </p>
                              {gap.reason && (
                                <p className="text-xs text-text mt-1.5 line-clamp-2">{gap.reason}</p>
                              )}
                              {gap.coverage_status && gap.coverage_status !== 'opportunity' && gap.coverage_reason && (
                                <p className="text-xs text-faint mt-1 line-clamp-2">{gap.coverage_reason}</p>
                              )}
                              <p className="text-xs text-faint-2 mt-1">
                                Seen {gap.observation_count || 1}x
                                {formatSeenDate(gap.first_seen_at) && ` · first ${formatSeenDate(gap.first_seen_at)}`}
                                {formatSeenDate(gap.last_seen_at) && ` · last ${formatSeenDate(gap.last_seen_at)}`}
                              </p>

                              {done && state.draftId && (
                                <a
                                  href="/action-center"
                                  className="inline-flex items-center gap-1.5 mt-2 text-[13px] font-medium hover:underline"
                                  style={{ color: STATUS.good.text }}
                                >
                                  <CheckCircle2 size={13} />
                                  Draft ready in Action Center
                                  <ExternalLink size={11} />
                                </a>
                              )}
                              {done && state.rejected && !state.draftError && (
                                <p className="text-xs text-faint mt-2">Dismissed.</p>
                              )}
                              {done && state.draftError && (
                                <p className="text-xs mt-2 flex items-start gap-1.5" style={{ color: STATUS.critical.text }}>
                                  <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                                  <span>
                                    Queued in Action Center, but the draft couldn't be generated:{' '}
                                    {state.draftError}
                                  </span>
                                </p>
                              )}
                              {done && state.requiresFutureInfrastructure && (
                                <p className="text-xs mt-2 flex items-start gap-1.5" style={{ color: STATUS.warning.text }}>
                                  <Ban size={12} className="shrink-0 mt-0.5" />
                                  <span>
                                    Real comparison-page opportunity — recorded in Action Center, but no generator can
                                    build a standalone comparison page yet. Needs new infrastructure before it can draft.
                                  </span>
                                </p>
                              )}
                              {done && !state.draftId && !state.draftError && !state.rejected && !state.requiresFutureInfrastructure && (
                                <p className="text-xs text-faint mt-2">
                                  Queued in Action Center — no draft was generated for this one.
                                </p>
                              )}
                            </div>

                            {!done && (
                              <div className="flex items-center gap-2">
                                <Button variant="primary" onClick={() => act(gap, 'approved')} disabled={sending}>
                                  {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                                  {sending ? 'Sending…' : 'Send to Action Center'}
                                </Button>
                                <Button variant="light" icon className="shrink-0" onClick={() => act(gap, 'rejected')}
                                  disabled={sending} title="Dismiss" aria-label="Dismiss">
                                  <Ban size={14} />
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </TrayCard>
    </Tray>
  );
}
