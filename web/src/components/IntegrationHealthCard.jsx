import { timeAgo } from '../api.js';

const STATUS = {
  ok: { label: 'Connected', dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50' },
  error: { label: 'Error', dot: 'bg-rose-500', text: 'text-rose-700', bg: 'bg-rose-50' },
  unknown: { label: 'Not yet checked', dot: 'bg-slate-400', text: 'text-slate-500', bg: 'bg-slate-100' },
};

// One tile per registered integration (server/integrations/*.js) — grows
// automatically as more are added, never a hardcoded list.
export default function IntegrationHealthCard({ integration, checking, onCheck }) {
  const s = STATUS[integration.status] || STATUS.unknown;

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} />
            <span className="text-sm font-bold text-slate-900 truncate">{integration.label}</span>
          </div>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">{integration.description}</p>
        </div>
        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full shrink-0 ${s.text} ${s.bg}`}>
          {s.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-slate-400">
        <span>Last checked: {integration.lastCheckedAt ? timeAgo(integration.lastCheckedAt) : 'never'}</span>
        {integration.lastSuccessAt && <span>Last success: {timeAgo(integration.lastSuccessAt)}</span>}
        {integration.lastFailureAt && <span>Last failure: {timeAgo(integration.lastFailureAt)}</span>}
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
        className="mt-3 text-xs font-semibold px-3 py-1.5 rounded-lg text-white disabled:opacity-60 transition"
        style={{ background: '#6C63FF' }}>
        {checking ? 'Testing…' : 'Test connection'}
      </button>
    </div>
  );
}
