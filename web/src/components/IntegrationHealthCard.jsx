import { timeAgo } from '../api.js';

const STATUS = {
  ok: { label: 'Connected', text: 'text-emerald-700', bg: 'bg-emerald-50', bar: '#16A34A', dot: '#16A34A' },
  error: { label: 'Error', text: 'text-rose-700', bg: 'bg-rose-50', bar: '#e11d48', dot: '#e11d48' },
  unknown: { label: 'Not yet checked', text: 'text-slate-500', bg: 'bg-slate-100', bar: '#cbd5e1', dot: '#94a3b8' },
};

// What each integration actually IS (its job), independent of whether it's
// currently healthy — status is conveyed separately via the pill/top bar/
// dot below, so the icon doesn't need to double as a check/error glyph.
// Falls back to a generic plug for any future integration not listed here,
// so a new one registered in server/integrations/*.js never renders blank.
const TYPE_ICON = {
  'daily-pipeline': '🔄',
  'google-oauth': '🔑',
  'gsc-url-inspection': '🔍',
  github: '🐙',
};
const DEFAULT_ICON = '🔌';

// One tile per registered integration (server/integrations/*.js) — grows
// automatically as more are added, never a hardcoded list.
export default function IntegrationHealthCard({ integration, checking, onCheck }) {
  const s = STATUS[integration.status] || STATUS.unknown;
  const icon = TYPE_ICON[integration.id] || DEFAULT_ICON;

  return (
    <div className="rounded-2xl border border-slate-100 bg-white overflow-hidden transition hover:border-slate-200 hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] flex flex-col h-full">
      <div className="h-[3px] shrink-0" style={{ background: `linear-gradient(90deg, ${s.bar}, ${s.bar}55)` }} />
      <div className="p-4 flex flex-col flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="relative w-9 h-9 rounded-xl grid place-items-center text-base shrink-0" style={{ background: `${s.dot}14` }}>
              {icon}
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white" style={{ background: s.dot }} />
            </span>
            <span className="text-sm font-bold text-slate-900 truncate block">{integration.label}</span>
          </div>
          <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full shrink-0 ${s.text} ${s.bg}`}>
            {s.label}
          </span>
        </div>

        <p className="text-xs text-slate-500 mt-2.5 leading-relaxed">{integration.description}</p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1">
            <span className="opacity-70">🕓</span>
            {integration.lastCheckedAt ? timeAgo(integration.lastCheckedAt) : 'never checked'}
          </span>
          {integration.lastSuccessAt && (
            <span className="inline-flex items-center gap-1 text-emerald-600">
              <span>✓</span> {timeAgo(integration.lastSuccessAt)}
            </span>
          )}
          {integration.lastFailureAt && (
            <span className="inline-flex items-center gap-1 text-rose-500">
              <span>✕</span> {timeAgo(integration.lastFailureAt)}
            </span>
          )}
        </div>

        {integration.errorMessage && (
          <div className="mt-3 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 text-[11px] text-rose-700 leading-relaxed">
            {integration.errorMessage}
          </div>
        )}
        {integration.recoveryAction && (
          <div className="mt-2 text-[11px] text-indigo-600 leading-relaxed">→ {integration.recoveryAction}</div>
        )}

        <button type="button" onClick={onCheck} disabled={checking}
          className="mt-auto pt-3 self-start text-xs font-semibold px-3 py-1.5 rounded-lg text-white disabled:opacity-60 transition"
          style={{ background: '#6C63FF' }}>
          {checking ? 'Testing…' : 'Test connection'}
        </button>
      </div>
    </div>
  );
}
