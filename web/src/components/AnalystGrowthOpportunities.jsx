import { useEffect, useMemo, useState } from 'react';
import {
  ExternalLink, Send, Loader2, CheckCircle2, ChevronDown, ChevronRight, Layers,
} from 'lucide-react';
import { api } from '../api.js';
import { STATUS } from '../lib/palette.js';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import { Tray, TrayCard } from './layout/Tray.jsx';

const TYPE_META = {
  'quick-win': { label: 'Quick Win', tone: 'green' },
  'page1-opportunity': { label: 'Page 1', tone: 'primary' },
  declining: { label: 'Declining', tone: 'red' },
  'content-expansion': { label: 'Content Expansion', tone: 'outline' },
  'content-gap': { label: 'Content Gap', tone: 'amber' },
};
// Visible filter order — ai-visibility is intentionally excluded (never
// produced today; see growth-opportunities.js's ai-visibility note) rather
// than shown as an always-empty, unexplained chip.
const FILTER_TYPES = ['quick-win', 'page1-opportunity', 'declining', 'content-expansion', 'content-gap'];

const SEVERITY_DOT = { high: STATUS.critical.color, medium: STATUS.warning.color, low: STATUS.neutral.color };
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
  const meta = TYPE_META[opp.type] || { label: opp.type, tone: 'grey' };

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

  const inActionCenter = (
    <a href={`/action-center?siteId=${clientId}`} className="text-[13px] font-medium flex items-center gap-1.5 hover:underline" style={{ color: STATUS.good.text }}>
      <CheckCircle2 size={13} /> In Action Center
    </a>
  );
  const sendButton = (onClick) => (
    <Button variant="primary" size="sm" onClick={onClick} disabled={busy}>
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
      Send to Action Center
    </Button>
  );

  return (
    <div className="rounded-card bg-white" style={{ boxShadow: 'var(--ring)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left p-3.5 flex items-start gap-3 cursor-pointer"
      >
        {open ? <ChevronDown size={14} className="text-faint shrink-0 mt-1" /> : <ChevronRight size={14} className="text-faint shrink-0 mt-1" />}
        <span className="w-2 h-2 rounded-full shrink-0 mt-2" style={{ background: SEVERITY_DOT[opp.severity] || STATUS.neutral.color }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium text-fg truncate">{title}</span>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </div>
          <div className="text-xs text-faint mt-1 flex items-center gap-x-3 gap-y-0.5 flex-wrap">
            {opp.impressions > 0 && <span>{opp.impressions} impressions</span>}
            {opp.clicks > 0 && <span>{opp.clicks} clicks</span>}
            {opp.avgPosition != null && <span>position #{opp.avgPosition.toFixed(1)}</span>}
            {opp.ctr != null && opp.impressions > 0 && <span>{pctLabel(opp.ctr)} CTR</span>}
          </div>
        </div>
      </button>

      {open && (
        <div className="px-3.5 pb-3.5 pl-10 space-y-2 text-[13px] leading-5">
          {opp.type === 'content-expansion' && (
            <div className="flex flex-wrap gap-1">
              {opp.cluster.map((q) => (
                <Badge key={q} tone="grey">{q}</Badge>
              ))}
            </div>
          )}
          <p className="text-text">
            <span className="font-medium text-fg mr-1.5">Why</span>{opp.reason}
          </p>
          <p className="text-text">
            <span className="font-medium text-fg mr-1.5">Target</span>
            {opp.page ? 'Existing relevant page' : 'No strong existing page found'}
          </p>
          <p className="text-text">
            <span className="font-medium text-fg mr-1.5">Action</span>{opp.recommendedAction}
          </p>

          {error && <p className="text-xs text-[#b42318]">{error}</p>}

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            {opp.page && (
              <a href={opp.page} target="_blank" rel="noreferrer" className="btn btn--light btn--sm">
                <ExternalLink size={12} /> View Page
              </a>
            )}
            {canDraft && (draftedId ? inActionCenter : sendButton(sendOpportunityToActionCenter))}
            {opp.type === 'content-gap' && (sent ? inActionCenter : sendButton(sendGapToActionCenter))}
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
      <div className="rounded-card px-4 py-3 text-[13px]" style={{ background: STATUS.critical.tint, color: STATUS.critical.text }}>
        {error}
      </div>
    );
  }

  return (
    <Tray>
      <TrayCard
        title="Growth opportunities"
        subtitle="Where this site can grow next, ranked from real search data"
        action={data ? <Badge tone="green">{data.total} found</Badge> : null}
      >
        <div className="px-4 pb-4 space-y-3">
          {!data ? (
            <p className="text-[13px] text-faint animate-pulse">Loading…</p>
          ) : data.total === 0 ? (
            <div className="flex items-start gap-2.5 bg-muted rounded-card px-4 py-3">
              <Layers size={16} className="text-faint shrink-0 mt-0.5" />
              <p className="text-[13px] text-text">
                Nothing meets the bar yet — opportunities appear here once real Search Console traffic and
                a wider keyword review queue build up.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant={!activeType ? 'dark' : 'light'} size="sm" onClick={() => setActiveType(null)}>
                  All ({data.total})
                </Button>
                {FILTER_TYPES.filter((t) => data.counts[t] > 0).map((t) => (
                  <Button key={t} variant={activeType === t ? 'dark' : 'light'} size="sm" onClick={() => setActiveType(t)}>
                    {TYPE_META[t].label} ({data.counts[t]})
                  </Button>
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
      </TrayCard>
    </Tray>
  );
}
