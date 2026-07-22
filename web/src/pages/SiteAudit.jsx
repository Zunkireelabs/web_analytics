import { useEffect, useState, useCallback } from 'react';
import { api, timeAgo, pagePathFor } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import { Radar, Loader2, CheckCircle2, XCircle } from 'lucide-react';

// Minimal Full Site Audit report view (Website Intelligence plan, Phase 6).
// Deliberately simple — a history list, a trigger button, and one run's
// findings — this is the first demoable slice of the bulk audit engine
// (agents/lib/bulk-audit.js), not the final polished report design.

const STATUS_STYLE = {
  running: { icon: Loader2, cls: 'text-amber-600 bg-amber-500/10', spin: true },
  completed: { icon: CheckCircle2, cls: 'text-emerald-600 bg-emerald-500/10' },
  failed: { icon: XCircle, cls: 'text-red-600 bg-red-500/10' },
};

const PRIORITY_STYLE = {
  high: 'text-red-600 bg-red-500/10',
  medium: 'text-amber-600 bg-amber-500/10',
  low: 'text-slate-500 bg-slate-500/10',
};

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.completed;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${s.cls}`}>
      <Icon size={11} className={s.spin ? 'animate-spin' : ''} />
      {status}
    </span>
  );
}

function RunRow({ run, expanded, onToggle }) {
  return (
    <div className="border border-slate-200/70 rounded-2xl overflow-hidden">
      <button type="button" onClick={onToggle}
        className="w-full flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-left hover:bg-slate-50/60 transition-colors">
        <div className="flex items-center gap-3">
          <StatusBadge status={run.status} />
          <span className="text-xs font-bold text-slate-700">Run #{run.id}</span>
          <span className="text-[11px] font-semibold text-slate-400">{timeAgo(run.started_at)}</span>
        </div>
        <div className="flex items-center gap-4 text-[11px] font-semibold text-slate-500">
          {run.health_score != null && (
            <span className={run.health_score >= 80 ? 'text-emerald-600' : run.health_score >= 50 ? 'text-amber-600' : 'text-red-600'}>
              Health {run.health_score}/100
            </span>
          )}
          <span>{run.pages_discovered} discovered</span>
          <span>{run.pages_audited} audited</span>
          {run.error_message && <span className="text-red-500">{run.error_message}</span>}
        </div>
      </button>
      {expanded && <RunFindings runId={run.id} />}
    </div>
  );
}

function RunFindings({ runId }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => { api.siteAudit.get(runId).then(setDetail).catch(() => {}); }, [runId]);

  if (!detail) return <div className="px-5 py-6 text-xs text-slate-400">Loading findings…</div>;
  if (!detail.findings.length) return <div className="px-5 py-6 text-xs text-slate-400">No findings yet.</div>;

  return (
    <div className="border-t border-slate-200/70 divide-y divide-slate-100">
      {detail.findings.map((f) => (
        <div key={f.id} className="px-5 py-3 flex items-start gap-3">
          <span className={`shrink-0 mt-0.5 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ${PRIORITY_STYLE[f.priority] || PRIORITY_STYLE.low}`}>
            {f.priority}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-700 truncate">{f.page ? pagePathFor(f.page) : 'Site-wide'}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">{f.why_it_matters}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SiteAudit() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.siteAudit.list().then(setRuns).catch(() => {}), []);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  // Poll while any run is still in progress — a full audit can take from
  // seconds to well over an hour, so this page needs to reflect real
  // checkpointed progress rather than only the outcome at the very end.
  useEffect(() => {
    if (!runs.some((r) => r.status === 'running')) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [runs, load]);

  const trigger = async () => {
    setTriggering(true);
    setError(null);
    try {
      const { auditRunId } = await api.siteAudit.trigger();
      setExpandedId(auditRunId);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to start audit');
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <PageHeader
        title="Site Audit"
        subtitle="Full-site crawl & technical audit"
        icon={<Radar size={20} />}
        right={
          <button type="button" onClick={trigger} disabled={triggering}
            className="px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider text-white shadow-lg disabled:opacity-50
                       transition-transform hover:scale-[1.02]"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', boxShadow: '0 8px 20px -4px rgba(108,99,255,0.4)' }}>
            {triggering ? 'Starting…' : 'Run Full Audit'}
          </button>
        }
      />

      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 text-xs font-semibold px-4 py-3">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-400">Loading…</div>
      ) : !runs.length ? (
        <div className="rounded-2xl border border-dashed border-slate-200 px-5 py-10 text-center text-sm text-slate-400">
          No audits have run yet — click "Run Full Audit" to crawl and audit the whole site.
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} expanded={expandedId === run.id}
              onToggle={() => setExpandedId(expandedId === run.id ? null : run.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
