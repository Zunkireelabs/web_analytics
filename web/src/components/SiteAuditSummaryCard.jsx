import { useState, useMemo } from 'react';
import { Loader2, XCircle, Radar, ShieldAlert, Info, Search, Gauge, Layers, Sparkles, FileText } from 'lucide-react';
import { timeAgo, pagePathFor } from '../api.js';
import Badge from './Badge.jsx';
import SegmentedTabs from './SegmentedTabs.jsx';
import { CHART, STATUS } from '../lib/palette.js';

// Category metadata: label + icon (chips are neutral, no per-category colour).
const CATEGORY_META = {
  seo: { label: 'Technical SEO', icon: Gauge },
  accessibility: { label: 'Accessibility', icon: Layers },
  security: { label: 'Security', icon: ShieldAlert },
  content: { label: 'Content Quality', icon: FileText },
  geo: { label: 'AI Visibility', icon: Sparkles },
  meta: { label: 'Overview', icon: Info },
};

const PRIORITY_BADGE = {
  high: { label: 'High', tone: 'red' },
  medium: { label: 'Medium', tone: 'amber' },
  low: { label: 'Low', tone: 'grey' },
};

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

export default function SiteAuditSummaryCard({ siteAudit, loading }) {
  const [activeCategory, setActiveCategory] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all'); // 'all' | 'high' | 'medium' | 'low'
  const [searchQuery, setSearchQuery] = useState('');

  // Hooks must stay above the early returns below: when this goes from the
  // loading / no-run / failed states to the ready state (switching clients, or
  // an audit starting while the page polls), a changed hook count would crash
  // the page with "Rendered more hooks than during the previous render".
  const run = siteAudit?.run;
  const categories = Object.entries(siteAudit?.findingsByCategory || {});
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

  if (loading) {
    return (
      <div className="card px-4 py-8 text-center">
        <Loader2 size={20} className="animate-spin text-faint mx-auto" />
        <p className="text-sm text-text mt-2">Analyzing site audit baseline…</p>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="card px-4 py-10 text-center">
        <Radar size={20} className="text-faint mx-auto" />
        <h3 className="text-sm font-medium text-fg mt-2">First site audit pending</h3>
        <p className="text-[13px] text-text">
          Your initial baseline audit will begin automatically as soon as account setup finishes.
        </p>
      </div>
    );
  }

  if (run.status === 'failed') {
    return (
      <div className="card px-4 py-3 flex gap-3">
        <XCircle size={16} className="shrink-0 mt-0.5" style={{ color: STATUS.critical.text }} />
        <div>
          <h4 className="text-sm font-medium text-fg">Site audit interrupted</h4>
          <p className="text-[13px] text-text">
            {run.errorMessage || 'An error occurred during site crawling. Please retry or contact support.'}
          </p>
        </div>
      </div>
    );
  }

  const stat = 'px-4 first:pl-0 border-l border-border first:border-0';

  return (
    <div className="card overflow-hidden fade-up">
      {/* Row 1: title + high-level stats */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-fg">
              {run.status === 'running' ? 'Running automated audit…' : 'Full site baseline audit'}
            </h3>
            {run.status === 'running' && <Badge tone="amber" dot>In progress</Badge>}
          </div>
          <p className="text-[13px] text-faint">
            {run.pagesAudited} of {run.pagesDiscovered || '?'} pages analysed
            {run.status !== 'running' && run.finishedAt && ` · ${timeAgo(run.finishedAt)}`}
          </p>
        </div>

        <div className="flex items-center">
          <div className={stat}>
            <div className="text-xs text-faint">Issues</div>
            <div className="text-[15px] font-medium tnum text-fg">{allFindings.length}</div>
          </div>
          <div className={stat}>
            <div className="text-xs text-faint">High</div>
            <div className="text-[15px] font-medium tnum" style={{ color: priorityCounts.high > 0 ? STATUS.critical.text : undefined }}>{priorityCounts.high}</div>
          </div>
          <div className={stat}>
            <div className="text-xs text-faint">Medium</div>
            <div className="text-[15px] font-medium tnum" style={{ color: priorityCounts.medium > 0 ? STATUS.warning.text : undefined }}>{priorityCounts.medium}</div>
          </div>
        </div>
      </div>

      {/* Row 2: Health gauge */}
      <HealthScoreGauge score={run.healthScore} />

      {/* Row 3: category chips + search + priority filter */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar max-w-full">
          <button
            onClick={() => setActiveCategory('all')}
            className={`h-7 px-2.5 rounded-control text-[13px] font-medium inline-flex items-center gap-1.5 shrink-0 ${
              activeCategory === 'all' ? 'bg-white text-fg' : 'text-text hover:bg-muted'
            }`}
            style={activeCategory === 'all' ? { boxShadow: 'var(--ring)' } : undefined}
          >
            <span>All findings</span>
            <span className="text-faint font-normal">{allFindings.length}</span>
          </button>

          {categories.map(([cat, list]) => {
            const meta = CATEGORY_META[cat] || CATEGORY_META.meta;
            const Icon = meta.icon;
            const isActive = activeCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`h-7 px-2.5 rounded-control text-[13px] font-medium inline-flex items-center gap-1.5 shrink-0 ${
                  isActive ? 'bg-white text-fg' : 'text-text hover:bg-muted'
                }`}
                style={isActive ? { boxShadow: 'var(--ring)' } : undefined}
              >
                <Icon size={13} className="text-faint" />
                <span>{meta.label}</span>
                <span className="text-faint font-normal">{list.length}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-none">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              type="text"
              placeholder="Search issues…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-full sm:w-56 pl-8 pr-3 rounded-control bg-white text-[13px] text-fg outline-none"
              style={{ boxShadow: '0 0 0 1px var(--input)' }}
            />
          </div>
          <SegmentedTabs
            className="shrink-0 hidden sm:inline-flex"
            options={['all', 'high', 'medium', 'low'].map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))}
            value={priorityFilter}
            onChange={setPriorityFilter}
          />
        </div>
      </div>

      {/* Row 4: findings */}
      {filteredFindings.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-faint">
          {allFindings.length === 0
            ? 'No issues found in this audit.'
            : 'No issues match the selected category or search query.'}
        </div>
      ) : (
        <div className="max-h-[34rem] overflow-y-auto custom-scrollbar">
          {filteredFindings.map((finding) => (
            <FindingItem key={finding.id} finding={finding} />
          ))}
        </div>
      )}
    </div>
  );
}

function HealthScoreGauge({ score }) {
  if (score == null) return null;
  const isGood = score >= 80;
  const isWarning = score >= 50 && score < 80;

  const tone = isGood ? STATUS.good : isWarning ? STATUS.warning : STATUS.critical;

  const r = 20;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference - (score / 100) * circumference;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
      <div className="relative w-12 h-12 shrink-0 grid place-items-center">
        <svg className="w-12 h-12 -rotate-90" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r={r} stroke={CHART.track} strokeWidth="5" fill="transparent" />
          <circle
            cx="24"
            cy="24"
            r={r}
            stroke={tone.color}
            strokeWidth="5"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="transparent"
            className="transition-all duration-1000 ease-out"
          />
        </svg>
        <span className="absolute inset-0 grid place-items-center text-[13px] font-medium text-fg tnum">{score}</span>
      </div>
      <div>
        <p className="text-sm font-medium text-fg">
          {isGood ? 'Optimal site health' : isWarning ? 'Moderate site health' : 'Critical fixes required'}
        </p>
        <p className="text-[13px] text-text">
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
  const pagePath = finding.page ? pagePathFor(finding.page) : null;

  return (
    <div className="px-4 py-3 border-b border-border last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={pStyle.tone}>{pStyle.label}</Badge>
        {pagePath ? (
          <span className="font-mono text-[12px] text-text truncate max-w-xs">{pagePath}</span>
        ) : (
          <Badge tone="grey">Site-wide</Badge>
        )}
        {finding.page && (
          <a
            href={finding.page}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[13px] text-faint hover:text-fg shrink-0"
          >
            Visit ↗
          </a>
        )}
      </div>
      <p className="mt-1 text-[13px] text-text">{finding.whyItMatters}</p>
    </div>
  );
}
