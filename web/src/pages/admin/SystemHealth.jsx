import { useEffect, useState } from 'react';
import { api, timeAgo } from '../../api.js';
import PageHeader from '../../components/PageHeader.jsx';
import { Database, Activity, Clock, AlertTriangle } from 'lucide-react';

const STATUS_COLORS = {
  ok: { color: '#059669', bg: '#ecfdf5', border: '#a7f3d0' },
  unknown: { color: '#64748b', bg: '#f1f5f9', border: '#e2e8f0' },
  error: { color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
};

function StatusPill({ status }) {
  const s = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  return (
    <span className="text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded border leading-none"
      style={{ color: s.color, backgroundColor: s.bg, borderColor: s.border }}>
      {status}
    </span>
  );
}

function Tile({ label, value, icon: Icon, tone = 'slate' }) {
  return (
    <div className="bg-white border border-slate-200/50 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-slate-400">
        {Icon && <Icon size={13} />}
        <span className="text-[9px] font-black uppercase tracking-widest">{label}</span>
      </div>
      <span className={`text-sm font-black ${tone === 'rose' ? 'text-rose-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-slate-800'}`}>{value}</span>
    </div>
  );
}

export default function SystemHealth() {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    api.systemHealth.get().then(setData).catch((e) => setError(e.message || 'Could not load system health.'));
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <PageHeader title="System Health" icon="🩺" subtitle="Existing-data rollups only — DB connectivity, integrations, cron, and recent agent failures." />

      {error && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{error}</div>
      )}

      {!data ? (
        <div className="p-8 text-center text-xs text-slate-400 animate-pulse">Checking system status…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Tile label="Database" icon={Database} value={data.db.connected ? 'Connected' : 'Unreachable'} tone={data.db.connected ? 'emerald' : 'rose'} />
            {Object.entries(data.tenantsByStatus).map(([status, count]) => (
              <Tile key={status} label={`Tenants: ${status}`} icon={Activity} value={count} tone={status === 'active' ? 'emerald' : 'slate'} />
            ))}
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 space-y-3">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-3">Integrations</h3>
            <div className="divide-y divide-slate-100/70">
              {data.integrations.map((i) => (
                <div key={i.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-800">{i.name}</p>
                    {i.errorMessage && <p className="text-[10px] font-semibold text-rose-600 mt-0.5">{i.errorMessage}</p>}
                    <p className="text-[10px] font-semibold text-slate-400 mt-0.5">
                      {i.lastCheckedAt ? `Checked ${timeAgo(i.lastCheckedAt)}` : 'Never checked'}
                    </p>
                  </div>
                  <StatusPill status={i.status} />
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 space-y-3">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-3 flex items-center gap-2">
              <Clock size={12} /> Cron Schedule
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px] font-semibold text-slate-600">
              <div><span className="text-slate-400">Daily job:</span> {data.cron.daily}</div>
              <div><span className="text-slate-400">Weekly report:</span> {data.cron.weekly}</div>
              <div><span className="text-slate-400">Hourly catch-up:</span> {data.cron.hourlyCatchupGuard}</div>
              <div><span className="text-slate-400">Fix verification:</span> {data.cron.fixVerification}</div>
              <div><span className="text-slate-400">Timezone:</span> {data.cron.timezone}</div>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 space-y-3">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-3 flex items-center gap-2">
              <AlertTriangle size={12} /> Agent Failures — Last 24h
            </h3>
            {data.agentRunFailures24h.length === 0 ? (
              <p className="text-xs text-slate-400 italic py-2">No agent run failures in the last 24 hours.</p>
            ) : (
              <div className="divide-y divide-slate-100/70">
                {data.agentRunFailures24h.map((f) => (
                  <div key={`${f.site_id}-${f.agent_id}`} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="text-xs font-bold text-slate-800">{f.agent_id} <span className="text-slate-400 font-medium">· Site #{f.site_id}</span></div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-[10px] font-semibold text-slate-400">{timeAgo(f.last_failure_at)}</span>
                      <span className="text-[10px] font-black text-rose-600 bg-rose-50 border border-rose-100 rounded-full px-2 py-0.5">{f.failure_count}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
