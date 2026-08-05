import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, daysAgo, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import DraftModal from '../components/DraftModal.jsx';
import { PRIORITY } from '../components/WatchlistCard.jsx';
import { 
  Sparkles, 
  Bot, 
  Clock, 
  AlertTriangle, 
  Cpu, 
  TrendingUp, 
  CheckCircle2, 
  ChevronDown, 
  ChevronUp, 
  ArrowRight,
  Activity,
  History,
  FileText,
  Settings,
  Calendar,
  Layers,
  SlidersHorizontal,
  FolderSync,
  Zap,
  GitPullRequest,
  ShieldCheck,
  ShieldAlert,
  XCircle
} from 'lucide-react';

const GENERATOR_META = {
  'meta-title': { label: 'Meta Titles', icon: '🏷️', color: '#6C63FF' },
  faq: { label: 'FAQ Blocks', icon: '❓', color: '#0ea5e9' },
  schema: { label: 'Schema Markup', icon: '🧩', color: '#8b5cf6' },
  'internal-links': { label: 'Internal Links', icon: '🔗', color: '#14b8a6' },
  'blog-outline': { label: 'Blog Outlines', icon: '📝', color: '#ec4899' },
  'landing-page': { label: 'Landing Pages', icon: '🚀', color: '#c2410c' },
  translation: { label: 'Translations', icon: '🌐', color: '#06b6d4' },
  'llms-txt': { label: 'llms.txt Files', icon: '🤖', color: '#10b981' },
  'security-headers': { label: 'Security Headers', icon: '🛡️', color: '#ef4444' },
  'html-lang': { label: 'Page Language', icon: '🌍', color: '#0891b2' },
  viewport: { label: 'Viewport Meta Tag', icon: '📱', color: '#0d9488' },
  canonical: { label: 'Canonical Tags', icon: '🔗', color: '#7c3aed' },
  'robots-fix': { label: 'Robots.txt Fixes', icon: '🤖', color: '#059669' },
  'open-graph': { label: 'Open Graph Tags', icon: '📣', color: '#db2777' },
  'broken-link-fix': { label: 'Broken Link Removal', icon: '⛔', color: '#dc2626' },
  'redirect-fix': { label: 'Redirect Fixes', icon: '↪️', color: '#d97706' },
  'expand-content': { label: 'Content Expansion', icon: '📄', color: '#4f46e5' },
  sitemap: { label: 'Sitemap Updates', icon: '🗺️', color: '#65a30d' },

  'geo-audit': { label: 'GEO Audit Reports', icon: '🌐', color: '#0ea5e9' },
  'direct-answer': { label: 'Direct Answers', icon: '💬', color: '#0ea5e9' },

  'cookie-policy': { label: 'Cookie Policy', icon: '🍪', color: '#f59e0b' },
  'privacy-policy': { label: 'Privacy Policy', icon: '🔒', color: '#d97706' },
  'terms-of-service': { label: 'Terms of Service', icon: '📜', color: '#b45309' },

  'duplicate-id-fix': { label: 'Duplicate ID Fix Plans', icon: '🆔', color: '#f97316' },
};

// Source filter (decision: redesign the existing Action Center into a
// source-filterable universal hub rather than a new page) — every
// recommendation already carries `bucket`/`category` from
// server/agents/lib/recommendation-taxonomy.js (an additive-only
// classification layered onto the existing recommendations feed; it never
// changes which recommendations exist or how a draft is generated).
const SOURCE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'seo', label: 'SEO' },
  { value: 'aeo', label: 'AEO' },
  { value: 'geo', label: 'GEO' },
];
const BUCKET_META = {
  seo: { label: 'SEO', color: '#2563eb' },
  aeo: { label: 'AEO', color: '#10b981' },
  geo: { label: 'GEO', color: '#7c3aed' },
};
// Icon per category name — purely cosmetic, falls back to a generic dot for
// any category not listed (e.g. a future agent's own category).
const CATEGORY_META = {
  'Meta Titles': { icon: '🏷️' },
  'Content Expansion': { icon: '📄' },
  'Landing Pages': { icon: '🚀' },
  'Broken Links': { icon: '⛔' },
  'Technical Fixes': { icon: '🛠️' },
  'FAQ Opportunities': { icon: '❓' },
  'Blog Opportunities': { icon: '📝' },
  'Entity Pages': { icon: '🧩' },
  'Topic Coverage': { icon: '🌐' },
  'AI Mentions': { icon: '🤖' },
  'Citation Opportunities': { icon: '🔗' },
  'CTR Opportunities': { icon: '📈' },
  'Traffic Anomalies': { icon: '⚠️' },
  'Growth Opportunities': { icon: '🌱' },
  'Conversion Issues': { icon: '🎯' },
  'GEO Signals': { icon: '📡' },
  'AI Crawler Access': { icon: '🕷️' },
};

function pagePathFor(url) {
  try { const u = new URL(url); return u.pathname === '/' ? u.hostname : u.pathname; } catch { return null; }
}

// A specific, scannable headline instead of a generic recurring label (e.g.
// every content-gap finding used to read as the same "Cover this topic")
// — built entirely from fields the recommendations feed already returns
// (item.params.query/.topic/.page), no backend change needed.
function titleFor(item) {
  const topic = item.params?.query || item.params?.topic;
  if (topic && (item.generatorId === 'blog-outline' || item.generatorId === 'direct-answer')) {
    return `${topic} — ${item.tag}`;
  }
  if (item.params?.page) {
    const path = pagePathFor(item.params.page);
    if (path) return `${item.tag} — ${path}`;
  }
  return item.tag;
}

const DRAFT_STATUS_LABEL = {
  draft: 'draft', edited: 'edited', submitted_for_approval: 'pending approval',
  approved: 'approved', branch_pushed: 'branch pushed', merged_to_stage: 'merged to stage',
  pr_opened: 'PR opened', implemented: 'implemented', abandoned: 'abandoned',
};

const STATUS_ORDER = ['draft', 'edited', 'submitted_for_approval', 'approved', 'branch_pushed', 'merged_to_stage', 'pr_opened', 'implemented'];
const STAGE_COLOR = {
  draft: '#94a3b8', edited: '#f59e0b', submitted_for_approval: '#f59e0b',
  approved: '#10b981', branch_pushed: '#7c3aed', merged_to_stage: '#2563eb',
  pr_opened: '#2563eb', implemented: '#10b981', abandoned: '#94a3b8',
};

// No 'implemented' entry — implemented drafts live only on the dedicated
// Implemented tab (see implementedDrafts below), never inside the Drafts
// tab's own list, "All Drafts" included.
const STATUS_FILTERS = [
  { value: '', label: 'All Drafts' },
  { value: 'submitted_for_approval', label: 'Pending Approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'branch_pushed', label: 'Branch Pushed' },
  { value: 'pr_opened', label: 'PR Opened' },
];

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function DraftStepper({ status }) {
  const idx = Math.max(0, STATUS_ORDER.indexOf(status));
  return (
    <div className="flex items-center gap-1" aria-label={`Status: ${DRAFT_STATUS_LABEL[status] || status}`}>
      {STATUS_ORDER.map((s, i) => (
        <span key={s} className="flex items-center">
          <span className="w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-300"
            style={{ 
              background: i <= idx ? STAGE_COLOR[status] : '#e2e8f0',
              boxShadow: i === idx ? `0 0 6px ${STAGE_COLOR[status]}` : 'none',
              transform: i === idx ? 'scale(1.25)' : 'scale(1)'
            }} />
          {i < STATUS_ORDER.length - 1 && (
            <span className="w-3 h-px shrink-0" style={{ background: i < idx ? STAGE_COLOR[status] : '#e2e8f0' }} />
          )}
        </span>
      ))}
    </div>
  );
}

export default function ActionCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState('recommendations'); // 'recommendations' | 'drafts' | 'implemented'
  const [recs, setRecs] = useState(null); // null = loading
  const [drafts, setDrafts] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState({ start: daysAgo(7), end: daysAgo(0) });
  const [generatingId, setGeneratingId] = useState(null);
  const [activeDraft, setActiveDraft] = useState(null);
  const [error, setError] = useState(null);
  const [executingSafeFixes, setExecutingSafeFixes] = useState(false);
  const [executionResult, setExecutionResult] = useState(null);
  const [executionJobDetail, setExecutionJobDetail] = useState(null);
  const [loadingExecutionJobDetail, setLoadingExecutionJobDetail] = useState(false);
  const [shippingId, setShippingId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all'); // 'all' | 'seo' | 'aeo' | 'geo'

  // Sidebar category selections
  const [activeCategory, setActiveCategory] = useState(null);
  const [showAllRecommendations, setShowAllRecommendations] = useState(false);

  // Selected item inside lists for split-screen preview
  const [selectedRecommendation, setSelectedRecommendation] = useState(null);
  const [selectedDraftItem, setSelectedDraftItem] = useState(null);

  useEffect(() => {
    setShowAllRecommendations(false);
    setSelectedRecommendation(null);
  }, [activeCategory, tab]);

  const loadRecs = () => api.actionCenter.recommendations().then((data) => {
    setRecs(data);
    const categories = [...new Set((data?.items || []).map((item) => item.category || 'Technical Fixes'))];
    if (categories.length > 0) setActiveCategory(categories[0]);
  }).catch(() => setRecs({ items: [], lastAnalyzedAt: {} }));

  const loadDrafts = () => api.actionCenter.drafts().then((data) => {
    setDrafts(data);
    if (data && data.length > 0) setSelectedDraftItem(data[0]);
  }).catch(() => setDrafts([]));

  const [todayStats, setTodayStats] = useState(null); // null | { shipped, failed }
  const loadTodayStats = () => api.actionCenter.todayExecutionStats().then(setTodayStats).catch(() => {});

  useEffect(() => { loadRecs(); loadDrafts(); loadTodayStats(); }, []);
  useEffect(() => { if (tab === 'drafts' || tab === 'implemented') loadDrafts(); }, [tab]);

  // Deep link from a notification's "where the agent decided how to fix
  // it" click (NotificationBell.jsx's targetFor) — ?openDraft=<id> lands
  // straight on that specific draft, modal open, instead of the default
  // recommendations view. Consumed once drafts has actually loaded (so the
  // target draft is guaranteed present in the list to select), then
  // stripped from the URL so switching tabs/refreshing drafts afterward
  // doesn't re-trigger it.
  useEffect(() => {
    const openId = searchParams.get('openDraft');
    if (!openId || drafts === null) return;
    const target = drafts.find((d) => String(d.id) === openId);
    if (target) {
      setTab(target.status === 'implemented' ? 'implemented' : 'drafts');
      setSelectedDraftItem(target);
      setActiveDraft(target);
    }
    setSearchParams((p) => { p.delete('openDraft'); return p; }, { replace: true });
  }, [drafts, searchParams]);

  // Implemented drafts belong on the Implemented tab only, and abandoned
  // ones (a PR closed without merging, or a leftover superseded by another
  // draft — see markDraftAbandoned/supersedeLegacyLlmsTxtDrafts in
  // store/drafts.js) never shipped and never will — neither belongs mixed
  // into the Drafts tab's own list, "All Drafts" included.
  const nonImplementedDrafts = drafts === null ? null : drafts.filter((d) => d.status !== 'implemented' && d.status !== 'abandoned');
  const visibleDrafts = statusFilter ? (nonImplementedDrafts || []).filter((d) => d.status === statusFilter) : nonImplementedDrafts;

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await api.actionCenter.refresh(range.start, range.end);
      setRecs(fresh);
      const categories = [...new Set((fresh?.items || []).map((item) => item.category || 'Technical Fixes'))];
      if (categories.length > 0) setActiveCategory(categories[0]);
    } catch (e) {
      setError(e.message || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const generate = async (item) => {
    setGeneratingId(item.id);
    setError(null);
    try {
      const draft = await api.actionCenter.generate(item.generatorId, item.params, item.source, item.id);
      setActiveDraft(draft);
      // The backend now excludes any already-drafted finding from
      // recommendations — refresh recs too so this item disappears from the
      // list immediately instead of only in the Drafts tab.
      loadRecs();
      loadDrafts();
    } catch (e) {
      setError(`${item.tag}: ${e.message || 'Generation failed'}`);
    } finally {
      setGeneratingId(null);
    }
  };

  // Phase 4 M3 — bulk-ships every open, safe-tier recommendation (up to 15)
  // through the existing Generate -> Submit -> Approve chain automatically,
  // one execution job, one shared branch/PR. Manual-tier recommendations
  // (landing pages, pricing, nav, etc.) are never included — they always
  // need the stepped flow below.
  const executeSafeFixes = async () => {
    setExecutingSafeFixes(true);
    setError(null);
    setExecutionResult(null);
    setExecutionJobDetail(null);
    try {
      const result = await api.actionCenter.executeSafeFixes(15);
      setExecutionResult(result);
      loadRecs();
      loadDrafts();
      loadTodayStats();
    } catch (e) {
      setError(e.message || 'Execute Safe Fixes failed');
    } finally {
      setExecutingSafeFixes(false);
    }
  };

  // Lazily loads the per-item breakdown (which recs failed and why) for the
  // most recent execute-safe-fixes run — the summary banner only has counts.
  const toggleExecutionFailures = async () => {
    if (executionJobDetail) { setExecutionJobDetail(null); return; }
    const jobId = executionResult?.job?.id;
    if (!jobId) return;
    setLoadingExecutionJobDetail(true);
    try {
      setExecutionJobDetail(await api.actionCenter.getExecutionJob(jobId));
    } catch (e) {
      setError(e.message || 'Failed to load execution job detail');
    } finally {
      setLoadingExecutionJobDetail(false);
    }
  };


  // A failed item only has a draft to open when the chain got as far as
  // generateDraft before failing (e.g. an apply-time placeholder-field
  // rejection) — items that failed inside generateDraft itself (e.g. "model
  // did not return valid JSON") never got a draft row, so draft_id is null
  // and there's nothing to open; that finding is already back in Recs untouched.
  const openFailedDraft = async (draftId) => {
    try {
      setActiveDraft(await api.actionCenter.draft(draftId));
    } catch (e) {
      setError(e.message || 'Could not load draft');
    }
  };


  // Single-item version of the same chain — for a safe-tier recommendation
  // the user wants to ship right now instead of waiting for the next bulk
  // run, without the separate Generate/Submit/Approve clicks.
  const approveAndShip = async (item) => {
    setShippingId(item.id);
    setError(null);
    setExecutionResult(null);
    try {
      const draft = await api.actionCenter.approveAndShip(item.id);
      setExecutionResult({ shipped: 1, failed: 0, job: { pr_url: draft.pr_url, pr_number: draft.pr_number } });
      setSelectedRecommendation(null);
      loadRecs();
      loadDrafts();
      loadTodayStats();
    } catch (e) {
      setError(`${item.tag}: ${e.message || 'Approve & Ship failed'}`);
    } finally {
      setShippingId(null);
    }
  };

  const bucketFiltered = (recs?.items || []).filter((item) => sourceFilter === 'all' || item.bucket === sourceFilter);
  const grouped = bucketFiltered.reduce((acc, item) => {
    (acc[item.category || 'Technical Fixes'] ||= []).push(item);
    return acc;
  }, {});

  // Switching the source filter can only add/remove whole categories (every
  // category maps to exactly one bucket in recommendation-taxonomy.js), so
  // a category still present after filtering never loses/gains items — only
  // reset the selection when the currently-active one drops out of view.
  useEffect(() => {
    const categories = Object.keys(grouped);
    if (categories.length && !categories.includes(activeCategory)) setActiveCategory(categories[0]);
    else if (!categories.length) setActiveCategory(null);
  }, [sourceFilter, recs]);

  const implementedDrafts = (drafts || []).filter((d) => d.status === 'implemented')
    .sort((a, b) => new Date(b.implemented_at) - new Date(a.implemented_at));

  const highPriorityCount = (recs?.items || []).filter((i) => i.priority === 'high').length;
  const safeEligibleCount = (recs?.items || []).filter((i) => i.riskTier === 'safe').length;
  const pendingApprovalCount = (drafts || []).filter((d) => d.status === 'submitted_for_approval').length;
  const implementedThisWeekCount = (drafts || []).filter((d) => d.status === 'implemented' && d.implemented_at >= daysAgo(7)).length;

  // Selected category items mapping
  const activeItems = activeCategory ? (grouped[activeCategory] || []) : [];
  const sortedItems = [...activeItems].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
  const activeBucket = activeItems[0]?.bucket;
  const activeMeta = activeCategory
    ? { icon: CATEGORY_META[activeCategory]?.icon || '•', color: BUCKET_META[activeBucket]?.color || '#64748b', label: activeCategory }
    : null;

  // Default active selection helper
  useEffect(() => {
    if (sortedItems.length > 0 && !selectedRecommendation) {
      setSelectedRecommendation(sortedItems[0]);
    }
  }, [sortedItems]);

  useEffect(() => {
    if (visibleDrafts && visibleDrafts.length > 0 && !selectedDraftItem) {
      setSelectedDraftItem(visibleDrafts[0]);
    }
  }, [visibleDrafts]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      
      <PageHeader
        title="Action Center"
        subtitle="Review, customize, and approve AI recommendations before staging deployment"
        icon="⚡"
      />

      {error && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-2xl px-4 py-3 leading-relaxed flex items-center gap-2">
          <AlertTriangle size={14} className="text-rose-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {executionResult && (
        <div className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-2xl px-4 py-3 leading-relaxed">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <CheckCircle2 size={14} className="text-emerald-550 shrink-0" />
              <span>
                Shipped {executionResult.shipped}{executionResult.failed > 0 ? `, ${executionResult.failed} failed` : ''} — committed to one branch{executionResult.job?.pr_url ? ', one PR opened' : ''}.
              </span>

            </span>
            <span className="flex items-center gap-2 shrink-0">
              {executionResult.failed > 0 && executionResult.job?.id && (
                <button
                  onClick={toggleExecutionFailures}
                  disabled={loadingExecutionJobDetail}
                  className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg bg-white border border-rose-200 text-rose-600 hover:border-rose-350 transition disabled:opacity-60 cursor-pointer"
                >
                  {loadingExecutionJobDetail ? 'Loading…' : (
                    <>{executionJobDetail ? <ChevronUp size={10} strokeWidth={2.5} /> : <ChevronDown size={10} strokeWidth={2.5} />} {executionResult.failed} failed</>
                  )}
                </button>
              )}
              {executionResult.job?.pr_url && (
                <a href={executionResult.job.pr_url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg bg-white border border-emerald-200 text-emerald-700 hover:border-emerald-350 transition">
                  <GitPullRequest size={11} /> View PR
                </a>
              )}
              <button onClick={() => { setExecutionResult(null); setExecutionJobDetail(null); }} className="text-emerald-400 hover:text-emerald-600 text-sm leading-none cursor-pointer">×</button>
            </span>

            </span>
            <span className="flex items-center gap-2 shrink-0">
              {executionResult.failed > 0 && executionResult.job?.id && (
                <button
                  onClick={toggleExecutionFailures}
                  disabled={loadingExecutionJobDetail}
                  className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg bg-white border border-rose-200 text-rose-600 hover:border-rose-350 transition disabled:opacity-60 cursor-pointer"
                >
                  {loadingExecutionJobDetail ? 'Loading…' : (
                    <>{executionJobDetail ? <ChevronUp size={10} strokeWidth={2.5} /> : <ChevronDown size={10} strokeWidth={2.5} />} {executionResult.failed} failed</>
                  )}
                </button>
              )}
              {executionResult.job?.pr_url && (
                <a href={executionResult.job.pr_url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg bg-white border border-emerald-200 text-emerald-700 hover:border-emerald-350 transition">
                  <GitPullRequest size={11} /> View PR
                </a>
              )}
              <button onClick={() => { setExecutionResult(null); setExecutionJobDetail(null); }} className="text-emerald-400 hover:text-emerald-600 text-sm leading-none cursor-pointer">×</button>
            </span>

          </div>

          {executionJobDetail && (
            <div className="mt-3 pt-3 border-t border-emerald-100 space-y-1.5">

              {executionJobDetail.items.filter((it) => it.status === 'failed').map((it) => {
                const Row = it.draft_id ? 'button' : 'div';
                return (
                  <Row
                    key={it.id}
                    type={it.draft_id ? 'button' : undefined}
                    onClick={it.draft_id ? () => openFailedDraft(it.draft_id) : undefined}
                    className={`w-full flex items-start gap-2 text-[11px] font-medium text-rose-700 bg-white/60 rounded-lg px-3 py-2 text-left ${it.draft_id ? 'hover:bg-white hover:border-rose-200 border border-transparent transition cursor-pointer' : ''}`}
                  >
                    <XCircle size={12} className="text-rose-500 shrink-0 mt-0.5" />
                    <span>
                      <span className="font-black">{it.recommendation_type}</span>
                      {it.page ? <span className="text-rose-500"> — {it.page}</span> : null}
                      <span className="block text-rose-500 font-normal mt-0.5">{it.error || 'No error message recorded'}</span>
                      {it.draft_id && (
                        <span className="block text-[9px] font-black uppercase tracking-wider text-rose-400 mt-1">Click to open draft →</span>
                      )}
                    </span>
                  </Row>
                );
              })}

              {executionJobDetail.items.filter((it) => it.status === 'failed').map((it) => (
                <div key={it.id} className="flex items-start gap-2 text-[11px] font-medium text-rose-700 bg-white/60 rounded-lg px-3 py-2">
                  <XCircle size={12} className="text-rose-500 shrink-0 mt-0.5" />
                  <span>
                    <span className="font-black">{it.recommendation_type}</span>
                    {it.page ? <span className="text-rose-500"> — {it.page}</span> : null}
                    <span className="block text-rose-500 font-normal mt-0.5">{it.error || 'No error message recorded'}</span>
                  </span>
                </div>
              ))}

            </div>
          )}
        </div>
      )}

      {/* QUICK COMMAND METRIC HEADER PANEL */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">

        {/* Tab switch panel (Left, 5-cols — matches the 5-col left column below so edges line up) */}
        <div className="lg:col-span-5 bg-slate-100/90 p-1.5 rounded-2xl border border-slate-200/80 flex shadow-sm items-center justify-between">
          {[
            { key: 'recommendations', label: 'Recs', count: recs?.items.length },
            { key: 'drafts', label: 'Drafts', count: nonImplementedDrafts?.length },
            { key: 'implemented', label: 'Done', count: implementedDrafts.length }
          ].map((t) => (
            <button 
              key={t.key} 
              onClick={() => setTab(t.key)}
              className={`text-xs py-2.5 px-3.5 font-black rounded-xl flex-1 transition-all duration-200 cursor-pointer ${
                tab === t.key
                  ? 'bg-white text-indigo-650 shadow border border-slate-200/60'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {t.label} {t.count !== undefined && <span className="font-mono text-[9px] opacity-70">({t.count})</span>}
            </button>
          ))}
        </div>

        {/* Date controllers & refresh pipeline (Right, 7-cols — matches the 7-col right column below so edges line up) */}
        <div className="lg:col-span-7 bg-white border border-slate-205 rounded-2xl p-2.5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
          
          {/* Quick stats indicators with distinct colored chips */}
          <div className="flex items-center gap-2.5 text-[10.5px] font-black uppercase tracking-wider shrink-0">
            <span className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-100 text-indigo-700 px-3 py-1.5 rounded-xl shadow-sm"><Sparkles size={11} className="text-indigo-550 animate-pulse" /> Recs: <strong className="ml-0.5">{recs?.items.length ?? 0}</strong></span>
            <span className="flex items-center gap-1.5 bg-rose-50 border border-rose-100 text-rose-700 px-3 py-1.5 rounded-xl shadow-sm"><AlertTriangle size={11} className="text-rose-550" /> High: <strong className="ml-0.5">{highPriorityCount}</strong></span>
            <span className="flex items-center gap-1.5 bg-amber-50 border border-amber-100 text-amber-700 px-3 py-1.5 rounded-xl shadow-sm"><Clock size={11} className="text-amber-550" /> Review: <strong className="ml-0.5">{pendingApprovalCount}</strong></span>
            <span className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-100 text-emerald-700 px-3 py-1.5 rounded-xl shadow-sm"><ShieldCheck size={11} className="text-emerald-550" /> Auto-eligible: <strong className="ml-0.5">{safeEligibleCount}</strong></span>
          </div>

          <div className="flex items-center flex-wrap gap-2 gap-y-2 ml-auto">
            <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-[10px]">
              <span className="font-black text-slate-400">Start:</span>
              <input type="date" value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                className="bg-transparent border-none outline-none font-bold text-slate-700 w-[90px] sm:w-[105px]" />
            </div>
            <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-[10px]">
              <span className="font-black text-slate-400">End:</span>
              <input type="date" value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
                className="bg-transparent border-none outline-none font-bold text-slate-700 w-[90px] sm:w-[105px]" />
            </div>
            <button
              onClick={refresh}
              disabled={refreshing}
              className="text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md hover:shadow-indigo-500/10 disabled:opacity-60 cursor-pointer"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      {/* DUAL COLUMN SPLIT VIEWPORT WITH COLOR CONTRAST */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        
        {/* Left Column (5-cols) - Pipeline selection lists (SLATE BACKGROUND FOR CONTRAST) */}
        <div className="lg:col-span-5 bg-slate-50 border border-slate-200 rounded-3xl p-4.5 space-y-4 shadow-sm flex flex-col justify-start">
          
          {/* Source filter (Recommendations tab) — SEO / GEO / Analytics,
              purely a display filter over the same recommendations feed;
              Generate Draft/Drafts/Approval/PR logic below is untouched. */}
          {tab === 'recommendations' && recs && (
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1 bg-slate-100/90 p-1 rounded-xl border border-slate-200/80">
                {SOURCE_FILTERS.map((f) => {
                  const active = sourceFilter === f.value;
                  const meta = BUCKET_META[f.value];
                  return (
                    <button
                      key={f.value}
                      onClick={() => setSourceFilter(f.value)}
                      className={`text-[10px] py-1.5 px-2.5 font-black rounded-lg transition-all duration-150 cursor-pointer ${
                        active ? 'bg-white shadow border border-slate-200/60' : 'text-slate-500 hover:text-slate-800'
                      }`}
                      style={active && meta ? { color: meta.color } : undefined}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={executeSafeFixes}
                disabled={executingSafeFixes || safeEligibleCount === 0}
                title={safeEligibleCount === 0 ? 'No safe-tier recommendations open right now' : `Ship up to 15 of ${safeEligibleCount} safe recommendations — one branch, one PR, no per-item clicks`}
                className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2.5 py-1.5 rounded-xl text-white transition hover:scale-[1.02] active:scale-[0.98] shadow-sm disabled:opacity-50 disabled:hover:scale-100 cursor-pointer ml-auto shrink-0"
                style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}
              >
                <Zap size={11} className={executingSafeFixes ? 'animate-pulse' : ''} />
                {executingSafeFixes ? '…' : Math.min(15, safeEligibleCount)}
              </button>

              {/* Live "today" counters — distinct from the Zap button's live
                  eligible-count above it: that's "how many could ship right
                  now," this is "how many actually did today," pulled from
                  execution_job_recommendations (server/store/execution-jobs.js). */}
              {todayStats && (todayStats.shipped > 0 || todayStats.failed > 0) && (
                <div className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider shrink-0" title="Shipped / failed today, across all Execute Safe Fixes and Approve & Ship runs">
                  {todayStats.shipped > 0 && (
                    <span className="flex items-center gap-1 bg-emerald-50 border border-emerald-100 text-emerald-700 px-2 py-1.5 rounded-xl shadow-sm">
                      <CheckCircle2 size={10} className="text-emerald-550" /> {todayStats.shipped} today
                    </span>
                  )}
                  {todayStats.failed > 0 && (
                    <span className="flex items-center gap-1 bg-rose-50 border border-rose-100 text-rose-700 px-2 py-1.5 rounded-xl shadow-sm">
                      <XCircle size={10} className="text-rose-550" /> {todayStats.failed} today
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Categories select checklist (Recommendations tab) — dynamic per
              selected source, only categories actually present are shown. */}
          {tab === 'recommendations' && recs && Object.keys(grouped).length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 px-1 flex items-center gap-1 mb-1">
                <Layers size={11} className="text-indigo-550" />
                <span>Categories ({Object.keys(grouped).length})</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {Object.entries(grouped).map(([category, items]) => {
                  const bucketColor = BUCKET_META[items[0]?.bucket]?.color || '#64748b';
                  const meta = { label: category, icon: CATEGORY_META[category]?.icon || '•', color: bucketColor };
                  const active = activeCategory === category;
                  return (
                    <button
                      key={category}
                      onClick={() => setActiveCategory(category)}
                      className={`flex items-center justify-between px-3 py-2 rounded-xl text-[11px] font-bold transition-all border text-left cursor-pointer ${
                        active
                          ? 'bg-white border-slate-300 text-indigo-700 shadow-sm font-black'
                          : 'bg-slate-100/50 border-slate-200 text-slate-600 hover:text-slate-800'
                      }`}
                      style={{
                        color: active ? meta.color : '',
                        borderColor: active ? `${meta.color}5a` : ''
                      }}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <span>{meta.icon}</span>
                        <span className="truncate">{meta.label}</span>
                      </span>
                      <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-500">
                        {items.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Pipelines status list (Drafts tab) */}
          {tab === 'drafts' && nonImplementedDrafts && nonImplementedDrafts.length > 0 && (
            <div className="space-y-1">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 px-1 flex items-center gap-1 mb-1">
                <SlidersHorizontal size={11} className="text-indigo-550" />
                <span>Pipelines Filter</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {STATUS_FILTERS.map((f) => {
                  const active = statusFilter === f.value;
                  const count = f.value
                    ? nonImplementedDrafts.filter((d) => d.status === f.value).length
                    : nonImplementedDrafts.length;
                  return (
                    <button 
                      key={f.value} 
                      onClick={() => setStatusFilter(f.value)}
                      className={`flex items-center justify-between gap-1.5 px-3 py-1.5 rounded-xl text-[10.5px] font-black transition-all border cursor-pointer ${
                        active 
                          ? 'bg-white border-slate-350 text-indigo-700 shadow-sm' 
                          : 'bg-slate-100/60 border-slate-200 text-slate-550 hover:text-slate-800'
                      }`}
                    >
                      <span>{f.label}</span>
                      <span className="font-mono text-[9px] opacity-75">({count})</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Main list view block */}
          {tab === 'recommendations' && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden flex flex-col justify-between flex-1 min-h-[300px]">
              <div>
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Findings List</span>
                  <span className="text-[10px] font-bold text-slate-400 font-mono">{activeItems.length} entries</span>
                </div>

                {recs === null ? (
                  <div className="p-8 text-center text-xs text-slate-450 animate-pulse">Running audits…</div>
                ) : activeItems.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-450 italic">No recommendations.</div>
                ) : (
                  // Unlike the Drafts/Implemented lists below (which already
                  // cap at max-h-[360px] overflow-y-auto), this one had no
                  // scroll bound — "View All" expanding to a dozen-plus
                  // entries just grew the whole card (and page) instead of
                  // scrolling internally, burying the right column's
                  // Generate Draft panel far below the fold on mobile.
                  <div className="divide-y divide-slate-100 overflow-y-auto max-h-[360px]">
                    {(showAllRecommendations ? sortedItems : sortedItems.slice(0, 4)).map((item) => {
                      const pr = PRIORITY[item.priority] || PRIORITY.low;
                      const selected = selectedRecommendation?.id === item.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => setSelectedRecommendation(item)}
                          className={`w-full flex items-start gap-3 px-4 py-3.5 text-left border-b border-slate-50 hover:bg-slate-50/40 transition cursor-pointer ${
                            selected ? 'bg-indigo-50/45 border-r-2 border-r-indigo-500' : ''
                          }`}
                        >
                          <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 animate-pulse" style={{ background: pr.color }} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-xs font-black text-slate-800 leading-snug truncate">{titleFor(item)}</span>
                              {item.riskTier === 'safe' && (
                                <span className="shrink-0 flex items-center gap-0.5 text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-600">
                                  <ShieldCheck size={8} /> Safe
                                </span>
                              )}
                              {BUCKET_META[item.bucket] && (
                                <span
                                  className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0"
                                  style={{ color: BUCKET_META[item.bucket].color, background: `${BUCKET_META[item.bucket].color}14` }}
                                >
                                  {BUCKET_META[item.bucket].label}
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] font-bold text-slate-450 mt-1 truncate">{item.reason}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              
              {sortedItems.length > 4 && (
                <div className="p-2.5 border-t border-slate-100 bg-slate-50/30 flex justify-end">
                  <button 
                    type="button"
                    onClick={() => setShowAllRecommendations(!showAllRecommendations)}
                    className="text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-indigo-650 hover:border-slate-350 transition flex items-center gap-1 shadow-sm focus:outline-none cursor-pointer"
                  >
                    <span>{showAllRecommendations ? 'Less' : `All (${sortedItems.length})`}</span>
                    {showAllRecommendations ? <ChevronUp size={10} strokeWidth={2.5} /> : <ChevronDown size={10} strokeWidth={2.5} />}
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'drafts' && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden flex-1 flex flex-col min-h-[300px]">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Drafts List</span>
                <span className="text-[10px] font-bold text-slate-400 font-mono">{visibleDrafts?.length || 0} visible</span>
              </div>

              {drafts === null ? (
                <div className="p-8 text-center text-xs text-slate-450 animate-pulse">Loading list…</div>
              ) : visibleDrafts.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-405 italic">No drafts matching status.</div>
              ) : (
                <div className="divide-y divide-slate-100 overflow-y-auto flex-1 max-h-[360px]">
                  {visibleDrafts.map((d) => {
                    const meta = GENERATOR_META[d.action_type] || { label: d.action_type, icon: '•', color: '#64748b' };
                    const selected = selectedDraftItem?.id === d.id;
                    return (
                      <button 
                        key={d.id} 
                        onClick={() => setSelectedDraftItem(d)}
                        className={`w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-slate-50/40 transition cursor-pointer ${
                          selected ? 'bg-indigo-50/45 border-r-2 border-r-indigo-500' : ''
                        }`}
                      >
                        <span className="w-6 h-6 rounded-lg grid place-items-center text-xs shrink-0 border border-slate-150 bg-white" style={{ color: meta.color }}>
                          {meta.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-black text-slate-800 leading-snug">{meta.label}</div>
                          <div className="text-[9.5px] font-mono text-slate-400 truncate mt-0.5">
                            {d.input?.page || d.input?.topic || d.input?.market || d.input?.city || ''}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'implemented' && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden flex-1 flex flex-col min-h-[300px]">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Implemented History</span>
                <span className="text-[10px] font-bold text-slate-405 font-mono">{implementedDrafts.length} total</span>
              </div>

              {drafts === null ? (
                <div className="p-8 text-center text-xs text-slate-405 animate-pulse">Loading history…</div>
              ) : implementedDrafts.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-405 italic">No logs generated.</div>
              ) : (
                <div className="divide-y divide-slate-100 overflow-y-auto flex-1 max-h-[360px]">
                  {implementedDrafts.map((d) => {
                    const meta = GENERATOR_META[d.action_type] || { label: d.action_type, icon: '•', color: '#64748b' };
                    const selected = selectedDraftItem?.id === d.id;
                    return (
                      <button 
                        key={d.id} 
                        onClick={() => setSelectedDraftItem(d)}
                        className={`w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-slate-50/40 transition cursor-pointer ${
                          selected ? 'bg-indigo-50/45 border-r-2 border-r-indigo-500' : ''
                        }`}
                      >
                        <span className="w-6 h-6 rounded-lg grid place-items-center text-xs shrink-0 border border-slate-150 bg-white" style={{ color: meta.color }}>
                          {meta.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-black text-slate-800 leading-snug">{meta.label}</div>
                          <div className="text-[9.5px] font-mono text-slate-400 truncate mt-0.5">
                            {d.input?.page || d.input?.topic || d.input?.market || d.input?.city || ''}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column (7-cols) - Split screen Live Workspace Preview (FLOATING WHITE CARD FOR ELEVATION CONTRAST) */}
        <div className="lg:col-span-7">
          
          {tab === 'recommendations' && (
            <div className="rounded-3xl border border-slate-205 bg-white shadow-md overflow-hidden h-full flex flex-col justify-between min-h-[350px]">
              {selectedRecommendation ? (
                <div className="flex-1 flex flex-col justify-between">
                  <div>
                    <div className="h-1.5 shrink-0 animate-pulse" style={{ background: activeMeta ? `linear-gradient(to right, ${activeMeta.color}, ${activeMeta.color}3a)` : '#e2e8f0' }} />
                    <div className="px-6 py-5 border-b border-slate-100 flex items-center gap-3 bg-slate-50/40">
                      {activeMeta && (
                        <span className="w-9 h-9 rounded-xl grid place-items-center text-sm shadow border border-slate-200 bg-white animate-fade-in" style={{ color: activeMeta.color }}>
                          {activeMeta.icon}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-black text-slate-900 leading-tight">{titleFor(selectedRecommendation)}</h3>
                          {selectedRecommendation.riskTier === 'safe' ? (
                            <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-600">
                              <ShieldCheck size={9} /> Safe — auto-eligible
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-50 border border-amber-100 text-amber-600">
                              <ShieldAlert size={9} /> Manual review required
                            </span>
                          )}
                          {BUCKET_META[selectedRecommendation.bucket] && (
                            <span
                              className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0"
                              style={{ color: BUCKET_META[selectedRecommendation.bucket].color, background: `${BUCKET_META[selectedRecommendation.bucket].color}14` }}
                            >
                              {BUCKET_META[selectedRecommendation.bucket].label}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider mt-1.5">Found by: {activeMeta?.label || 'Website Check'}</p>
                      </div>
                    </div>

                    <div className="p-6 space-y-4">
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Found By</div>
                        <p className="text-xs font-bold text-slate-700">{selectedRecommendation.agentName || activeMeta?.label}</p>
                      </div>

                      <div>
                        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Reason</div>
                        <p className="text-xs font-medium text-slate-650 leading-relaxed bg-slate-50 p-4.5 rounded-2xl border border-slate-150 shadow-inner">
                          {selectedRecommendation.reason}
                        </p>
                      </div>

                      {selectedRecommendation.params.page && (
                        <div>
                          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Affected Page URL</div>
                          <div className="bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 font-mono text-[10.5px] text-indigo-650 truncate max-w-full">
                            {selectedRecommendation.params.page}
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Priority</div>
                          <span className={`inline-flex items-center gap-1 text-[9.5px] font-black uppercase tracking-wider px-3 py-1 rounded-full border ${
                            selectedRecommendation.priority === 'high' ? 'bg-rose-50 border-rose-100 text-rose-600' : 'bg-slate-50 border-slate-200 text-slate-600'
                          }`}>
                            {selectedRecommendation.priority === 'high' ? '⚠️ High' : '• Normal'}
                          </span>
                        </div>
                        {selectedRecommendation.expectedImpact?.label && (
                          <div>
                            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Expected Impact</div>
                            <span className="inline-flex items-center gap-1 text-[9.5px] font-black uppercase tracking-wider px-3 py-1 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-600">
                              🚀 {selectedRecommendation.expectedImpact.label} Impact
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="p-6 border-t border-slate-100 bg-slate-50/30 flex items-center justify-end gap-2.5">
                    {selectedRecommendation.riskTier === 'safe' && (
                      <button
                        onClick={() => generate(selectedRecommendation)}
                        disabled={generatingId === selectedRecommendation.id || shippingId === selectedRecommendation.id}
                        className="text-[10.5px] font-black uppercase tracking-wider px-4 py-3 rounded-xl text-slate-600 bg-white border border-slate-200 transition hover:border-slate-350 disabled:opacity-60 cursor-pointer"
                      >
                        {generatingId === selectedRecommendation.id ? 'Drafting…' : 'Preview Draft Only'}
                      </button>
                    )}
                    <button
                      onClick={() => selectedRecommendation.riskTier === 'safe' ? approveAndShip(selectedRecommendation) : generate(selectedRecommendation)}
                      disabled={generatingId === selectedRecommendation.id || shippingId === selectedRecommendation.id}
                      className="flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md disabled:opacity-60 cursor-pointer"
                      style={selectedRecommendation.riskTier === 'safe'
                        ? { background: 'linear-gradient(135deg,#10b981,#059669)' }
                        : { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                    >
                      {selectedRecommendation.riskTier === 'safe' ? (
                        <><Zap size={12} /> {shippingId === selectedRecommendation.id ? 'Shipping…' : 'Approve & Ship'}</>
                      ) : (
                        generatingId === selectedRecommendation.id ? 'Drafting Fix…' : 'Generate Solution Draft'
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-xs text-slate-400 italic flex-1 flex flex-col justify-center items-center">
                  Select a finding row on the left to review detail actions
                </div>
              )}
            </div>
          )}

          {(tab === 'drafts' || tab === 'implemented') && (
            <div className="rounded-3xl border border-slate-205 bg-white shadow-md overflow-hidden h-full flex flex-col justify-between min-h-[350px]">
              {selectedDraftItem ? (
                <div className="flex-1 flex flex-col justify-between">
                  <div>
                    <div className="h-1.5 shrink-0" style={{ background: STAGE_COLOR[selectedDraftItem.status] || '#e2e8f0' }} />
                    <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/40">
                      <div className="flex items-center gap-3">
                        <span className="w-9 h-9 rounded-xl grid place-items-center text-xs shrink-0 border border-slate-200 bg-white">
                          {GENERATOR_META[selectedDraftItem.action_type]?.icon || '•'}
                        </span>
                        <div>
                          <h3 className="text-sm font-black text-slate-900 leading-none">{GENERATOR_META[selectedDraftItem.action_type]?.label || selectedDraftItem.action_type}</h3>
                          <p className="text-[10px] text-slate-450 font-black uppercase tracking-wider mt-1.5">Action Pipeline Target</p>
                        </div>
                      </div>
                      <span className="text-[9px] font-black uppercase tracking-wider px-2.5 py-1 rounded bg-slate-100 text-slate-500 border border-slate-200">
                        {DRAFT_STATUS_LABEL[selectedDraftItem.status] || selectedDraftItem.status}
                      </span>
                    </div>

                    <div className="p-6 space-y-4">
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Target Element</div>
                        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3.5 text-xs text-slate-700 leading-relaxed font-mono truncate max-w-full">
                          {selectedDraftItem.input?.page || selectedDraftItem.input?.topic || selectedDraftItem.input?.market || selectedDraftItem.input?.city || 'Root Context'}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-4 py-2.5 border-b border-slate-100">
                        <span className="text-[10.5px] text-slate-505 font-bold">Staging Stepper Status</span>
                        <DraftStepper status={selectedDraftItem.status} />
                      </div>

                      {selectedDraftItem.implemented_at && (
                        <div className="text-[10px] font-bold text-slate-500 bg-slate-50 p-2.5 rounded-xl border border-slate-150 flex justify-between">
                          <span>Merge Timeline:</span>
                          <span className="text-slate-700 font-bold">{new Date(selectedDraftItem.implemented_at).toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="p-6 border-t border-slate-100 bg-slate-50/30 flex justify-end">
                    <button
                      onClick={() => setActiveDraft(selectedDraftItem)}
                      className="text-[10.5px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-indigo-500/10 cursor-pointer"
                      style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                    >
                      {selectedDraftItem.status === 'implemented' ? 'View Draft' : 'Configure & Deploy Draft'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-xs text-slate-400 italic flex-1 flex flex-col justify-center items-center">
                  Select a draft row on the left to configure staging
                </div>
              )}
            </div>
          )}
        </div>
        
      </div>

      {activeDraft && (
        <DraftModal
          key={activeDraft.id}
          draft={activeDraft}
          onClose={() => setActiveDraft(null)}
          onSaved={(updated) => { setActiveDraft(updated); loadDrafts(); if (updated.rolled_back_at) loadRecs(); }}
          onDeleted={() => { setActiveDraft(null); loadDrafts(); loadRecs(); }}
        />
      )}
    </div>
  );
}
