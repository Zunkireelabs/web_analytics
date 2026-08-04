import { useState } from 'react';
import {
  FileSearch, ListChecks, Activity, Bot, CheckCircle2, Ban,
  BarChart2, FileText, Sparkles, Download, Target, X, Loader2, TrendingUp, DollarSign, Workflow,
} from 'lucide-react';
import { api } from '../api.js';
import { diagnosisText, evidenceBullets, formatByUnit } from '../lib/analystFormat.js';
import DraftModal from './DraftModal.jsx';
import AnalystReasoningPanel from './AnalystReasoningPanel.jsx';
import AnalystActionPipeline from './AnalystActionPipeline.jsx';
import AnalystRoiEstimate from './AnalystRoiEstimate.jsx';
import AnalystOpportunityBadge from './AnalystOpportunityBadge.jsx';

// Mirrors data-analyst-agent/app/scoring/impact_projection.py's own
// LOWER_IS_BETTER handling — the one metric family where "value went down"
// means the outcome IMPROVED, not declined.
const LOWER_IS_BETTER_METRICS = new Set(['gsc_position']);

// Best-effort delta extraction per insight_type's own evidence shape,
// mirroring the backend's _impact_inputs_from_insight — returns null
// (button disabled) rather than guessing when evidence has no clear
// before/after pair. Anomalies never have one (a single-day flag).
function impactInputsFromInsight(insight) {
  const e = insight.evidence || {};
  if (insight.insight_type === 'trend_shift') {
    const { current_value: current, prior_value: prior } = e;
    if (current == null || prior == null) return null;
    const worsened = LOWER_IS_BETTER_METRICS.has(insight.metric_key) ? current - prior > 0 : current - prior < 0;
    return { deltaValue: current - prior, deltaDirection: worsened ? 'decline' : 'increase', currentValue: current, priorValue: prior };
  }
  if (insight.insight_type === 'forecast_risk') {
    const { last_actual: lastActual, projected_last_point: projected } = e;
    if (lastActual == null || projected == null) return null;
    return { deltaValue: projected - lastActual, deltaDirection: 'decline', currentValue: projected, priorValue: lastActual };
  }
  if (insight.insight_type === 'milestone') {
    const { current_value: current, prior_value: prior, direction } = e;
    if (current == null || prior == null) return null;
    return { deltaValue: current - prior, deltaDirection: direction === 'down' ? 'decline' : 'increase', currentValue: current, priorValue: prior };
  }
  return null;
}

// Mirrors server/agents/lib/analyst-seo-mapping.js's eligibility check —
// purely for the button's enabled/disabled state. The server re-validates
// independently and is the actual authority; this never needs to be exact,
// only close enough that the button isn't misleadingly enabled.
function isSeoDraftEligible(insight) {
  if (!insight.metric_key?.startsWith('gsc_')) return false;
  if (insight.dimension_type !== 'page' || !insight.dimension_value) return false;
  const e = insight.evidence || {};
  switch (insight.insight_type) {
    case 'trend_shift': return typeof e.pct_change === 'number' && e.pct_change < 0;
    case 'anomaly': return e.direction === 'low';
    case 'forecast_risk': return true;
    case 'milestone': return e.direction === 'down';
    default: return false;
  }
}

// Distinguishes "hasn't been attempted" from "the LLM tailoring pass tried
// and failed" (data-analyst-agent's Recommendation.narration_status) —
// honest about which state a null root_cause is in, instead of one generic
// "runs nightly" message regardless of cause.
function rootCauseFallback(insight) {
  if (insight.narration_status === 'failed') {
    return 'Root-cause tailoring failed on the last attempt — it will retry on the next nightly run.';
  }
  return 'Root-cause analysis runs nightly — check back after the next run.';
}

// Derived entirely from real fields already on the insight — never a
// fabricated confidence/status value. "Repair Plan Generated" vs "Waiting
// for Approval" is a genuine distinction: root_cause_text can lag behind
// recommendation_text since only the former depends on the nightly LLM
// enrichment pass succeeding (see data-analyst-agent's recommendations.py).
function agentStatus(insight, { resolving, dismissing }) {
  if (resolving || dismissing) return { label: 'Executing…', color: '#6C63FF', pulse: true };
  if (!insight.recommendation_id) return { label: 'Investigating', color: '#f59e0b', pulse: true };
  if (!insight.root_cause) return { label: 'Repair Plan Generated', color: '#0ea5e9', pulse: false };
  return { label: 'Waiting for Approval', color: '#10b981', pulse: false };
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const ACTION_BUTTON_BASE =
  'inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider px-3 min-h-[38px] rounded-xl transition ' +
  'hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 cursor-pointer focus:outline-none';

function ActionButton({ icon: Icon, label, onClick, disabled, title, tone = 'default', loading }) {
  const toneClass = tone === 'primary'
    ? 'text-slate-900 shadow-sm'
    : 'bg-transparent border border-slate-200 text-slate-700 hover:border-slate-500 hover:text-slate-900';
  const style = tone === 'primary' ? { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' } : undefined;
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className={`${ACTION_BUTTON_BASE} ${toneClass}`} style={style}>
      {loading ? <Loader2 size={11} className="animate-spin" /> : <Icon size={11} />}
      {label}
    </button>
  );
}

function Section({ icon: Icon, iconColor, title, children }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-100/70 p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} style={{ color: iconColor }} />
        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">{title}</span>
      </div>
      {children}
    </div>
  );
}

export default function AnalystFindingPipeline({
  insight, metric, clientId, onResolve, resolving, onDismiss, dismissing, onAnalyzeFurther,
}) {
  const [summary, setSummary] = useState(null); // null | {loading} | {text} | {error}
  const [reportState, setReportState] = useState(null); // null | 'loading' | {error}
  const [draftState, setDraftState] = useState(null); // null | 'loading' | {error}
  const [seoDraft, setSeoDraft] = useState(null); // generated draft object → opens DraftModal
  const [impactState, setImpactState] = useState(null); // null | 'loading' | {result} | {error}

  const hasRecommendation = Boolean(insight.recommendation_id);
  const status = agentStatus(insight, { resolving, dismissing });
  const bullets = evidenceBullets(insight, metric);
  const seoEligible = isSeoDraftEligible(insight);
  const impactInputs = impactInputsFromInsight(insight);
  const forecast = metric?.forecast;

  const estimateImpact = async () => {
    if (!impactInputs) return;
    setImpactState('loading');
    try {
      const result = await api.analyst.impactProjection(clientId, {
        metricKey: insight.metric_key, dimensionType: insight.dimension_type, dimensionValue: insight.dimension_value,
        deltaValue: impactInputs.deltaValue, deltaDirection: impactInputs.deltaDirection,
        currentValue: impactInputs.currentValue, priorValue: impactInputs.priorValue,
      });
      setImpactState({ result });
    } catch (e) {
      setImpactState({ error: e.message || 'Impact projection failed.' });
    }
  };

  const openSummary = async () => {
    setSummary({ loading: true });
    try {
      const { summary: text } = await api.analyst.recommendationSummary(clientId, insight.recommendation_id);
      setSummary({ text });
    } catch (e) {
      setSummary({ error: e.message || 'Summary generation failed.' });
    }
  };

  const generateReport = async () => {
    setReportState('loading');
    try {
      const title = `${metric.display_name} — Investigation Report (${insight.period_start})`;
      const sections = [
        { label: 'Computed Summary', body: diagnosisText(insight, metric) },
        { label: 'Root Cause', body: insight.root_cause || rootCauseFallback(insight) },
        { label: 'Evidence', body: bullets.length ? bullets.map((b) => `• ${b}`).join('\n') : 'No structured evidence available.' },
        { label: 'Repair Strategy', body: insight.recommendation || 'No recommendation generated yet.' },
      ];
      const { url } = await api.analyst.investigationReport(clientId, title, sections);
      window.open(url, '_blank', 'noopener');
      setReportState(null);
    } catch (e) {
      setReportState({ error: e.message || 'Report generation failed.' });
    }
  };

  const exportEvidence = () => {
    downloadJson(`finding-${insight.metric_key}-${insight.period_start}.json`, {
      metric: metric.display_name, metric_key: insight.metric_key, unit: metric.unit,
      insight_type: insight.insight_type, severity: insight.severity, period_start: insight.period_start,
      dimension_type: insight.dimension_type, dimension_value: insight.dimension_value,
      evidence: insight.evidence, root_cause: insight.root_cause, recommendation: insight.recommendation,
    });
  };

  const generateSeoDraft = async () => {
    setDraftState('loading');
    try {
      const draft = await api.analyst.generateSeoDraft(clientId, insight);
      setSeoDraft(draft);
      setDraftState(null);
    } catch (e) {
      setDraftState({ error: e.message || 'Draft generation failed.' });
    }
  };

  return (
    <div className="flex flex-col gap-2.5 pt-2.5 border-t border-slate-100/50 mt-2 animate-slide-down" onClick={(evt) => evt.stopPropagation()}>

      <div className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider px-2.5 py-1.5 rounded-xl border w-fit"
        style={{ color: status.color, backgroundColor: `${status.color}0c`, borderColor: `${status.color}1e` }}>
        <Bot size={11} className={status.pulse ? 'animate-pulse' : ''} />
        <span>Data Analytics Agent</span>
        <span className="text-slate-700">·</span>
        <span>{status.label}</span>
      </div>

      <Section icon={insight.root_cause ? Sparkles : FileSearch} iconColor="#0ea5e9" title={insight.root_cause ? 'AI Root Cause' : 'Root Cause Analysis'}>
        <p className="text-[10px] font-bold text-slate-800 leading-relaxed">
          {insight.root_cause || rootCauseFallback(insight)}
        </p>
        {bullets.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {bullets.map((b, i) => (
              <li key={i} className="text-[9.5px] font-semibold text-slate-400 flex items-start gap-1.5">
                <span className="w-1 h-1 rounded-full bg-slate-500 mt-1.5 shrink-0" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={ListChecks} iconColor="#10b981" title="Repair Strategy">
        <p className="text-[10px] font-semibold text-slate-700 leading-relaxed flex items-start gap-1.5">
          <CheckCircle2 size={11} className="text-emerald-600 mt-0.5 shrink-0" />
          <span>{insight.recommendation || 'No recommendation generated yet.'}</span>
        </p>
      </Section>

      <Section icon={TrendingUp} iconColor="#8b5cf6" title="Forecast">
        {forecast?.status === 'ok' ? (
          <p className="text-[10px] font-semibold text-slate-700 leading-relaxed">
            {forecast.model} model projects {formatByUnit(forecast.points?.[forecast.points.length - 1]?.point_estimate, metric.unit)}
            {' '}by {forecast.points?.[forecast.points.length - 1]?.target_date}
            {forecast.confidence != null && ` · ${Math.round(forecast.confidence * 100)}% confidence`}.
          </p>
        ) : (
          <p className="text-[10px] font-semibold text-slate-400">No forecast available for this metric yet.</p>
        )}
      </Section>

      <Section icon={DollarSign} iconColor="#f59e0b" title="Projected Impact">
        {impactState?.result || impactState?.error ? (
          <AnalystRoiEstimate result={impactState?.result} error={impactState?.error} />
        ) : (
          <ActionButton icon={DollarSign} label={impactState === 'loading' ? 'Estimating…' : 'Estimate Business Impact'}
            onClick={estimateImpact} disabled={!impactInputs || impactState === 'loading'} loading={impactState === 'loading'}
            title={!impactInputs ? 'Not enough evidence on this finding to project impact' : undefined} />
        )}
      </Section>

      <Section icon={Target} iconColor="#0ea5e9" title="Opportunity Score">
        <AnalystOpportunityBadge clientId={clientId} recommendationId={insight.recommendation_id} />
      </Section>

      <Section icon={Activity} iconColor="#6C63FF" title="Execution Actions">
        <div className="flex flex-wrap gap-1.5">
          <ActionButton icon={BarChart2} label="Analyze Further" onClick={onAnalyzeFurther} />
          <ActionButton icon={FileText} label={reportState === 'loading' ? 'Generating…' : 'Investigation Report'}
            onClick={generateReport} disabled={reportState === 'loading'} loading={reportState === 'loading'} />
          <ActionButton icon={Download} label="Export Evidence" onClick={exportEvidence} />
          <ActionButton icon={Sparkles} label="Executive Summary" onClick={openSummary}
            disabled={!hasRecommendation} title={!hasRecommendation ? 'No recommendation to summarize yet' : undefined} />
          <ActionButton icon={Target} label={draftState === 'loading' ? 'Generating…' : 'Generate Content Draft'}
            onClick={generateSeoDraft} disabled={!seoEligible || draftState === 'loading'} loading={draftState === 'loading'}
            title={!seoEligible ? 'Not available for this finding' : undefined} />
          <ActionButton icon={Ban} label={dismissing ? 'Dismissing…' : 'Dismiss'} onClick={() => onDismiss(insight)}
            disabled={!hasRecommendation || dismissing} loading={dismissing}
            title={!hasRecommendation ? 'No recommendation to dismiss yet' : undefined} />
          <ActionButton icon={CheckCircle2} label={resolving ? 'Marking…' : 'Mark Solved'} onClick={() => onResolve(insight)}
            disabled={!hasRecommendation || resolving} loading={resolving} tone="primary"
            title={!hasRecommendation ? 'No recommendation to resolve yet' : undefined} />
        </div>
        {reportState?.error && <p className="text-[9px] font-bold text-rose-600 mt-1.5">{reportState.error}</p>}
        {draftState?.error && <p className="text-[9px] font-bold text-rose-600 mt-1.5">{draftState.error}</p>}
      </Section>

      <Section icon={Workflow} iconColor="#6C63FF" title="AI Action Pipeline">
        <AnalystActionPipeline
          clientId={clientId} insight={insight} seoEligible={seoEligible}
          impactResult={impactState?.result} draftStatus={seoDraft?.status}
        />
      </Section>

      <AnalystReasoningPanel clientId={clientId} insight={insight} metric={metric} />

      {summary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white backdrop-blur-sm p-4" onClick={() => setSummary(null)}>
          <div className="bg-[#ffffff] border border-slate-200 rounded-2xl shadow-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-black text-slate-900 flex items-center gap-1.5">
                <Sparkles size={13} className="text-indigo-600" /> Executive Summary
              </h4>
              <button type="button" onClick={() => setSummary(null)} className="text-slate-500 hover:text-slate-900 cursor-pointer">
                <X size={16} />
              </button>
            </div>
            {summary.loading && <p className="text-xs text-slate-500 animate-pulse">Generating summary…</p>}
            {summary.error && <p className="text-xs text-rose-600 font-semibold">{summary.error}</p>}
            {summary.text && (
              <>
                <p className="text-xs text-slate-800 leading-relaxed">{summary.text}</p>
                <button type="button" onClick={() => navigator.clipboard.writeText(summary.text)}
                  className="mt-3 text-[10px] font-black uppercase tracking-wider text-indigo-600 hover:underline cursor-pointer">
                  Copy to clipboard
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {seoDraft && (
        <DraftModal draft={seoDraft} onClose={() => setSeoDraft(null)}
          onSaved={(updated) => setSeoDraft(updated)} onDeleted={() => setSeoDraft(null)} />
      )}
    </div>
  );
}
