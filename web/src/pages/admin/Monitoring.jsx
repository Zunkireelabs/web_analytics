import { useEffect, useState } from 'react';
import { api, timeAgo } from '../../api.js';
import PageHeader from '../../components/PageHeader.jsx';
import Tabs from '../../components/Tabs.jsx';
import { Database, Activity, Clock, AlertTriangle, ScrollText, CheckCircle2, XCircle } from 'lucide-react';

const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';
const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';

const ACTOR_TYPES = ['platform_user', 'tenant_user', 'mcp_token', 'system'];

const TABS = [
  { value: 'health', label: 'System Health' },
  { value: 'audit', label: 'Audit Log' },
];

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

function SystemHealthTab() {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    api.systemHealth.get().then(setData).catch((e) => setError(e.message || 'Could not load system health.'));
  }, []);

  return (
    <div className="space-y-6">
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

function AuditLogTab() {
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [sites, setSites] = useState([]);

  const [tenantSiteId, setTenantSiteId] = useState('');
  const [actorType, setActorType] = useState('');
  const [action, setAction] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const load = (nextOffset = 0) => {
    const filters = { limit: LIMIT, offset: nextOffset };
    if (tenantSiteId) filters.tenantSiteId = tenantSiteId;
    if (actorType) filters.actorType = actorType;
    if (action) filters.action = action;
    if (since) filters.since = since;
    if (until) filters.until = until;
    return api.auditLog.list(filters)
      .then((r) => { setRows(r); setOffset(nextOffset); })
      .catch((e) => setError(e.message || 'Could not load audit log.'));
  };

  useEffect(() => {
    load(0);
    api.clients.list().then(setSites).catch(() => {});
  }, []);

  const applyFilters = (e) => {
    e.preventDefault();
    load(0);
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{error}</div>
      )}

      <form onSubmit={applyFilters} className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 grid grid-cols-2 sm:grid-cols-5 gap-4">
        <label className="block">
          <span className={labelCls}>Tenant</span>
          <select className={inputCls} value={tenantSiteId} onChange={(e) => setTenantSiteId(e.target.value)}>
            <option value="">All tenants</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Actor type</span>
          <select className={inputCls} value={actorType} onChange={(e) => setActorType(e.target.value)}>
            <option value="">All actors</option>
            {ACTOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Action contains</span>
          <input className={inputCls} value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. tenant.suspended" />
        </label>
        <label className="block">
          <span className={labelCls}>Since</span>
          <input type="date" className={inputCls} value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelCls}>Until</span>
          <input type="date" className={inputCls} value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <div className="col-span-2 sm:col-span-5">
          <button type="submit"
            className="text-[10px] font-black uppercase tracking-wider px-5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-indigo-500/10"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            Apply Filters
          </button>
        </div>
      </form>

      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6">
        {rows === null ? (
          <div className="p-8 text-center text-xs text-slate-400 animate-pulse">Loading audit trail…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 italic">No matching events.</div>
        ) : (
          <div className="divide-y divide-slate-100/70">
            {rows.map((r) => (
              <div key={r.id} className="py-3 flex items-start gap-3">
                {r.success ? (
                  <CheckCircle2 size={14} className="text-emerald-500 shrink-0 mt-0.5" />
                ) : (
                  <XCircle size={14} className="text-rose-500 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-black text-slate-900 flex items-center gap-2 flex-wrap">
                    <ScrollText size={12} className="text-slate-400" />
                    {r.action}
                    {r.tenant_name && <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">{r.tenant_name}</span>}
                  </p>
                  <p className="text-[10px] font-semibold text-slate-400 mt-0.5">
                    {r.actor_email || r.actor_type} {r.actor_role ? `(${r.actor_role})` : ''} · {new Date(r.created_at).toLocaleString()}
                    {r.target_type && ` · ${r.target_type} #${r.target_id}`}
                  </p>
                  {r.error_message && <p className="text-[10px] font-semibold text-rose-600 mt-0.5">{r.error_message}</p>}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-4 border-t border-slate-100 mt-2">
          <button type="button" disabled={offset === 0} onClick={() => load(Math.max(0, offset - LIMIT))}
            className="text-[10px] font-black uppercase tracking-wider px-4 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-500 transition disabled:opacity-40">
            Newer
          </button>
          <button type="button" disabled={!rows || rows.length < LIMIT} onClick={() => load(offset + LIMIT)}
            className="text-[10px] font-black uppercase tracking-wider px-4 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-500 transition disabled:opacity-40">
            Older
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Monitoring() {
  const [tab, setTab] = useState('health');

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <PageHeader
        title="Monitoring"
        icon="🩺"
        subtitle={tab === 'health'
          ? 'Existing-data rollups only — DB connectivity, integrations, cron, and recent agent failures.'
          : 'Every mutating platform, tenant, and MCP-token action — append-only.'}
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'health' ? <SystemHealthTab /> : <AuditLogTab />}
    </div>
  );
}
