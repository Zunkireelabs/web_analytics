import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import PageHeader from '../../components/PageHeader.jsx';
import { ScrollText, CheckCircle2, XCircle } from 'lucide-react';

const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';
const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';

const ACTOR_TYPES = ['platform_user', 'tenant_user', 'mcp_token', 'system'];

export default function AuditLog() {
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
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <PageHeader title="Audit Log" icon="📜" subtitle="Every mutating platform, tenant, and MCP-token action — append-only." />

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
