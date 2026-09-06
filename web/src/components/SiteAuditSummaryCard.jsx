import { useState, useMemo } from 'react';
import { Loader2, AlertTriangle, XCircle, Radar, ShieldAlert, AlertCircle, Info, Filter, Search, CheckCircle2, ChevronRight, Gauge, Layers, Sparkles, FileText, ArrowUpRight } from 'lucide-react';
import { timeAgo, pagePathFor } from '../api.js';

// Category metadata with icons, labels, and color themes
const CATEGORY_META = {
  seo: { label: 'Technical SEO', icon: Gauge, bg: 'bg-indigo-50 border-indigo-100 text-indigo-700', activeBg: 'bg-indigo-600 text-white' },
  accessibility: { label: 'Accessibility', icon: Layers, bg: 'bg-emerald-50 border-emerald-100 text-emerald-700', activeBg: 'bg-emerald-600 text-white' },
  security: { label: 'Security', icon: ShieldAlert, bg: 'bg-rose-50 border-rose-100 text-rose-700', activeBg: 'bg-rose-600 text-white' },
  content: { label: 'Content Quality', icon: FileText, bg: 'bg-purple-50 border-purple-100 text-purple-700', activeBg: 'bg-purple-600 text-white' },
  geo: { label: 'AI Visibility', icon: Sparkles, bg: 'bg-amber-50 border-amber-100 text-amber-700', activeBg: 'bg-amber-600 text-white' },
  meta: { label: 'Overview', icon: Info, bg: 'bg-slate-50 border-slate-100 text-slate-700', activeBg: 'bg-slate-700 text-white' },
};

const PRIORITY_BADGE = {
  high: {
    label: 'HIGH',
    badge: 'bg-rose-500/10 text-rose-600 border border-rose-500/20 font-black',
    pill: 'bg-rose-500 text-white shadow-sm shadow-rose-500/20',
    icon: AlertTriangle,
    dot: 'bg-rose-500',
  },
  medium: {
    label: 'MED',
    badge: 'bg-amber-500/10 text-amber-600 border border-amber-500/20 font-extrabold',
    pill: 'bg-amber-500 text-white shadow-sm shadow-amber-500/20',
    icon: AlertCircle,
    dot: 'bg-amber-500',
  },
  low: {
    label: 'LOW',
    badge: 'bg-slate-100 text-slate-600 border border-slate-200/80 font-bold',
    pill: 'bg-slate-400 text-white',
    icon: Info,
    dot: 'bg-slate-400',
  },
};

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function HealthScoreGauge({ score }) {
  if (score == null) return null;
  const isGood = score >= 80;
  const isWarning = score >= 50 && score < 80;

  const strokeColor = isGood ? '#10b981' : isWarning ? '#f59e0b' : '#ef4444';
  const bgGradient = isGood
    ? 'from-emerald-500/10 via-emerald-500/5 to-transparent border-emerald-500/20 text-emerald-700'
    : isWarning
    ? 'from-amber-500/10 via-amber-500/5 to-transparent border-amber-500/20 text-amber-700'
    : 'from-rose-500/10 via-rose-500/5 to-transparent border-rose-500/20 text-rose-700';

  const circumference = 2 * Math.PI * 34;
  const strokeDashoffset = circumference - (score / 100) * circumference;

  return (
    <div className={`relative flex items-center gap-4 p-4 rounded-2xl border bg-gradient-to-r ${bgGradient} transition-all duration-300`}>
      <div className="relative w-20 h-20 shrink-0 grid place-items-center">
        <svg className="w-20 h-20 -rotate-90 transform" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="34" stroke="currentColor" strokeWidth="7" className="text-slate-200/60 opacity-40" fill="transparent" />
          <circle
            cx="40"
            cy="40"
            r="34"
            stroke={strokeColor}
            strokeWidth="7"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="transparent"
            className="transition-all duration-1000 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xl font-black tracking-tight text-slate-900 leading-none">{score}</span>
          <span className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400 mt-0.5">/ 100</span>
        </div>
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isGood ? 'bg-emerald-500 animate-pulse' : isWarning ? 'bg-amber-500 animate-pulse' : 'bg-rose-500 animate-pulse'}`} />
          <p className="text-xs font-black uppercase tracking-wider text-slate-800">
            {isGood ? 'Optimal Site Health' : isWarning ? 'Moderate Site Health' : 'Critical Fixes Required'}
          </p>
        </div>
        <p className="text-xs text-slate-500 mt-1 font-medium leading-relaxed">
          {isGood
            ? 'Your site structure and accessibility adhere well to SEO best practices.'
            : isWarning
            ? 'Several technical or accessibility issues require optimization.'
            : 'Immediate action recommended to resolve crawlability & UX issues.'}
        </p>
      </div>
    </div>
  );
}

function FindingItem({ finding }) {
  const pStyle = PRIORITY_BADGE[finding.priority] || PRIORITY_BADGE.low;
  const PriorityIcon = pStyle.icon;
  const pagePath = finding.page ? pagePathFor(finding.page) : null;

  return (
    <div className="p-4 rounded-xl border border-slate-100 bg-white/80 hover:bg-white hover:border-slate-300/80 hover:shadow-md transition-all duration-200 group">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] ${pStyle.badge}`}>
            <PriorityIcon size={12} className="shrink-0" />
            <span>{pStyle.label} PRIORITY</span>
          </span>
          {pagePath ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-slate-700 bg-slate-100/80 px-2 py-0.5 rounded-md border border-slate-200/50 max-w-xs truncate">
              {pagePath}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100 uppercase tracking-wider">
              Site-wide Issue
            </span>
          )}
        </div>
        {finding.page && (
          <a
            href={finding.page}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] font-semibold text-slate-400 group-hover:text-indigo-600 inline-flex items-center gap-0.5 transition shrink-0"
          >
            Visit URL <ArrowUpRight size={11} />
          </a>
        )}
      </div>
      <p className="text-xs text-slate-600 font-medium leading-relaxed">{finding.whyItMatters}</p>
    </div>
  );
}

export default function SiteAuditSummaryCard({ siteAudit, loading }) {
  const [activeCategory, setActiveCategory] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all'); // 'all' | 'high' | 'medium' | 'low'
  const [searchQuery, setSearchQuery] = useState('');

  if (loading) {
    return (
      <div className="card p-8 text-center space-y-3">
        <div className="w-10 h-10 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin mx-auto" />
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Analyzing site audit baseline…</p>
      </div>
    );
  }

  const run = siteAudit?.run;

  if (!run) {
    return (
      <div className="card p-10 text-center space-y-3 border-2 border-dashed border-slate-200 bg-slate-50/50">
        <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 grid place-items-center mx-auto shadow-inner">
          <Radar size={24} />
        </div>
        <h3 className="text-base font-bold text-slate-800">First Site Audit Pending</h3>
        <p className="text-xs text-slate-500 max-w-sm mx-auto leading-relaxed">
          Your initial baseline audit will begin automatically as soon as account setup finishes.
        </p>
      </div>
    );
  }

  if (run.status === 'failed') {
    return (
      <div className="card p-6 flex items-start gap-4 border border-rose-200 bg-rose-500/5">
        <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 grid place-items-center shrink-0">
          <XCircle size={20} />
        </div>
        <div>
          <h4 className="text-sm font-bold text-rose-800">Site Audit Interrupted</h4>
          <p className="text-xs text-rose-600/90 mt-1 leading-relaxed">
            {run.errorMessage || 'An error occurred during site crawling. Please retry or contact support.'}
          </p>
        </div>
      </div>
    );
  }

  const categories = Object.entries(siteAudit.findingsByCategory || {});
  const allFindings = useMemo(() => {
    const list = [];
    categories.forEach(([cat, items]) => {
      items.forEach((item) => list.push({ ...item, category: cat }));
    });
    return list;
  }, [siteAudit]);

  const priorityCounts = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0 };
    allFindings.forEach((f) => {
      if (counts[f.priority] != null) counts[f.priority]++;
    });
    return counts;
  }, [allFindings]);

  const filteredFindings = useMemo(() => {
    return allFindings.filter((f) => {
      if (activeCategory !== 'all' && f.category !== activeCategory) return false;
      if (priorityFilter !== 'all' && f.priority !== priorityFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const pageMatch = f.page ? f.page.toLowerCase().includes(q) : false;
        const textMatch = f.whyItMatters ? f.whyItMatters.toLowerCase().includes(q) : false;
        if (!pageMatch && !textMatch) return false;
      }
      return true;
    }).sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));
  }, [allFindings, activeCategory, priorityFilter, searchQuery]);

  return (
    <div className="space-y-4 fade-up">
      {/* Top Banner Card: Health Score + High-level Stats */}
      <div className="card p-6 bg-gradient-to-br from-white/90 via-slate-50/70 to-indigo-50/20 border border-slate-200/80 shadow-sm space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white grid place-items-center shadow-md shadow-indigo-500/20 shrink-0">
              <Radar size={20} className={run.status === 'running' ? 'animate-spin' : ''} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-slate-900 tracking-tight">
                  {run.status === 'running' ? 'Running Automated Audit…' : 'Full Site Baseline Audit'}
                </h3>
                {run.status === 'running' && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full animate-pulse">
                    <Loader2 size={10} className="animate-spin" /> In Progress
                  </span>
                )}
              </div>
              <p className="text-xs font-medium text-slate-400 mt-0.5">
                {run.pagesAudited} of {run.pagesDiscovered || '?'} pages analyzed
                {run.status !== 'running' && run.finishedAt && ` · ${timeAgo(run.finishedAt)}`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="px-3 py-2 rounded-xl bg-white border border-slate-200/70 text-center shadow-2xs">
              <span className="block text-[9px] font-black uppercase tracking-widest text-slate-400">Total Issues</span>
              <span className="text-sm font-black text-slate-800">{allFindings.length}</span>
            </div>
            <div className="px-3 py-2 rounded-xl bg-rose-50 border border-rose-200/60 text-center shadow-2xs">
              <span className="block text-[9px] font-black uppercase tracking-widest text-rose-500">Critical High</span>
              <span className="text-sm font-black text-rose-600">{priorityCounts.high}</span>
            </div>
            <div className="px-3 py-2 rounded-xl bg-amber-50 border border-amber-200/60 text-center shadow-2xs">
              <span className="block text-[9px] font-black uppercase tracking-widest text-amber-600">Medium</span>
              <span className="text-sm font-black text-amber-700">{priorityCounts.medium}</span>
            </div>
          </div>
        </div>

        {/* Health Gauge Component */}
        <HealthScoreGauge score={run.healthScore} />
      </div>

      {/* Category Tabs & Filter Toolbar */}
      <div className="card p-4 bg-white/80 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Category Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 max-w-full">
            <button
              onClick={() => setActiveCategory('all')}
              className={`px-3 py-1.5 rounded-xl text-xs font-extrabold transition shrink-0 flex items-center gap-1.5 ${
                activeCategory === 'all'
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-200/60'
              }`}
            >
              <span>All Findings</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${activeCategory === 'all' ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700'}`}>
                {allFindings.length}
              </span>
            </button>

            {categories.map(([cat, list]) => {
              const meta = CATEGORY_META[cat] || CATEGORY_META.meta;
              const Icon = meta.icon;
              const isActive = activeCategory === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-extrabold transition shrink-0 flex items-center gap-1.5 border ${
                    isActive ? `${meta.activeBg} border-transparent shadow-sm` : 'bg-white border-slate-200/80 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <Icon size={13} />
                  <span>{meta.label}</span>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${isActive ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-600'}`}>
                    {list.length}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Priority & Search Filters */}
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-48">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search issues…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full text-xs pl-8 pr-3 py-1.5 rounded-xl border border-slate-200/80 bg-white focus:outline-none focus:border-indigo-500 font-medium"
              />
            </div>
            <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl shrink-0">
              {['all', 'high', 'medium', 'low'].map((p) => (
                <button
                  key={p}
                  onClick={() => setPriorityFilter(p)}
                  className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-lg transition ${
                    priorityFilter === p ? 'bg-white text-indigo-600 shadow-2xs font-extrabold' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Findings Grid / List */}
        {filteredFindings.length === 0 ? (
          <div className="p-8 text-center space-y-2 bg-slate-50/50 rounded-xl border border-slate-100">
            {allFindings.length === 0 ? (
              <div className="flex items-center justify-center gap-2 text-emerald-700 font-bold text-xs">
                <CheckCircle2 size={16} className="text-emerald-500" />
                No issues detected — your site structure is in excellent condition!
              </div>
            ) : (
              <p className="text-xs font-semibold text-slate-400">No issues match the selected category or search query.</p>
            )}
          </div>
        ) : (
          <div className="max-h-[34rem] overflow-y-auto space-y-2.5 pr-1 custom-scrollbar">
            {filteredFindings.map((finding) => (
              <FindingItem key={finding.id} finding={finding} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

