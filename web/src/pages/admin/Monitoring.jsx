import { useEffect, useState } from 'react';
import { api, timeAgo } from '../../api.js';
import PageToolbar from '../../components/PageToolbar.jsx';
import PageIntro from '../../components/layout/PageIntro.jsx';
import KpiStrip from '../../components/layout/KpiStrip.jsx';
import { Tray, TrayCard } from '../../components/layout/Tray.jsx';
import SegmentedTabs from '../../components/SegmentedTabs.jsx';
import Badge from '../../components/Badge.jsx';
import Button from '../../components/Button.jsx';
import Field from '../../components/Field.jsx';
import Select from '../../components/Select.jsx';
import { SettingsRows } from '../../components/settings/SettingsCard.jsx';
import { ScrollText, CheckCircle2, XCircle, Plug, Filter } from 'lucide-react';
import { STATUS } from '../../lib/palette.js';

const ACTOR_TYPES = ['platform_user', 'tenant_user', 'mcp_token', 'system'];

const TABS = [
  { value: 'health', label: 'System health' },
  { value: 'audit', label: 'Audit log' },
];

const STATUS_TONES = { ok: 'green', unknown: 'grey', error: 'red' };

const ErrorBanner = ({ children }) => (
  <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2 mb-3">{children}</div>
);

const Skeleton = () => (
  <div className="px-5 py-4">
    <div className="h-5 bg-muted rounded-control animate-pulse" />
  </div>
);

function SystemHealthTab() {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    api.systemHealth.get().then(setData).catch((e) => setError(e.message || 'Could not load system health.'));
  }, []);

  const kpis = data ? [
    {
      label: 'Database',
      value: data.db.connected ? 'Connected' : 'Unreachable',
      delta: { text: data.db.connected ? 'OK' : 'Down', tone: data.db.connected ? 'good' : 'bad' },
    },
    ...Object.entries(data.tenantsByStatus).map(([status, count]) => ({
      label: `Tenants: ${status}`,
      value: count,
      delta: status === 'active' ? { text: 'Active', tone: 'good' } : undefined,
    })),
  ] : [];

  return (
    <>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!data ? (
        error ? null : (
          <Tray>
            <TrayCard title="Checking system status…"><Skeleton /></TrayCard>
          </Tray>
        )
      ) : (
        <>
          <KpiStrip items={kpis} cols={Math.min(6, Math.max(3, kpis.length))} />

          <Tray className="mt-3">
            <TrayCard title="Integrations" subtitle="Last recorded health check for each connected service">
              <div className="border-t border-border">
                {data.integrations.map((i) => (
                  <div key={i.id} className="px-5 py-3 border-b border-border last:border-0 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-fg flex items-center gap-2">
                        <Plug size={13} className="text-faint shrink-0" aria-hidden />{i.name}
                      </p>
                      {i.errorMessage && <p className="text-xs text-[#b42318] mt-0.5 break-words">{i.errorMessage}</p>}
                      <p className="text-xs text-faint mt-0.5">
                        {i.lastCheckedAt ? `Checked ${timeAgo(i.lastCheckedAt)}` : 'Never checked'}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONES[i.status] || 'grey'} className="shrink-0">{i.status}</Badge>
                  </div>
                ))}
              </div>
            </TrayCard>
          </Tray>

          <Tray className="mt-3" cols={2}>
            <TrayCard title="Cron schedule" subtitle="When each scheduled job runs">
              <div className="border-t border-border">
                <SettingsRows rows={[
                  ['Daily job', data.cron.daily],
                  ['Weekly report', data.cron.weekly],
                  ['Hourly catch-up', data.cron.hourlyCatchupGuard],
                  ['Fix verification', data.cron.fixVerification],
                  ['Timezone', data.cron.timezone],
                ]} />
              </div>
            </TrayCard>

            <TrayCard title="Agent failures" subtitle="Last 24 hours">
              <div className="border-t border-border">
                {data.agentRunFailures24h.length === 0 ? (
                  <p className="px-5 py-4 text-[13px] text-faint">No agent run failures in the last 24 hours.</p>
                ) : data.agentRunFailures24h.map((f) => (
                  <div key={`${f.site_id}-${f.agent_id}`} className="px-5 py-3 border-b border-border last:border-0 flex items-center justify-between gap-3">
                    <div className="min-w-0 text-[13px] font-medium text-fg truncate">
                      {f.agent_id} <span className="text-faint font-normal">· Site #{f.site_id}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-faint">{timeAgo(f.last_failure_at)}</span>
                      <Badge tone="red">{f.failure_count}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </TrayCard>
          </Tray>
        </>
      )}
    </>
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
    <>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Tray>
        <TrayCard title="Filters" subtitle="Narrow the audit trail by tenant, actor, action or date">
          <form onSubmit={applyFilters} className="border-t border-border px-4 sm:px-5 py-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <Select label="Tenant" value={tenantSiteId} onChange={(e) => setTenantSiteId(e.target.value)}>
              <option value="">All tenants</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select label="Actor type" value={actorType} onChange={(e) => setActorType(e.target.value)}>
              <option value="">All actors</option>
              {ACTOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
            <Field label="Action contains" value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. tenant.suspended" />
            <Field label="Since" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
            <Field label="Until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
            <div className="sm:col-span-2 lg:col-span-5">
              <Button type="submit" variant="primary"><Filter size={14} />Apply filters</Button>
            </div>
          </form>
        </TrayCard>
      </Tray>

      <Tray className="mt-3">
        <TrayCard title="Events" subtitle={rows ? `${rows.length} shown` : undefined}>
          <div className="border-t border-border">
            {rows === null ? (
              <Skeleton />
            ) : rows.length === 0 ? (
              <p className="px-5 py-6 text-center text-[13px] text-faint">No matching events.</p>
            ) : rows.map((r) => (
              <div key={r.id} className="px-4 sm:px-5 py-3 border-b border-border last:border-0 flex items-start gap-3">
                {r.success ? (
                  <CheckCircle2 size={15} className="shrink-0 mt-0.5" style={{ color: STATUS.good.color }} aria-label="Succeeded" />
                ) : (
                  <XCircle size={15} className="shrink-0 mt-0.5" style={{ color: STATUS.critical.color }} aria-label="Failed" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-fg flex items-center gap-2 flex-wrap break-all">
                    <ScrollText size={13} className="text-faint shrink-0" aria-hidden />
                    {r.action}
                    {r.tenant_name && <Badge tone="grey">{r.tenant_name}</Badge>}
                  </p>
                  <p className="text-xs text-faint mt-0.5 break-words">
                    {r.actor_email || r.actor_type} {r.actor_role ? `(${r.actor_role})` : ''} · {new Date(r.created_at).toLocaleString()}
                    {r.target_type && ` · ${r.target_type} #${r.target_id}`}
                  </p>
                  {r.error_message && <p className="text-xs text-[#b42318] mt-0.5 break-words">{r.error_message}</p>}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-t border-border">
            <Button disabled={offset === 0} onClick={() => load(Math.max(0, offset - LIMIT))}>Newer</Button>
            <Button disabled={!rows || rows.length < LIMIT} onClick={() => load(offset + LIMIT)}>Older</Button>
          </div>
        </TrayCard>
      </Tray>
    </>
  );
}

export default function Monitoring() {
  const [tab, setTab] = useState('health');

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageToolbar>
        <SegmentedTabs options={TABS} value={tab} onChange={setTab} />
      </PageToolbar>

      <PageIntro
        title="Monitoring"
        subtitle={tab === 'health'
          ? 'Existing-data rollups only — DB connectivity, integrations, cron, and recent agent failures.'
          : 'Every mutating platform, tenant, and MCP-token action — append-only.'}
      />
      {tab === 'health' ? <SystemHealthTab /> : <AuditLogTab />}
    </div>
  );
}
