import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, timeAgo, daysAgo, pagePathFor } from '../../api.js';
import { useCountUp } from '../../useCountUp.js';
import HealthScoreCard from '../../components/HealthScoreCard.jsx';
import DraftModal from '../../components/DraftModal.jsx';
import {
  Play, ScrollText, Bot, Activity, Radio, Cable, Cpu, Clock, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, ArrowRight, Layers, Sparkles, Target, Globe, FileText,
  BrainCircuit, Shield, Zap, TrendingUp, TrendingDown, HeartPulse,
} from 'lucide-react';

const CATEGORY_META = {
  seo: { label: 'SEO', icon: Target, color: '#6C63FF' },
  geo: { label: 'Audience', icon: Globe, color: '#0ea5e9' },
  content: { label: 'Content', icon: FileText, color: '#14b8a6' },
  meta: { label: 'Overview', icon: BrainCircuit, color: '#ec4899' },
  security: { label: 'Security', icon: Shield, color: '#ef4444' },
  performance: { label: 'Performance', icon: Zap, color: '#f59e0b' },
  accessibility: { label: 'Accessibility', icon: Layers, color: '#8b5cf6' },
};

const RUN_STATUS = {
  ok: { color: '#059669', bg: '#ecfdf5', border: '#a7f3d0', label: 'Healthy', icon: CheckCircle2 },
  'insufficient-data': { color: '#d97706', bg: '#fffbeb', border: '#fde68a', label: 'Idle', icon: Clock },
  error: { color: '#dc2626', bg: '#fef2f2', border: '#fecaca', label: 'Failed', icon: AlertTriangle },
  null: { color: '#94a3b8', bg: '#f8fafc', border: '#e2e8f0', label: 'Never run', icon: Clock },
};

const PIPELINE_STATUS = {
  ok: { color: '#059669', bg: '#ecfdf5', border: '#a7f3d0', label: 'Healthy' },
  unknown: { color: '#94a3b8', bg: '#f8fafc', border: '#e2e8f0', label: 'Unknown' },
  error: { color: '#dc2626', bg: '#fef2f2', border: '#fecaca', label: 'Disconnected' },
};

const PRIORITY_META = {
  high: { color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
  medium: { color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
  low: { color: '#64748b', bg: '#f1f5f9', border: '#e2e8f0' },
};

// Genuinely aspirational — no fabricated numbers behind any of these.
const NOT_YET_INSTRUMENTED = [
  'Execution Queue / Queue Position — agent runs execute synchronously today, no queue exists',
  'Retry Count — no persisted retry counter (one in-memory, unlogged retry exists in the orchestrator)',
  'API Response Times — no request-latency tracking exists yet',
  'AI Token Usage — no token accounting at any LLM call site yet',
  'Forecast Accuracy — no actual-vs-predicted comparison exists (only forecast generation itself)',
  'CPU / Memory — no server resource monitoring exists',
];

function GlassStat({ icon: Icon, label, value, sub, tone = 'slate', trend }) {
  const toneColor = { emerald: '#059669', rose: '#dc2626', amber: '#d97706', indigo: '#6C63FF', slate: '#475569' }[tone];
  return (
    <div className="group relative rounded-3xl bg-white p-5 shadow-sm border border-slate-150 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 overflow-hidden">
      <div className="absolute -top-8 -right-8 w-24 h-24 rounded-full opacity-[0.07] transition-transform duration-500 group-hover:scale-125" style={{ background: toneColor }} />
      <div className="relative flex items-start justify-between mb-3">
        <span className="w-9 h-9 rounded-2xl grid place-items-center shrink-0" style={{ background: `${toneColor}14`, color: toneColor }}>
          <Icon size={16} strokeWidth={2.25} />
        </span>
        {trend != null && (
          <span className={`inline-flex items-center gap-0.5 text-[10px] font-black px-1.5 py-0.5 rounded-full ${trend >= 0 ? 'text-emerald-600 bg-emerald-50' : 'text-rose-600 bg-rose-50'}`}>
            {trend >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}{Math.abs(trend)}
          </span>
        )}
      </div>
      <div className="relative text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">{label}</div>
      <div className="relative text-3xl font-black text-slate-900 tracking-tight">{value}</div>
      {sub && <div className="relative text-[11px] font-bold text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function Panel({ icon: Icon, title, subtitle, defaultOpen = true, children, count, id }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div id={id} className="bg-white rounded-3xl border border-slate-150 shadow-sm overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-6 py-5 text-left cursor-pointer hover:bg-slate-50/60 transition">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-2xl bg-indigo-50 grid place-items-center text-indigo-500 shrink-0"><Icon size={15} /></span>
          <div className="min-w-0">
            <h3 className="text-sm font-black text-slate-800">{title}</h3>
            {subtitle && <p className="text-[11px] font-semibold text-slate-400 mt-0.5 truncate">{subtitle}</p>}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {count != null && <span className="text-[10px] font-black text-slate-400 font-mono bg-slate-50 px-2 py-1 rounded-full">{count}</span>}
          {open ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
        </div>
      </button>
      {open && <div className="px-6 pb-6 border-t border-slate-100 pt-5">{children}</div>}
    </div>
  );
}

function CategoryBar({ category, count, maxCount }) {
  const meta = CATEGORY_META[category] || CATEGORY_META.seo;
  const Icon = meta.icon;
  const pct = maxCount === 0 ? 100 : Math.max(6, 100 - (count / maxCount) * 100);
  return (
    <div className="flex items-center gap-2.5">
      <Icon size={12} style={{ color: meta.color }} className="shrink-0" />
      <span className="text-[10px] font-bold text-slate-500 w-20 shrink-0">{meta.label}</span>
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: meta.color }} />
      </div>
      <span className="text-[9px] font-black text-slate-400 w-14 text-right shrink-0">{count} open</span>
    </div>
  );
}

function FindingCard({ finding, generating, onGenerate }) {
  const meta = CATEGORY_META[finding.category] || CATEGORY_META.seo;
  const Icon = meta.icon;
  const canFix = Boolean(finding.recommendedAction?.generatorId);
  const pagePath = pagePathFor(finding.evidence?.page);

  return (
    <div className="rounded-3xl border border-slate-150 bg-white p-5 shadow-sm hover:shadow-lg transition-all duration-300 relative overflow-hidden">
      <div className="absolute top-0 inset-x-0 h-1" style={{ background: 'linear-gradient(90deg, #dc2626, #dc262633)' }} />
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-xl grid place-items-center shrink-0" style={{ background: `${meta.color}14`, color: meta.color }}><Icon size={14} /></span>
          <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border" style={{ ...PRIORITY_META[finding.priority] && { color: PRIORITY_META[finding.priority].color, backgroundColor: PRIORITY_META[finding.priority].bg, borderColor: PRIORITY_META[finding.priority].border } }}>
            {finding.priority || 'medium'}
          </span>
        </div>
      </div>
      <p className="text-sm font-black text-slate-900 leading-snug mb-1.5">{finding.recommendedAction?.label || meta.label}</p>
      <p className="text-[11.5px] font-medium text-slate-500 leading-relaxed mb-3">{finding.whyItMatters}</p>
      {pagePath && <p className="text-[10px] font-mono text-indigo-500 bg-indigo-50/50 rounded-lg px-2 py-1 mb-3 truncate">{pagePath}</p>}
      <div className="flex items-center gap-4 mb-4">
        {finding.expectedImpact?.label && (
          <div><div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Impact</div><div className="text-xs font-black text-slate-800">{finding.expectedImpact.label}</div></div>
        )}
        {finding.confidence != null && (
          <div><div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Confidence</div><div className="text-xs font-black text-slate-800 capitalize">{finding.confidence}</div></div>
        )}
      </div>
      <button type="button" onClick={() => onGenerate(finding)} disabled={!canFix || generating}
        title={!canFix ? 'No automated fix available for this finding yet' : undefined}
        className="w-full text-[10px] font-black uppercase tracking-wider py-3 rounded-2xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-sm disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
        {generating ? 'Generating…' : 'Generate Fix'}
      </button>
    </div>
  );
}

export default function AiOperationsCenter() {
  const [ops, setOps] = useState(null); // null = loading
  const [cc, setCc] = useState(null); // null = loading (site's own real health/findings data)
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [generatingId, setGeneratingId] = useState(null);
  const [activeDraft, setActiveDraft] = useState(null);

  const load = () => Promise.all([api.opsCenter.get(), api.commandCenter.get()])
    .then(([o, c]) => { setOps(o); setCc(c); setError(null); })
    .catch((e) => setError(e.message || 'Could not load operations data.'));

  useEffect(() => { load(); }, []);

  const runFullAnalysis = async () => {
    setRunning(true);
    setError(null);
    try {
      const fresh = await api.commandCenter.refresh(daysAgo(7), daysAgo(0));
      setCc(fresh);
      await load();
    } catch (e) {
      setError(e.message || 'Analysis run failed');
    } finally {
      setRunning(false);
    }
  };

  const generateFix = async (finding) => {
    setGeneratingId(finding.id);
    setError(null);
    try {
      const draft = await api.actionCenter.generate(finding.recommendedAction?.generatorId, finding.recommendedAction?.params, finding.agentId, finding.id);
      setActiveDraft(draft);
    } catch (e) {
      setError(e.message || 'Generation failed');
    } finally {
      setGeneratingId(null);
    }
  };

  const categoryBreakdown = useMemo(() => {
    if (!cc) return [];
    const counts = new Map();
    for (const f of [...(cc.criticalIssues || []), ...(cc.discoveries || []), ...(cc.growthOpportunities || [])]) {
      counts.set(f.category, (counts.get(f.category) || 0) + 1);
    }
    const max = Math.max(1, ...counts.values());
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([category, count]) => ({ category, count, max }));
  }, [cc]);

  const summaryBullets = useMemo(() => {
    const narrative = cc?.executiveSummary?.narrative;
    if (!narrative) return [];
    return narrative.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  }, [cc]);

  const agentSuccessRate = ops ? Math.round((ops.agentTaskforce.filter((a) => a.lastRunStatus === 'ok').length / Math.max(1, ops.agentTaskforce.length)) * 100) : 0;
  const animatedSuccessRate = useCountUp(agentSuccessRate, 800);
  const failedCount = ops ? ops.agentTaskforce.filter((a) => a.lastRunStatus === 'error').length : 0;
  const activeCount = ops ? ops.agentTaskforce.filter((a) => a.lastRunStatus === 'ok').length : 0;
  const topRecommendation = cc?.recommendedActions?.[0];

  const loading = !ops || !cc;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-indigo-500 mb-1"><Radio size={13} className="animate-pulse" /><span className="text-[10px] font-black uppercase tracking-widest">AI Operating System</span></div>
          <h1 className="text-[34px] font-black text-slate-900 tracking-tight leading-none">AI Operations Center</h1>
          <p className="text-sm text-slate-400 font-medium mt-1.5">Zunkiree Labs — platform-wide agent intelligence, live.</p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <a href="#execution-log" className="text-[11px] font-black uppercase tracking-wider px-4 py-3.5 rounded-2xl border border-slate-200 text-slate-500 hover:text-slate-800 hover:border-slate-300 transition cursor-pointer flex items-center gap-1.5">
            <ScrollText size={13} /> View Execution Log
          </a>
          <button type="button" onClick={runFullAnalysis} disabled={running || loading}
            className="text-[11px] font-black uppercase tracking-wider px-5 py-3.5 rounded-2xl text-white transition hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-indigo-500/20 disabled:opacity-60 cursor-pointer flex items-center gap-1.5"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            <Play size={13} fill="white" /> {running ? 'Running Full Analysis…' : 'Run Full Analysis'}
          </button>
        </div>
      </div>

      {error && <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-2xl px-4 py-3">{error}</div>}

      {loading ? (
        <div className="space-y-4">
          <div className="h-40 bg-white rounded-3xl border border-slate-150 animate-pulse" />
          <div className="grid grid-cols-4 gap-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-28 bg-white rounded-3xl border border-slate-150 animate-pulse" />)}</div>
        </div>
      ) : (
        <>
          {/* Status strip */}
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 px-1 text-[11px] font-bold text-slate-400">
            <span>Last run <span className="text-slate-700 font-black">{cc.stats?.lastAnalyzedAt ? timeAgo(cc.stats.lastAnalyzedAt) : 'never'}</span></span>
            <span className="flex items-center gap-1.5">Status <span className={`inline-flex items-center gap-1 font-black ${running ? 'text-amber-600' : 'text-emerald-600'}`}><span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />{running ? 'Running' : 'Ready'}</span></span>
            <span><span className="text-slate-700 font-black">{ops.agentTaskforce.length}</span> Agents Available</span>
          </div>

          {/* Hero: Website Health */}
          <div className="rounded-[28px] border border-slate-150 bg-gradient-to-br from-white via-white to-indigo-50/30 shadow-sm p-2 grid grid-cols-1 lg:grid-cols-5 gap-2">
            <div className="lg:col-span-3 rounded-[22px] overflow-hidden">
              <HealthScoreCard score={cc.health.score} trendWeek={cc.health.trendWeek} loading={false} />
            </div>
            <div className="lg:col-span-2 p-5 flex flex-col justify-center gap-3">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">By Category</div>
              {categoryBreakdown.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No open findings by category.</p>
              ) : categoryBreakdown.map((c) => <CategoryBar key={c.category} category={c.category} count={c.count} maxCount={c.max} />)}
            </div>
          </div>

          {/* Four metric cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <GlassStat icon={Sparkles} label="Agent Success Rate" value={`${animatedSuccessRate}%`} sub={agentSuccessRate >= 90 ? 'High reliability' : agentSuccessRate >= 70 ? 'Stable' : 'Needs attention'} tone={agentSuccessRate >= 90 ? 'emerald' : agentSuccessRate >= 70 ? 'amber' : 'rose'} />
            <GlassStat icon={Bot} label="Active Agents" value={`${activeCount} / ${ops.agentTaskforce.length}`} sub={failedCount > 0 ? `${failedCount} failed` : 'All operational'} tone={failedCount > 0 ? 'rose' : 'emerald'} />
            <GlassStat icon={HeartPulse} label="Forecast Engine" value={ops.technicalSummary.forecastEngineReachable ? 'Healthy' : 'Unreachable'} sub="data-analyst-agent" tone={ops.technicalSummary.forecastEngineReachable ? 'emerald' : 'rose'} />
            <GlassStat icon={Target} label="Recommendations" value={ops.technicalSummary.recommendationsPublished} sub={`${cc.stats?.criticalIssues ?? 0} high priority`} tone="indigo" />
          </div>

          {/* AI Executive Summary — conversational card */}
          <div className="rounded-[24px] border border-slate-150 bg-white shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <span className="w-9 h-9 rounded-2xl grid place-items-center text-white shadow-sm" style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}><Sparkles size={15} /></span>
                <div><h3 className="text-sm font-black text-slate-800">AI Executive Summary</h3><p className="text-[10px] font-bold text-slate-400">{cc.executiveSummary?.generatedAt ? `Generated ${timeAgo(cc.executiveSummary.generatedAt)}` : 'Not generated yet'}</p></div>
              </div>
            </div>
            {summaryBullets.length === 0 ? (
              <p className="text-xs text-slate-400 italic py-4">No executive summary generated yet — run a full analysis to generate one.</p>
            ) : (
              <ul className="space-y-2.5 mb-5">
                {summaryBullets.map((b, i) => (
                  <li key={i} className="text-[13.5px] font-medium text-slate-600 leading-relaxed flex items-start gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full mt-2 shrink-0" style={{ background: '#6C63FF' }} />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
            {topRecommendation && (
              <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-slate-100">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Recommended Action</span>
                <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full">{topRecommendation.tag}</span>
              </div>
            )}
          </div>

          {/* Critical Findings */}
          <Panel icon={AlertTriangle} title="Critical Findings" subtitle="Highest-priority real issues AI has detected" count={cc.criticalIssues?.length || 0}>
            {(cc.criticalIssues?.length || 0) === 0 ? (
              <p className="text-xs text-slate-400 italic py-2">No critical findings right now.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {cc.criticalIssues.map((f) => <FindingCard key={f.id} finding={f} generating={generatingId === f.id} onGenerate={generateFix} />)}
              </div>
            )}
          </Panel>

          {/* Agent Taskforce */}
          <Panel icon={Bot} title="Agent Taskforce" subtitle="Every registered agent's most recent run, across all tenants" count={ops.agentTaskforce.length}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {ops.agentTaskforce.map((a) => {
                const s = RUN_STATUS[a.lastRunStatus] || RUN_STATUS.null;
                const Icon = s.icon;
                return (
                  <div key={a.id} className="rounded-2xl border border-slate-150 bg-gradient-to-br from-slate-50/80 to-white p-4 flex flex-col gap-2 hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black text-slate-800 truncate">{a.name}</span>
                      <span className="text-[8px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border shrink-0 flex items-center gap-1" style={{ color: s.color, backgroundColor: s.bg, borderColor: s.border }}>
                        <Icon size={9} />{s.label}
                      </span>
                    </div>
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{a.category}</span>
                    <div className="flex items-center justify-between text-[10px] font-semibold text-slate-500 mt-1 pt-2 border-t border-slate-100">
                      <span>{a.lastRunAt ? timeAgo(a.lastRunAt) : 'Never run'}</span>
                      <span className="font-mono font-black text-slate-600">{a.tookMs != null ? `${a.tookMs}ms` : '—'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* Execution Timeline */}
          <Panel id="execution-log" icon={ScrollText} title="Execution Timeline" subtitle="Most recent agent runs across every tenant" defaultOpen={false} count={ops.executionLog.length}>
            {ops.executionLog.length === 0 ? (
              <p className="text-xs text-slate-400 italic py-2">No agent runs recorded yet.</p>
            ) : (
              <div className="relative max-h-96 overflow-y-auto pl-1">
                <div className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-150" />
                <div className="space-y-4">
                  {ops.executionLog.map((r, i) => {
                    const s = RUN_STATUS[r.status] || RUN_STATUS.null;
                    return (
                      <div key={i} className="relative pl-6">
                        <span className="absolute left-0 top-1 w-3.5 h-3.5 rounded-full border-2 border-white shadow" style={{ background: s.color }} />
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[9px] font-mono text-slate-400 shrink-0">{new Date(r.createdAt).toLocaleTimeString()}</span>
                            <span className="font-black text-slate-800 truncate">{r.agentId}</span>
                            <span className="text-slate-400 font-medium truncate">· {r.siteName}</span>
                          </div>
                          <span className="text-[9px] font-black uppercase tracking-wider" style={{ color: s.color }}>{s.label}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Panel>

          {/* Pipeline Health */}
          <Panel icon={Cable} title="Pipeline Health" subtitle="GSC, GA4, Forecast Engine, and shared integrations" count={ops.pipelineHealth.length}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {ops.pipelineHealth.map((p) => {
                const s = PIPELINE_STATUS[p.status] || PIPELINE_STATUS.unknown;
                return (
                  <div key={p.id} className="rounded-2xl border border-slate-150 bg-white p-4 flex items-center justify-between gap-3 hover:shadow-md transition-all duration-300">
                    <div className="min-w-0">
                      <p className="text-xs font-black text-slate-800 truncate">{p.name}</p>
                      <p className="text-[10px] font-semibold text-slate-400 mt-0.5">{p.lastCheckedAt ? `Checked ${timeAgo(p.lastCheckedAt)}` : 'Never checked'}</p>
                      {p.errorMessage && <p className="text-[10px] font-semibold text-rose-500 mt-0.5 truncate">{p.errorMessage}</p>}
                    </div>
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color, boxShadow: p.status === 'ok' ? `0 0 8px ${s.color}` : 'none' }} />
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* Model Status + Scheduler */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <Panel icon={Cpu} title="Model Status" defaultOpen={false}>
              <div className="space-y-3 text-[12px] font-semibold text-slate-600">
                <div className="flex justify-between items-center"><span className="text-slate-400">Active provider</span><span className="font-black text-slate-800 capitalize bg-slate-50 px-2.5 py-1 rounded-lg">{ops.modelStatus.provider}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-400">Daily-tier model</span><span className="font-mono text-[11px]">{ops.modelStatus.dailyModel}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-400">Monthly-tier model</span><span className="font-mono text-[11px]">{ops.modelStatus.monthlyModel}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-400">Forecast engine model</span><span className="font-mono text-[11px]">{ops.modelStatus.forecastModel}</span></div>
              </div>
            </Panel>

            <Panel icon={Clock} title="Scheduler" defaultOpen={false}>
              <div className="space-y-3 text-[12px] font-semibold text-slate-600">
                <div className="flex justify-between items-center"><span className="text-slate-400">Daily job</span><span className="font-mono text-[11px]">{ops.cron.daily}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-400">Weekly report</span><span className="font-mono text-[11px]">{ops.cron.weekly}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-400">Hourly catch-up</span><span className="font-mono text-[11px]">{ops.cron.hourlyCatchupGuard}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-400">Timezone</span><span className="font-mono text-[11px]">{ops.cron.timezone}</span></div>
              </div>
              <p className="text-[10px] text-slate-400 italic mt-3">Configured schedule shown — no live next-run telemetry yet.</p>
            </Panel>
          </div>

          {/* Technical Audit + System Health links */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <Panel icon={Layers} title="Technical Audit" defaultOpen={false}>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">Full mutation history — staff actions, tenant changes, MCP token events.</p>
              <Link to="/admin/audit-log" className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-indigo-600 hover:underline">Open Audit Log <ArrowRight size={12} /></Link>
            </Panel>
            <Panel icon={HeartPulse} title="System Health" defaultOpen={false}>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">Database connectivity, tenant counts, and 24h agent failure rollups.</p>
              <Link to="/admin/system-health" className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-indigo-600 hover:underline">Open System Health <ArrowRight size={12} /></Link>
            </Panel>
          </div>

          {/* Honest roadmap */}
          <Panel icon={Activity} title="Not Yet Instrumented" subtitle="Genuinely aspirational — no fabricated numbers" defaultOpen={false}>
            <ul className="space-y-2.5">
              {NOT_YET_INSTRUMENTED.map((item, i) => (
                <li key={i} className="text-[12px] font-semibold text-slate-500 flex items-start gap-2.5">
                  <span className="w-1 h-1 rounded-full bg-slate-300 mt-1.5 shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}

      {activeDraft && (
        <DraftModal draft={activeDraft} onClose={() => setActiveDraft(null)} onSaved={setActiveDraft} onDeleted={() => setActiveDraft(null)} />
      )}
    </div>
  );
}
