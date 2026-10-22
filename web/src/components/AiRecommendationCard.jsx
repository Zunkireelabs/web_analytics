import { useState } from 'react';
import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';
import Sparkline from './Sparkline.jsx';
import { providerCoverageCaveat } from '../lib/provider-coverage.js';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import { STATUS } from '../lib/palette.js';

function emptyMessage(meta) {
  const anyConfigured = meta?.providers?.some((p) => p.configured);
  if (!anyConfigured) return "We haven't set this up yet — check back soon.";
  if (!meta?.hasRun) return 'Not checked yet — this updates monthly.';
  if (meta.status === 'error') return "We couldn't check this — see Data Connection below.";
  if (meta.status === 'insufficient-data') return `Checked ${timeAgo(meta.lastRunAt)}, but there wasn't enough data yet.`;
  return `Checked ${timeAgo(meta.lastRunAt)}, but no data was available.`;
}

// Strip cell borders: top hairline when stacked, left hairline from sm up.
const CELL = 'px-5 py-4 min-w-0 border-border border-t first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0';
const ROW = 'flex justify-between gap-3 py-2 border-b border-border last:border-0 text-[13px]';

const pctColor = (pct) => (pct >= 60 ? STATUS.good.color : pct >= 25 ? STATUS.warning.color : STATUS.critical.color);

export default function AiRecommendationCard({ aiRecommendation, meta, loading }) {
  const [showPrompts, setShowPrompts] = useState(false);
  const animatedPct = useCountUp(aiRecommendation?.visibilityPct ?? 0, 900);

  if (loading) {
    return (
      <div className="card p-5 space-y-3">
        <div className="h-3 w-28 bg-muted rounded-control animate-pulse" />
        <div className="h-6 w-20 bg-muted rounded-control animate-pulse" />
      </div>
    );
  }

  if (!aiRecommendation) {
    return (
      <div className="card p-5">
        <div className="flex items-center justify-between gap-2 text-[13px] text-text">
          <span>AI search visibility</span>
          <Badge tone="outline">Not yet available</Badge>
        </div>
        <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg tnum">—</div>
        <p className="mt-2 text-[13px] text-text">{emptyMessage(meta)}</p>
      </div>
    );
  }

  const history = (aiRecommendation.history || []).map((h) => h.pct).filter((v) => v != null);
  const promptCount = (aiRecommendation.topPrompts?.length || 0) + (aiRecommendation.missedPrompts?.length || 0);
  const coverageCaveat = providerCoverageCaveat(meta?.providers);
  const gap = aiRecommendation.competitorCitationGapPct;

  return (
    <div className="card overflow-hidden">
      <div className="px-5 pt-4 pb-3 text-sm text-text">
        Mentioned in {aiRecommendation.mentionedCount} of {aiRecommendation.promptsChecked} {aiRecommendation.providerCount > 1 ? 'AI' : 'ChatGPT'} buyer-intent prompts
        {coverageCaveat && (
          <div className="text-xs mt-1" style={{ color: STATUS.warning.text }}>{coverageCaveat.text}</div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 border-t border-border">
        <div className={CELL}>
          <div className="text-[13px] text-text">Visibility</div>
          <div className="mt-1.5 flex items-baseline gap-1">
            <span className="text-[22px] font-medium tracking-[-0.02em] text-fg tnum">{animatedPct}%</span>
          </div>
          <div className="mt-0.5 text-xs text-faint">of {aiRecommendation.promptsChecked} tracked prompts</div>
          {history.length >= 2 && (
            <div className="mt-3 h-8 w-24">
              <Sparkline data={history} color={pctColor(aiRecommendation.visibilityPct)} stretch dot={false} />
            </div>
          )}
        </div>
        <div className={CELL}>
          <div className="text-[13px] text-text">Share of AI voice</div>
          <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] text-fg tnum">
            {aiRecommendation.shareOfAiVoicePct != null ? `${aiRecommendation.shareOfAiVoicePct}%` : '—'}
          </div>
          <div className="mt-0.5 text-xs text-faint">of all tracked mentions this period</div>
        </div>
        <div className={CELL}>
          <div className="text-[13px] text-text">Competitor citation gap</div>
          <div className="mt-1.5 text-[22px] font-medium tracking-[-0.02em] tnum"
            style={{ color: gap == null ? 'var(--fg)' : gap > 0 ? STATUS.critical.text : STATUS.good.text }}>
            {gap == null ? '—' : <>{gap > 0 ? '+' : ''}{gap}<span className="text-sm font-normal ml-1">pt{Math.abs(gap) === 1 ? '' : 's'}</span></>}
          </div>
          <div className="mt-0.5 text-xs text-faint">
            {gap == null ? '' : gap > 0 ? 'a competitor leads' : 'you lead every tracked competitor'}
          </div>
        </div>
      </div>

      {/* Per-provider breakdown — only rendered once more than one AI
          provider is actually configured, so a single-provider deployment
          (today's default) looks exactly like it always has. */}
      {aiRecommendation.providerCount > 1 && aiRecommendation.providers?.length > 0 && (
        <div className="px-5 border-t border-border">
          {aiRecommendation.providers.map((p) => (
            <div key={p.id} className={ROW}>
              <span className="text-fg">{p.id}</span>
              <span className="tnum text-text">{p.aiVisibilityPct == null ? 'n/a' : `${p.aiVisibilityPct}%`}</span>
            </div>
          ))}
        </div>
      )}

      {/* Collapsed Competitors Section */}
      {!showPrompts && aiRecommendation.competitorsAppearingInstead?.length > 0 && (
        <>
          <div className="px-5 pt-3.5 text-[13px] text-faint border-t border-border">Competitors appearing instead</div>
          <div className="flex flex-wrap gap-1.5 px-5 pt-2 pb-4">
            {aiRecommendation.competitorsAppearingInstead.slice(0, 5).map((c) => (
              <span key={c.name} className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-[7px] text-[13px] bg-white"
                style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)' }}>
                {c.name} <span className="text-faint">{c.count}</span>
              </span>
            ))}
          </div>
        </>
      )}

      {showPrompts && (
        <div className="px-5 py-3 border-t border-border grid grid-cols-1 md:grid-cols-2 gap-x-8 animate-slide-down">
          <div>
            <div className="text-xs text-faint">Mentioned prompts</div>
            {(aiRecommendation.topPrompts || []).slice(0, 4).map((p, i) => (
              <div key={i} className={ROW}><span className="text-fg">"{p.promptText}"</span></div>
            ))}
            {!(aiRecommendation.topPrompts?.length) && (
              <div className="py-2 text-[13px] text-faint">No recommendations this period.</div>
            )}
            <div className="text-xs text-faint mt-1">
              Top listed mentions from {aiRecommendation.providerCount > 1 ? 'AI provider' : 'OpenAI'} checks
            </div>
          </div>
          <div>
            <div className="text-xs text-faint mt-3 md:mt-0">Missed prompts (competitor shown)</div>
            {(aiRecommendation.missedPrompts || []).slice(0, 4).map((p, i) => (
              <div key={i} className={ROW}><span className="text-fg">"{p.promptText}"</span></div>
            ))}
            {!(aiRecommendation.missedPrompts?.length) && (
              <div className="py-2 text-[13px] text-faint">No missed keywords.</div>
            )}
            <div className="text-xs text-faint mt-1">Gap areas flagged for landing page insertion</div>
          </div>
        </div>
      )}

      <div className="tbl-foot">
        <span>{aiRecommendation.promptsChecked} prompts scanned</span>
        {promptCount > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setShowPrompts((s) => !s)} aria-expanded={showPrompts}>
            {showPrompts ? 'Hide prompt scan details' : 'Show prompt scan details'}
          </Button>
        )}
      </div>
    </div>
  );
}
