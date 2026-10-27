import { Check, ChevronUp } from 'lucide-react';
import Badge from '../Badge.jsx';
import { STATUS } from '../../lib/palette.js';

const show = (m, v) => (v == null ? '—' : m.unit === 'percent' ? `${v}%` : Number(v).toLocaleString('en-US'));

// One competitor: who it is, how we found it, and for each measure whether it is ahead of this site
// or behind it, in words. Measures with no real data for this competitor are not shown.
export default function CompetitorCard({ card }) {
  const verdict = card.total === 0
    ? <Badge tone="outline">Not enough data yet</Badge>
    : card.aheadN === 0 ? <Badge tone="green">You lead on all {card.total}</Badge>
      : <Badge tone={card.leadsYou ? 'red' : 'amber'}>Ahead on {card.aheadN} of {card.total}</Badge>;

  return (
    <div className="tray-card overflow-hidden">
      <div className="px-4 pt-3.5 pb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-[-0.01em] text-fg min-w-0">
            <span className="truncate">{card.domain}</span>
            <a href={`https://${card.domain}`} target="_blank" rel="noreferrer" aria-label={`Open ${card.domain}`} className="text-xs text-faint hover:text-fg shrink-0 font-normal">↗</a>
          </h2>
          <p className="text-xs text-faint mt-0.5">{[card.source, card.note].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="shrink-0">{verdict}</div>
      </div>

      {card.measures.map((m) => (
        <div key={m.key} className="flex items-center gap-3 px-4 py-2.5 border-t border-border">
          <span className="w-5 h-5 rounded-full grid place-items-center shrink-0"
            style={{ background: m.ahead ? '#fdecea' : '#e8f5ee', color: m.ahead ? STATUS.critical.text : STATUS.good.text }}>
            {m.ahead ? <ChevronUp size={12} strokeWidth={2.5} /> : <Check size={12} strokeWidth={2.5} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-fg">{m.label}</div>
            <div className="hidden sm:block text-xs text-faint">{m.hint}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[13px] tnum text-fg">
              {m.you != null && <>{show(m, m.you)} <span className="text-faint">vs</span> </>}{show(m, m.them)}
            </div>
            <div className="text-xs" style={{ color: m.ahead ? STATUS.critical.text : STATUS.good.text }}>
              {m.ahead ? 'They are ahead' : 'You lead'} · {m.detail}
            </div>
          </div>
        </div>
      ))}

      {card.searches.length > 0 && (
        <div className="px-4 py-3 border-t border-border">
          <div className="text-xs text-faint mb-1.5">Searches where they show above you</div>
          <div className="flex flex-wrap gap-1.5">
            {card.searches.slice(0, 6).map((s) => (
              <span key={s.query} className="inline-flex items-center h-[26px] px-2.5 rounded-[7px] text-[13px] bg-white text-fg"
                style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)' }}
                title={`They are #${s.theirPosition}${s.yourPosition == null ? ', you are not in the top 20' : `, you are #${s.yourPosition}`}`}>
                “{s.query}”
              </span>
            ))}
            {card.searches.length > 6 && <span className="text-xs text-faint self-center">+{card.searches.length - 6} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}
