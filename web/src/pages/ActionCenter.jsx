import { useEffect, useRef, useState } from 'react';
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
  XCircle,
  RefreshCw,
  Lock
} from 'lucide-react';

const GENERATOR_META = {
  'meta-title': { label: 'Meta Titles', icon: '🏷️', color: '#6C63FF' },
  faq: { label: 'FAQ Blocks', icon: '❓', color: '#0ea5e9' },
  schema: { label: 'Schema Markup', icon: '🧩', color: '#8b5cf6' },
  'internal-links': { label: 'Internal Links', icon: '🔗', color: '#14b8a6' },
  'blog-outline': { label: 'Blog Posts', icon: '📝', color: '#ec4899' },
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
  breadcrumbs: { label: 'Breadcrumbs Schema', icon: '🍞', color: '#84cc16' },
  'schema-repair': { label: 'Structured Data Repairs', icon: '🔧', color: '#a855f7' },
  'alt-text': { label: 'Image Alt Text', icon: '🖼️', color: '#f472b6' },
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
  // blog-image (agents/blog-image.js) has no page URL at all — it keys on
  // the post's real repo path instead (recommendationPageKey), so there is
  // nothing for pagePathFor's URL parse to work with. The raw path is still
  // a real, specific, reviewer-useful identifier on its own.
  if (item.params?.filePath) return `${item.tag} — ${item.params.filePath}`;
  return item.tag;
}

// WHY a recommendation is blocked reads very differently depending on kind
// (server/store/recommendations.js's classifyBlockedKind): 'our-config' is
// something the tenant can act on right now; 'awaiting-derivation' means the
// system is already working on it unattended and there's nothing to click;
// 'site-fact' is a real architectural constraint (e.g. a shared programmatic
// template), not a gap. Showing all three under one "Blocked" amber banner —
// as this used to — reads as "something is wrong here" even for the middle
// case, where nothing is. Falls back to the 'our-config' framing (the
// original blockedReason text, unornamented) for any older row that predates
// blocked_kind, or a kind this UI doesn't recognize yet.
const BLOCKED_KIND_META = {
  'our-config': {
    icon: Lock, badge: 'Blocked — setup needed', heading: "Can't be drafted yet",
    className: 'amber',
  },
  'awaiting-derivation': {
    icon: Clock, badge: 'Being set up automatically', heading: 'Nothing to do — this will unblock on its own',
    className: 'blue',
  },
  'design-degraded': {
    icon: Clock, badge: 'Drafting with default look', heading: 'Not blocked — using the fallback template for now',
    className: 'blue',
  },
  'site-fact': {
    icon: Layers, badge: "Can't be drafted here", heading: 'How this page is built',
    className: 'amber',
  },
};
function blockedMetaFor(item) {
  return BLOCKED_KIND_META[item?.blockedKind] || BLOCKED_KIND_META['our-config'];
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
  // Set only when a platform_admin arrived here via a cross-client deep link
  // (e.g. the Analyst's "Send to Action Center" — see AnalystGrowthOpportunities.jsx
  // / AnalystMetricIntelligence.jsx). Undefined for every normal session, in
  // which case every api.actionCenter.* call below falls back to the
  // session's own site, same as before this existed.
  const siteId = searchParams.get('siteId') || undefined;
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
  const [executingBulkApprove, setExecutingBulkApprove] = useState(false);
  const [bulkApproveResult, setBulkApproveResult] = useState(null);
  // True only while re-fetching a bulk run whose HTTP response the browser
  // abandoned — the work itself is still fine, so this must never read as an
  // error state (see executeSafeFixes' catch).
  const [recoveringExecution, setRecoveringExecution] = useState(false);
  // True while executionResult reflects an in-progress job (server still
  // shipping items) rather than a finished one — lets the banner below show
  // "shipping…" instead of a premature "done" the instant the POST above
  // responds, now that the route responds as soon as selection finishes
  // rather than after the whole batch ships (see the route's own comment).
  const [isRunningExecution, setIsRunningExecution] = useState(false);
  const executionPollRef = useRef(null);
  const [loadingExecutionJobDetail, setLoadingExecutionJobDetail] = useState(false);
  const [shippingId, setShippingId] = useState(null);
  const [recheckingId, setRecheckingId] = useState(null);
  const [recheckResult, setRecheckResult] = useState(null);
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

  const loadRecs = () => api.actionCenter.recommendations(siteId).then((data) => {
    setRecs(data);
    const categories = [...new Set((data?.items || []).map((item) => item.category || 'Technical Fixes'))];
    if (categories.length > 0) setActiveCategory(categories[0]);
  }).catch(() => setRecs({ items: [], lastAnalyzedAt: {} }));

  const loadDrafts = () => api.actionCenter.drafts({}, siteId).then((data) => {
    setDrafts(data);
    if (data && data.length > 0) setSelectedDraftItem(data[0]);
  }).catch(() => setDrafts([]));

  const [todayStats, setTodayStats] = useState(null); // null | { shipped, failed, batchLimit }
  // The server's real cap (routes/action-center.js's SAFE_FIX_BATCH_LIMIT),
  // not a copy of it. Null until the mount fetch lands, which is why the
  // button below falls back to the plain eligible count rather than a
  // hardcoded guess for that first moment.
  const safeFixBatchLimit = todayStats?.batchLimit ?? null;
  const loadTodayStats = () => api.actionCenter.todayExecutionStats(siteId).then(setTodayStats).catch(() => {});

  useEffect(() => { loadRecs(); loadDrafts(); loadTodayStats(); }, [siteId]);
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
      const fresh = await api.actionCenter.refresh(range.start, range.end, siteId);
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
      // findingId must be the recommendation's real finding key (item.findingIds[0]),
      // NOT item.id (the recommendation's own row id) — getRecommendations only
      // hides a recommendation once one of its real finding_ids has a draft, so a
      // draft stamped with the row id instead can never match and the
      // recommendation stays "open" forever even after its PR ships. Confirmed
      // live: two shipped drafts (PR #53) whose recommendations never closed.
      const draft = await api.actionCenter.generate(item.generatorId, item.params, item.source, item.findingIds?.[0], siteId);
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

  // Phase 4 M3 — bulk-ships every open, safe-tier recommendation (up to the
  // server's SAFE_FIX_BATCH_LIMIT) through the existing Generate -> Submit ->
  // Approve chain automatically, one execution job, one shared branch/PR.
  // Manual-tier recommendations (landing pages, pricing, nav, etc.) are never
  // included — they always need the stepped flow below.
  //
  // Sends NO limit on purpose: the cap is the server's to decide (see
  // routes/action-center.js's SAFE_FIX_BATCH_LIMIT), and this component reads
  // the same number back via todayStats.batchLimit purely to label the button.
  // Passing one from here is what let the UI promise 15 while the server was
  // free to ship a different number.
  // Stops an in-flight poll (a fresh run superseding it, or the component
  // unmounting) so two intervals never race on the same jobId.
  const stopExecutionPoll = () => {
    if (executionPollRef.current) {
      clearInterval(executionPollRef.current);
      executionPollRef.current = null;
    }
  };
  useEffect(() => stopExecutionPoll, []);

  // Polls one execution_jobs row every 4s until it leaves 'preparing'/
  // 'executing', updating the banner with live shipped/failed counts each
  // tick. Split out from executeSafeFixes below so both the fresh-run path
  // and the timed-out-POST recovery path (which also lands on a possibly
  // still-running job) drive the same loop.
  const pollExecutionJob = (jobId) => {
    stopExecutionPoll();
    setIsRunningExecution(true);
    const tick = async () => {
      try {
        const job = await api.actionCenter.getExecutionJob(jobId, siteId);
        const shipped = job.items.filter((i) => i.status === 'approved').length;
        const failed = job.items.filter((i) => i.status === 'failed').length;
        setExecutionResult({ job, shipped, failed });
        if (job.status !== 'preparing' && job.status !== 'executing') {
          stopExecutionPoll();
          setIsRunningExecution(false);
          setExecutingSafeFixes(false);
          loadRecs();
          loadDrafts();
          loadTodayStats();
        }
      } catch {
        // A transient poll failure (network blip) isn't the run failing —
        // just skip this tick and try again on the next one.
      }
    };
    tick();
    executionPollRef.current = setInterval(tick, 4000);
  };

  const executeSafeFixes = async () => {
    setExecutingSafeFixes(true);
    setError(null);
    setExecutionResult(null);
    setExecutionJobDetail(null);
    try {
      // The route now responds as soon as candidate selection finishes (a few
      // DB reads, never an LLM call or git push) — not after the whole batch
      // ships — so this normally resolves in well under a second even for a
      // full 60-item run. What follows is deciding whether there's a
      // background job to watch.
      const result = await api.actionCenter.executeSafeFixes(undefined, siteId);
      if (!result.job || result.job.status === 'completed' || result.job.status === 'failed') {
        // Nothing to ship (already-drafted/paced down to zero) — done already.
        setExecutionResult(result);
        setExecutingSafeFixes(false);
        loadRecs();
        loadDrafts();
        loadTodayStats();
      } else {
        pollExecutionJob(result.job.id);
      }
    } catch (e) {
      // Only reachable now if the fast prepare step itself times out or the
      // request never lands — the shipping loop itself can no longer strand
      // the browser, since the response comes back before it starts. Recover
      // by asking for the run we already started (it's the site's latest
      // bulk job) and picking up its poll instead of reporting a failure.
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      if (timedOut) {
        setRecoveringExecution(true);
        try {
          const recovered = await api.actionCenter.latestExecutionJob(siteId);
          if (recovered.job) {
            pollExecutionJob(recovered.job.id);
          } else {
            setError('The safe-fix run is still going. It will finish on the server — reload in a few minutes to see the result.');
            setExecutingSafeFixes(false);
          }
        } catch {
          setError('The safe-fix run is still going on the server. Reload in a few minutes to see which fixes shipped and which failed.');
          setExecutingSafeFixes(false);
        } finally {
          setRecoveringExecution(false);
        }
      } else {
        setError(e.message || 'Execute Safe Fixes failed');
        setExecutingSafeFixes(false);
      }
    }
  };

  // "Approve All Pending" — ships every draft awaiting approval (any
  // generator, not just safe-tier) as one batch branch/push/PR instead of
  // one push per draft. Before this, approving several blog-outline (or
  // other content) drafts one at a time meant each one raced the previous
  // draft's still-building Vercel preview and usually cancelled it.
  const bulkApproveAllPending = async () => {
    setExecutingBulkApprove(true);
    setError(null);
    setBulkApproveResult(null);
    try {
      const result = await api.actionCenter.bulkApproveDrafts(undefined, siteId);
      setBulkApproveResult(result);
      loadDrafts();
      loadTodayStats();
    } catch (e) {
      setError(e.message || 'Approve All Pending failed');
    } finally {
      setExecutingBulkApprove(false);
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
      setExecutionJobDetail(await api.actionCenter.getExecutionJob(jobId, siteId));
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
      setActiveDraft(await api.actionCenter.draft(draftId, siteId));
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
      const draft = await api.actionCenter.approveAndShip(item.id, siteId);
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

  // On-demand re-verification of a single finding — for when the user just
  // fixed something on their own site and doesn't want to wait for its page
  // to come back around in that agent's daily rotation batch (see
  // recommendation-coordinator.js's recheckRecommendation).
  const recheckNow = async (item) => {
    setRecheckingId(item.id);
    setRecheckResult(null);
    try {
      const result = await api.actionCenter.recheckRecommendation(item.id, siteId);
      setRecheckResult({ id: item.id, ...result });
      if (result.changed) {
        setSelectedRecommendation(null);
        loadRecs();
      }
    } catch (e) {
      setError(`${item.tag}: ${e.message || 'Re-check failed'}`);
    } finally {
      setRecheckingId(null);
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

      {recoveringExecution && (
        <div className="text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 leading-relaxed flex items-center gap-2">
          <Zap size={14} className="text-slate-400 shrink-0 animate-pulse" />
          <span>This batch is taking longer than the browser will wait — the run is still going on the server. Fetching its result…</span>
        </div>
      )}

      {executionResult && (
        <div className={`text-xs font-semibold rounded-2xl px-4 py-3 leading-relaxed border ${isRunningExecution ? 'text-slate-600 bg-slate-50 border-slate-200' : 'text-emerald-700 bg-emerald-50 border-emerald-100'}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              {isRunningExecution
                ? <Zap size={14} className="text-slate-400 shrink-0 animate-pulse" />
                : <CheckCircle2 size={14} className="text-emerald-550 shrink-0" />}
              <span>
                {isRunningExecution
                  ? `Shipping… ${executionResult.shipped + executionResult.failed} of ${executionResult.job?.items?.length ?? '?'} processed so far (${executionResult.shipped} shipped${executionResult.failed > 0 ? `, ${executionResult.failed} failed` : ''}).`
                  : <>Shipped {executionResult.shipped}{executionResult.failed > 0 ? `, ${executionResult.failed} failed` : ''} — committed to one branch{executionResult.job?.pr_url ? ', one PR opened' : ''}.</>}
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

          {/* Scrolls rather than truncates: a full batch can fail every item,
              and a silently cut-off list would read as "only these failed."
              Every failure stays reachable, the banner just stops pushing the
              rest of the page down. */}
          {executionJobDetail && (
            <div className="mt-3 pt-3 border-t border-emerald-100 space-y-1.5 max-h-80 overflow-y-auto">
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
                title={safeEligibleCount === 0
                  ? 'No safe-tier recommendations open right now'
                  : `Ship up to ${safeFixBatchLimit ?? safeEligibleCount} of ${safeEligibleCount} safe recommendations — one branch, one PR, no per-item clicks`}
                className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2.5 py-1.5 rounded-xl text-white transition hover:scale-[1.02] active:scale-[0.98] shadow-sm disabled:opacity-50 disabled:hover:scale-100 cursor-pointer ml-auto shrink-0"
                style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}
              >
                <Zap size={11} className={executingSafeFixes ? 'animate-pulse' : ''} />
                {executingSafeFixes ? '…' : Math.min(safeFixBatchLimit ?? safeEligibleCount, safeEligibleCount)}
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
                              {/* Most blocked_kinds mean the server really does refuse the draft,
                                  so this must not wear the "Safe — auto-eligible" badge that
                                  promises the opposite ('design-degraded' is the one exception —
                                  see blockedMetaFor/the action-button logic below — but even it
                                  still isn't risk-tier 'safe', so this exclusion is harmless for
                                  it too). The reason itself is stated in the detail panel. */}
                              {item.blockedReason ? (() => {
                                const meta = blockedMetaFor(item);
                                const BlockedIcon = meta.icon;
                                return (
                                  <span className={`shrink-0 flex items-center gap-0.5 text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full ${
                                    meta.className === 'blue' ? 'bg-sky-50 border border-sky-100 text-sky-600' : 'bg-amber-50 border border-amber-100 text-amber-600'
                                  }`}>
                                    <BlockedIcon size={8} /> {meta.className === 'blue' ? 'In progress' : 'Blocked'}
                                  </span>
                                );
                              })() : item.riskTier === 'safe' && (
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
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-slate-400 font-mono">{visibleDrafts?.length || 0} visible</span>
                  {pendingApprovalCount > 0 && (
                    <button
                      onClick={bulkApproveAllPending}
                      disabled={executingBulkApprove}
                      title={`Approve all ${pendingApprovalCount} pending draft(s) as one batch push/PR instead of one at a time`}
                      className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2.5 py-1.5 rounded-xl text-white transition hover:scale-[1.02] active:scale-[0.98] shadow-sm disabled:opacity-50 disabled:hover:scale-100 cursor-pointer shrink-0"
                      style={{ background: 'linear-gradient(135deg,#6366f1,#4f46e5)' }}
                    >
                      <Zap size={11} className={executingBulkApprove ? 'animate-pulse' : ''} />
                      {executingBulkApprove ? '…' : `Approve All (${pendingApprovalCount})`}
                    </button>
                  )}
                </div>
              </div>
              {bulkApproveResult && (
                <div className="px-4 py-2.5 border-b border-slate-100 bg-indigo-50/50 flex items-center justify-between gap-2 text-[10px] font-bold text-indigo-700">
                  <span>
                    Shipped {bulkApproveResult.shipped}{bulkApproveResult.failed > 0 ? `, ${bulkApproveResult.failed} failed` : ''} — committed to one branch{bulkApproveResult.job?.pr_url ? ', one PR opened' : ''}.
                  </span>
                  {bulkApproveResult.job?.pr_url && (
                    <a href={bulkApproveResult.job.pr_url} target="_blank" rel="noreferrer" className="underline shrink-0">View PR</a>
                  )}
                </div>
              )}

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
                            {d.input?.page || d.input?.filePath || d.input?.topic || d.input?.market || d.input?.city || ''}
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
                            {d.input?.page || d.input?.filePath || d.input?.topic || d.input?.market || d.input?.city || ''}
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
                          {selectedRecommendation.blockedReason ? (() => {
                            const meta = blockedMetaFor(selectedRecommendation);
                            const BlockedIcon = meta.icon;
                            return (
                              <span className={`flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full ${
                                meta.className === 'blue' ? 'bg-sky-50 border border-sky-100 text-sky-600' : 'bg-amber-50 border border-amber-100 text-amber-600'
                              }`}>
                                <BlockedIcon size={9} /> {meta.badge}
                              </span>
                            );
                          })() : selectedRecommendation.riskTier === 'safe' ? (
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
                      {/* The server already refuses to draft this (422 in
                          routes/action-center.js) — this states WHY, and what to do
                          about it, instead of leaving the user to discover it by
                          clicking a button that always fails. */}
                      {selectedRecommendation.blockedReason && (() => {
                        const meta = blockedMetaFor(selectedRecommendation);
                        const BlockedIcon = meta.icon;
                        const blue = meta.className === 'blue';
                        return (
                          <div className={`flex items-start gap-2.5 rounded-2xl p-4 border ${blue ? 'bg-sky-50/70 border-sky-150' : 'bg-amber-50/70 border-amber-150'}`}>
                            <BlockedIcon size={13} className={`shrink-0 mt-0.5 ${blue ? 'text-sky-600' : 'text-amber-600'}`} />
                            <div className="min-w-0">
                              <div className={`text-[10px] font-black uppercase tracking-widest mb-1 ${blue ? 'text-sky-700' : 'text-amber-700'}`}>{meta.heading}</div>
                              <p className={`text-xs font-medium leading-relaxed ${blue ? 'text-sky-900/85' : 'text-amber-900/85'}`}>{selectedRecommendation.blockedReason}</p>
                            </div>
                          </div>
                        );
                      })()}

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

                      {/* blog-image (agents/blog-image.js) keys on the post's real repo
                          path, not a page URL — a distinct label so a raw path is never
                          shown as though it were a live URL. */}
                      {selectedRecommendation.params.filePath && (
                        <div>
                          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Affected File</div>
                          <div className="bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 font-mono text-[10.5px] text-indigo-650 truncate max-w-full">
                            {selectedRecommendation.params.filePath}
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
                    {(selectedRecommendation.params?.page || selectedRecommendation.params?.href) && (
                      <button
                        onClick={() => recheckNow(selectedRecommendation)}
                        disabled={recheckingId === selectedRecommendation.id}
                        title="Re-examine this page/link right now instead of waiting for its next scheduled scan"
                        className="flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider px-4 py-3 rounded-xl text-slate-600 bg-white border border-slate-200 transition hover:border-slate-350 disabled:opacity-60 cursor-pointer"
                      >
                        <RefreshCw size={12} className={recheckingId === selectedRecommendation.id ? 'animate-spin' : ''} />
                        {recheckingId === selectedRecommendation.id ? 'Re-checking…' : 'Re-check Now'}
                      </button>
                    )}
                    {recheckResult?.id === selectedRecommendation.id && !recheckResult.changed && (
                      <span className="text-[10px] font-bold text-slate-450 italic">Still detected — not fixed yet.</span>
                    )}
                    {selectedRecommendation.riskTier === 'safe' && (
                      <button
                        onClick={() => generate(selectedRecommendation)}
                        disabled={generatingId === selectedRecommendation.id || shippingId === selectedRecommendation.id}
                        className="text-[10.5px] font-black uppercase tracking-wider px-4 py-3 rounded-xl text-slate-600 bg-white border border-slate-200 transition hover:border-slate-350 disabled:opacity-60 cursor-pointer"
                      >
                        {generatingId === selectedRecommendation.id ? 'Drafting…' : 'Preview Draft Only'}
                      </button>
                    )}
                    {/* 'design-degraded' is deliberately excluded here: unlike
                        every other blocked_kind, it's a failed Design Context
                        run, which never stops drafting (action-center.js's
                        generateDraft falls back to the generator's zero-config
                        template) — swapping out the real button for a
                        disabled pill would contradict the banner above, which
                        already says "not blocked." */}
                    {selectedRecommendation.blockedReason && selectedRecommendation.blockedKind !== 'design-degraded' ? (() => {
                      const meta = blockedMetaFor(selectedRecommendation);
                      const BlockedIcon = meta.icon;
                      const blue = meta.className === 'blue';
                      return (
                        <span className={`flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider px-5 py-3 rounded-xl border ${
                          blue ? 'text-sky-700 bg-sky-50 border-sky-150' : 'text-amber-700 bg-amber-50 border-amber-150'
                        }`}>
                          <BlockedIcon size={12} /> {blue ? 'In progress — nothing to do' : 'Blocked — resolve the setup above'}
                        </span>
                      );
                    })() : (
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
                    )}
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
                          {selectedDraftItem.input?.page || selectedDraftItem.input?.filePath || selectedDraftItem.input?.topic || selectedDraftItem.input?.market || selectedDraftItem.input?.city || 'Root Context'}
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
          siteId={siteId}
          onClose={() => setActiveDraft(null)}
          onSaved={(updated) => { setActiveDraft(updated); loadDrafts(); if (updated.rolled_back_at) loadRecs(); }}
          onDeleted={() => { setActiveDraft(null); loadDrafts(); loadRecs(); }}
        />
      )}
    </div>
  );
}
