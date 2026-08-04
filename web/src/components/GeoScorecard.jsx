import { useEffect, useState, useCallback, useMemo } from 'react';
import { api, timeAgo } from '../api.js';
import {
  Globe2,
  History,
  TrendingUp,
  TrendingDown,
  HelpCircle,
  Code2,
  Boxes,
  MapPin,
  Bot,
  FileText,
  LayoutList,
  Layers,
  ArrowRight,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

const CATEGORY_META = {
  faq: { label: 'FAQ & Direct Answer', icon: HelpCircle, color: '#8b5cf6', desc: 'Question-style headings & answer extraction readiness' },
  schema: { label: 'Schema.org Markup', icon: Code2, color: '#3b82f6', desc: 'Structured data types (Article, Product, Organization)' },
  entities: { label: 'Entity Mapping', icon: Boxes, color: '#10b981', desc: 'Entity clarity for AI engine knowledge graph indexing' },
  geoSignals: { label: 'Geo & Local Signals', icon: MapPin, color: '#f59e0b', desc: 'Location, NAP & regional search engine optimization' },
  llmsReadiness: { label: 'LLM Engine Readability', icon: Bot, color: '#ec4899', desc: 'Content parseability for Perplexity, ChatGPT & Gemini' },
  citationReadiness: { label: 'Citation & Attribution', icon: FileText, color: '#06b6d4', desc: 'Author, byline, publish date & source citation signals' },
  structuredContent: { label: 'Structured Content', icon: LayoutList, color: '#6366f1', desc: 'H1/H2 hierarchy, lists, and table data formatting' },
};

function getScoreTone(score) {
  if (score >= 70) return { label: 'Optimal AI Visibility', color: 'text-emerald-500', bg: 'bg-emerald-50 border-emerald-200', stroke: '#10b981' };
  if (score >= 40) return { label: 'Needs GEO Optimization', color: 'text-amber-500', bg: 'bg-amber-50 border-amber-200', stroke: '#f59e0b' };
  return { label: 'Critical Visibility Risk', color: 'text-rose-500', bg: 'bg-rose-50 border-rose-200', stroke: '#f43f5e' };
}

function ScoreGauge({ score = 0 }) {
  const numScore = typeof score === 'number' ? score : 0;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (numScore / 100) * circumference;
  const tone = getScoreTone(numScore);

  return (
    <div className="relative w-36 h-36 flex items-center justify-center shrink-0">
      <svg className="w-full h-full transform -rotate-90" viewBox="0 0 120 120">
        <circle
          cx="60"
          cy="60"
          r={radius}
          className="stroke-slate-200/60 dark:stroke-slate-800"
          strokeWidth="10"
          fill="transparent"
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          stroke={tone.stroke}
          strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          fill="transparent"
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <div className="absolute flex flex-col items-center justify-center text-center">
        <span className="text-3xl font-black text-slate-900 dark:text-white tracking-tight tabular-nums">
          {numScore}
        </span>
        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">out of 100</span>
      </div>
    </div>
  );
}

function ScoreTrendCard({ trendScores = [] }) {
  if (trendScores.length < 2) return null;
  const latest = trendScores[trendScores.length - 1];
  const previous = trendScores[trendScores.length - 2];
  const diff = latest - previous;
  const isUp = diff >= 0;

  const min = Math.min(...trendScores);
  const max = Math.max(...trendScores);
  const range = max - min || 1;

  const height = 120;
  const width = 600;
  const pad = 20;

  const points = trendScores.map((val, idx) => {
    const x = pad + (idx / (trendScores.length - 1)) * (width - pad * 2);
    const y = height - pad - ((val - min) / range) * (height - pad * 2);
    return { x, y, val };
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaD = `${pathD} L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;

  return (
    <div className="card p-6 border border-slate-200/80 shadow-xs relative overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center">
            <TrendingUp size={15} />
          </div>
          <div>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">AI Visibility Trend</h3>
            <p className="text-[10px] font-medium text-slate-400">Historical performance across {trendScores.length} GEO audits</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={`text-xs font-black px-2.5 py-1 rounded-xl flex items-center gap-1 border ${isUp ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
            {isUp ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
            {isUp ? `+${diff}` : diff} pts vs previous
          </span>
        </div>
      </div>

      <div className="h-32 w-full relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible" preserveAspectRatio="none">
          <defs>
            <linearGradient id="geoTrendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaD} fill="url(#geoTrendGrad)" />
          <path d={pathD} fill="none" stroke="#0ea5e9" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          {points.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r="4" fill="#ffffff" stroke="#0ea5e9" strokeWidth="2.5" />
              <text x={p.x} y={p.y - 10} textAnchor="middle" className="text-[10px] font-bold fill-slate-600">
                {p.val}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

function CategoryCard({ catKey, score }) {
  const meta = CATEGORY_META[catKey] || { label: catKey, icon: Layers, color: '#64748b', desc: '' };
  const Icon = meta.icon;
  const numScore = typeof score === 'number' ? score : 0;

  return (
    <div className="w-full p-4 rounded-2xl border border-slate-200/80 bg-white flex flex-col justify-between gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-xl grid place-items-center shrink-0 border"
            style={{ backgroundColor: `${meta.color}14`, borderColor: `${meta.color}30`, color: meta.color }}
          >
            <Icon size={16} />
          </div>
          <div>
            <h4 className="text-xs font-bold truncate">{meta.label}</h4>
            <p className="text-[10px] line-clamp-1 text-slate-400">{meta.desc}</p>
          </div>
        </div>
        <span className="text-sm font-black tabular-nums">{numScore}/100</span>
      </div>

      <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${numScore}%`, backgroundColor: meta.color }} />
      </div>
    </div>
  );
}

function AuditHistoryRow({ audit, onOpen }) {
  const score = audit.content?.score?.overall;
  const pages = audit.content?.pagesAnalyzed ?? 0;
  const tone = typeof score === 'number' ? getScoreTone(score) : null;

  return (
    <div
      onClick={() => onOpen(audit)}
      className="flex items-center justify-between gap-4 p-4 rounded-2xl border border-slate-200/80 bg-white hover:bg-slate-50/80 hover:border-indigo-300 transition cursor-pointer group shadow-2xs"
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 grid place-items-center shrink-0">
          <Globe2 size={16} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-black tabular-nums ${tone ? tone.color : 'text-slate-400'}`}>
              {score != null ? `${score}/100 Score` : 'No score'}
            </span>
            <span className="text-[10px] font-semibold text-slate-400">• {timeAgo(audit.created_at)}</span>
          </div>
          <p className="text-[11px] font-medium text-slate-500">
            {pages} page{pages === 1 ? '' : 's'} analyzed · GEO Audit Snapshot
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs font-bold text-indigo-600 group-hover:text-indigo-700 transition">
        <span>View Details</span>
        <ArrowRight size={14} className="group-hover:translate-x-0.5 transition-transform" />
      </div>
    </div>
  );
}

// Diagnostic-only GEO scorecard: overall AI visibility score, per-category
// readiness, and score history. Fixes for GEO findings live in the Action
// Center (they share the same geo-audit generator), so this component
// deliberately has no recommendations list and no "Fix with AI" buttons.
export default function GeoScorecard({ onOpenReport }) {
  const [audits, setAudits] = useState(null); // null = loading
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadAudits = useCallback(
    () => api.actionCenter.drafts({ actionType: 'geo-audit' }).then(setAudits).catch(() => setAudits([])),
    []
  );

  useEffect(() => { loadAudits(); }, [loadAudits]);

  const loading = audits === null;
  const latest = audits?.[0] || null;
  const overallScore = latest?.content?.score?.overall ?? null;
  const pagesAnalyzed = latest?.content?.pagesAnalyzed ?? 0;
  const categories = latest?.content?.score?.categories || null;

  const trendScores = useMemo(() => {
    return (audits || [])
      .slice()
      .reverse()
      .map((a) => a.content?.score?.overall)
      .filter((v) => typeof v === 'number');
  }, [audits]);

  return (
    <div className="space-y-4">
      {/* Hero Overall AI Visibility Card */}
      <div
        className="rounded-3xl p-7 text-white relative overflow-hidden shadow-2xl border border-indigo-500/20"
        style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#312e81 100%)' }}
      >
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full opacity-20 blur-3xl pointer-events-none" style={{ background: '#8b5cf6' }} />

        <div className="relative flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex flex-col sm:flex-row items-center gap-6">
            {loading ? (
              <div className="w-36 h-36 rounded-full bg-white/10 animate-pulse" />
            ) : (
              <ScoreGauge score={overallScore} />
            )}

            <div className="space-y-2 text-center sm:text-left">
              <div className="flex items-center justify-center sm:justify-start gap-2">
                <span className="text-xs font-black uppercase tracking-widest text-violet-300">
                  Overall AI Visibility Score
                </span>
                <span className="text-[9px] font-mono font-bold bg-violet-500/20 border border-violet-400/30 text-violet-200 px-2 py-0.5 rounded-md">
                  GEO Engine v2
                </span>
              </div>

              <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
                {typeof overallScore === 'number' ? getScoreTone(overallScore).label : 'No audit run yet'}
              </h2>

              <p className="text-xs text-slate-300 max-w-lg leading-relaxed">
                Evaluates how effectively generative AI search engines (Perplexity, ChatGPT Search, Gemini & Google AI Overviews) discover and cite your content.
              </p>

              <div className="flex items-center justify-center sm:justify-start gap-3 pt-2 flex-wrap text-xs">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 border border-white/15">
                  <span className="text-slate-300">Pages Analyzed:</span>
                  <span className="font-extrabold text-white">{loading ? '—' : pagesAnalyzed}</span>
                </div>

                {latest && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 border border-white/15">
                    <span className="text-slate-300">Last Audit:</span>
                    <span className="font-extrabold text-violet-200">{timeAgo(latest.created_at)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Category Readiness Breakdown */}
      {categories && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Object.entries(categories).map(([catKey, val]) => (
            <CategoryCard key={catKey} catKey={catKey} score={val} />
          ))}
        </div>
      )}

      {/* Trend + history, collapsible so the Action Center pipeline stays primary */}
      {(audits?.length || 0) >= 2 && (
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 rounded-2xl border border-slate-200/80 bg-white hover:bg-slate-50/60 transition cursor-pointer"
        >
          <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-slate-600">
            <History size={13} className="text-slate-400" />
            Score history & audit snapshots ({audits.length})
          </span>
          {historyOpen ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
        </button>
      )}

      {historyOpen && (
        <div className="space-y-3">
          <ScoreTrendCard trendScores={trendScores} />
          <div className="space-y-2">
            {audits.map((a) => (
              <AuditHistoryRow key={a.id} audit={a} onOpen={onOpenReport} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
