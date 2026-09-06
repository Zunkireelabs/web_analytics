import { useEffect, useMemo, useState } from 'react';
import {
  Rocket, ExternalLink, Send, Loader2, CheckCircle2, ChevronDown, ChevronRight, Layers,
} from 'lucide-react';
import { api } from '../api.js';

const TYPE_META = {
  'quick-win': { label: 'Quick Win', chip: 'an-chip-emerald' },
  'page1-opportunity': { label: 'Page 1', chip: 'an-chip-violet' },
  declining: { label: 'Declining', chip: 'an-chip-rose' },
  'content-expansion': { label: 'Content Expansion', chip: 'an-chip-cyan' },
  'content-gap': { label: 'Content Gap', chip: 'an-chip-amber' },
};
// Visible filter order — ai-visibility is intentionally excluded (never
// produced today; see growth-opportunities.js's ai-visibility note) rather
// than shown as an always-empty, unexplained chip.
const FILTER_TYPES = ['quick-win', 'page1-opportunity', 'declining', 'content-expansion', 'content-gap'];

const SEVERITY_DOT = { high: 'bg-rose-500', medium: 'bg-amber-500', low: 'bg-slate-400' };
// Mirrors server/agents/lib/analyst-seo-mapping.js's OPPORTUNITY_GENERATORS
// so the button only shows when the server would accept it. content-gap is
// excluded — it has its own approve-to-Action-Center path below (no existing
// page to draft against).
const DRAFTABLE_TYPES = new Set(['quick-win', 'page1-opportunity', 'declining', 'content-expansion']);

function pctLabel(v) {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function OpportunityRow({ opp, clientId, onGapResolved }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [draftedId, setDraftedId] = useState(null);
  const meta = TYPE_META[opp.type] || { label: opp.type, chip: 'an-chip-slate' };

  const title = opp.type === 'content-expansion'
    ? `${opp.cluster.length} related queries on this page`
    : opp.query;

  const sendGapToActionCenter = async () => {
    setBusy(true); setError(null);
    try {
      await api.keywords.updateGapStatus(clientId, opp.gapId, 'approved');
      setSent(true);
      onGapResolved?.();
    } catch (e) {
      setError(e.message || 'Could not send this to Action Center.');
    } finally { setBusy(false); }
  };

  const canDraft = DRAFTABLE_TYPES.has(opp.type) && Boolean(opp.page);
  const sendOpportunityToActionCenter = async () => {
    setBusy(true); setError(null);
    try {
      const draft = await api.keywords.generateOpportunityDraft(clientId, opp);
      setDraftedId(draft.id);
    } catch (e) {
      setError(e.message || 'Could not send this to Action Center.');
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left p-3.5 flex items-start gap-3 cursor-pointer"
      >
        {open ? <ChevronDown size={14} className="text-slate-400 shrink-0 mt-0.5" /> : <ChevronRight size={14} className="text-slate-400 shrink-0 mt-0.5" />}
        <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${SEVERITY_DOT[opp.severity] || 'bg-slate-300'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12.5px] font-black text-slate-900 truncate">{title}</span>
            <span className={`an-chip ${meta.chip}`}>{meta.label}</span>
          </div>
          <div className="text-[10.5px] font-semibold text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
            {opp.impressions > 0 && <span>{opp.impressions} impressions</span>}
            {opp.clicks > 0 && <span>{opp.clicks} clicks</span>}
            {opp.avgPosition != null && <span>position #{opp.avgPosition.toFixed(1)}</span>}
            {opp.ctr != null && opp.impressions > 0 && <span>{pctLabel(opp.ctr)} CTR</span>}
          </div>
        </div>
      </button>

      {open && (
        <div className="px-3.5 pb-3.5 pl-9 space-y-2">
          {opp.type === 'content-expansion' && (
            <div className="flex flex-wrap gap-1">
              {opp.cluster.map((q) => (
                <span key={q} className="an-chip an-chip-slate">{q}</span>
              ))}
            </div>
          )}
          <p className="text-[11px] font-medium text-slate-600">
            <span className="an-label mr-1.5">Why</span>{opp.reason}
          </p>
          <p className="text-[11px] font-semibold text-slate-800">
            <span className="an-label mr-1.5">Target</span>
            {opp.page ? 'Existing relevant page' : 'No strong existing page found'}
          </p>
          <p className="text-[11px] font-semibold text-slate-800">
            <span className="an-label mr-1.5">Action</span>{opp.recommendedAction}
          </p>

          {error && <p className="text-[11px] font-semibold text-rose-600">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            {opp.page && (
              <a
                href={opp.page} target="_blank" rel="noreferrer"
                className="text-[11px] font-bold px-3 py-1.5 rounded-xl border border-slate-300 text-slate-600 hover:bg-slate-50 transition flex items-center gap-1.5"
              >
                <ExternalLink size={11} /> View Page
              </a>
            )}
            {canDraft && (
              draftedId ? (
                <a href={`/action-center?siteId=${clientId}`} className="text-[11px] font-bold text-emerald-700 hover:underline flex items-center gap-1.5">
                  <CheckCircle2 size={11} /> In Action Center
                </a>
              ) : (
                <button
                  type="button" onClick={sendOpportunityToActionCenter} disabled={busy}
                  className="an-grad-btn text-[11px] font-bold px-3 py-1.5 rounded-xl text-white flex items-center gap-1.5 cursor-pointer"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                  Send to Action Center
                </button>
              )
            )}
            {opp.type === 'content-gap' && (
              sent ? (
                <a href={`/action-center?siteId=${clientId}`} className="text-[11px] font-bold text-emerald-700 hover:underline flex items-center gap-1.5">
                  <CheckCircle2 size={11} /> In Action Center
                </a>
              ) : (
                <button
                  type="button" onClick={sendGapToActionCenter} disabled={busy}
                  className="an-grad-btn text-[11px] font-bold px-3 py-1.5 rounded-xl text-white flex items-center gap-1.5 cursor-pointer"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                  Send to Action Center
                </button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Website-wide Growth Opportunities — the answer to "where can this site
// grow next?", not scoped to one keyword the staff member happened to pick.
// Consumes GET /internal/keywords/:siteId/growth-opportunities
// (server/agents/lib/growth-opportunities.js), which is built entirely from
// real gsc_query_page + keyword_gaps data — no estimated search volume, no
// fabricated AI-visibility opportunities (see that file's ai-visibility
// note).
export default function AnalystGrowthOpportunities({ clientId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [activeType, setActiveType] = useState(null);

  const load = () => {
    api.keywords.growthOpportunities(clientId)
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load growth opportunities.'));
  };
  useEffect(() => { setData(null); setError(null); load(); }, [clientId]);

  const visible = useMemo(() => {
    if (!data) return [];
    return activeType ? data.opportunities.filter((o) => o.type === activeType) : data.opportunities;
  }, [data, activeType]);

  if (error) {
    return (
      <div className="an-panel p-5 border-rose-500/30 bg-rose-500/[0.06] text-rose-600 text-xs font-semibold">
        {error}
      </div>
    );
  }

  return (
    <div className="an-panel p-5 space-y-4">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl grid place-items-center bg-emerald-500/10 border border-emerald-500/25 text-emerald-600 shrink-0">
          <Rocket size={15} />
        </div>
        <div className="min-w-0">
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Growth Opportunities</h2>
          <p className="text-[11px] font-medium text-slate-500">
            Where this site can grow next, ranked from real search data
          </p>
        </div>
        {data && <span className="an-chip an-chip-emerald ml-auto">{data.total} found</span>}
      </div>

      {!data ? (
        <p className="text-xs font-medium text-slate-400 animate-pulse">Loading…</p>
      ) : data.total === 0 ? (
        <div className="flex items-start gap-2.5 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
          <Layers size={15} className="text-slate-400 shrink-0 mt-0.5" />
          <p className="text-xs font-semibold text-slate-600">
            Nothing meets the bar yet — opportunities appear here once real Search Console traffic and
            a wider keyword review queue build up.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button" onClick={() => setActiveType(null)}
              className={`text-[11px] font-bold px-3 py-1.5 rounded-xl border transition cursor-pointer ${
                !activeType ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-300 text-slate-500 hover:bg-slate-50'
              }`}
            >
              All ({data.total})
            </button>
            {FILTER_TYPES.filter((t) => data.counts[t] > 0).map((t) => (
              <button
                key={t} type="button" onClick={() => setActiveType(t)}
                className={`text-[11px] font-bold px-3 py-1.5 rounded-xl border transition cursor-pointer ${
                  activeType === t ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-300 text-slate-500 hover:bg-slate-50'
                }`}
              >
                {TYPE_META[t].label} ({data.counts[t]})
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {visible.map((opp, i) => (
              <OpportunityRow
                key={`${opp.type}:${opp.query || opp.page}:${i}`}
                opp={opp} clientId={clientId} onGapResolved={load}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
