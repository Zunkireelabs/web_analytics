import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, daysAgo, timeAgo } from '../api.js';
import DraftModal from '../components/DraftModal.jsx';
import PageToolbar from '../components/PageToolbar.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import Section from '../components/layout/Section.jsx';
import SegmentedTabs from '../components/SegmentedTabs.jsx';
import Button from '../components/Button.jsx';
import Badge from '../components/Badge.jsx';
import {
  AlertTriangle,
  Clock,
  CheckCircle2,
  ChevronRight,
  ArrowRight,
  History,
  Layers,
  Zap,
  GitPullRequest,
  XCircle,
  RefreshCw,
  Lock,
  Check,
} from 'lucide-react';
import { STATUS } from '../lib/palette.js';

const GENERATOR_META = {
  'meta-title': { label: 'Meta Titles' },
  faq: { label: 'FAQ Blocks' },
  schema: { label: 'Schema Markup' },
  'internal-links': { label: 'Internal Links' },
  'blog-outline': { label: 'Blog Posts' },
  'landing-page': { label: 'Landing Pages' },
  translation: { label: 'Translations' },
  'llms-txt': { label: 'llms.txt Files' },
  'security-headers': { label: 'Security Headers' },
  'html-lang': { label: 'Page Language' },
  viewport: { label: 'Viewport Meta Tag' },
  canonical: { label: 'Canonical Tags' },
  'robots-fix': { label: 'Robots.txt Fixes' },
  'open-graph': { label: 'Open Graph Tags' },
  'broken-link-fix': { label: 'Broken Link Removal' },
  'redirect-fix': { label: 'Redirect Fixes' },
  'expand-content': { label: 'Content Expansion' },
  sitemap: { label: 'Sitemap Updates' },

  'geo-audit': { label: 'GEO Audit Reports' },
  'direct-answer': { label: 'Direct Answers' },

  'cookie-policy': { label: 'Cookie Policy' },
  'privacy-policy': { label: 'Privacy Policy' },
  'terms-of-service': { label: 'Terms of Service' },

  'duplicate-id-fix': { label: 'Duplicate ID Fix Plans' },
  breadcrumbs: { label: 'Breadcrumbs Schema' },
  'schema-repair': { label: 'Structured Data Repairs' },
  'alt-text': { label: 'Image Alt Text' },
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
  seo: { label: 'SEO' },
  aeo: { label: 'AEO' },
  geo: { label: 'GEO' },
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

// Server: goal-alignment.js's five levels, on recommendations.goal_alignment
// (set at sync time by recommendation-coordinator.js, only when the site has
// an active goal). 'none'/'insufficient_evidence'/no active goal all read as
// "not tied to a goal" here — the distinction between them is a detector
// detail, not something the user acts on differently.
const GOAL_ALIGNMENT_META = {
  strong: { label: 'Strong fit' },
  partial: { label: 'Partial fit' },
  weak: { label: 'Weak fit' },
};

// Where a recommendation is in its life (server: recommendation-coordinator.js's
// deriveLifecycle). One card now persists through the whole lifecycle instead
// of vanishing the moment a draft exists and reappearing later as a brand-new
// entry — so the card has to say which part of that life it's in, or the list
// just looks like it grew duplicates.
//
// 'new' deliberately has no chip. Most of the list is new most of the time,
// and a badge on nearly every row is noise that makes the rows that DO carry
// state (in progress, retrying) harder to pick out. 'fixed' never reaches the
// UI — the server filters it off the active board.
const LIFECYCLE_META = {
  in_progress: { label: 'In progress', tone: 'grey' },
  retry: { label: 'Retry', tone: 'amber' },
};

// What the last failure means for what happens next, in the user's terms.
// Mirrors lib/attempt-classification.js's RETRY_POLICY: the difference
// between "we'll pick this up again on our own" and "this is waiting on you"
// is the single most useful thing a returning card can say, and it's exactly
// what the old UI could not express — a reappearing card looked identical
// whether the system was still trying or had quietly given up.
const RETRY_POLICY_COPY = {
  retry: 'A temporary problem stopped the last attempt. This will be tried again automatically.',
  needs_human: 'The last attempt needs something from you before it can succeed.',
  already_resolved: 'Something else already fixed this — it should drop off shortly.',
  item_defect: "The last attempt couldn't be applied cleanly to this page.",
  never: 'The last pull request was closed without merging, so this came back for another decision.',
};

const DRAFT_STATUS_LABEL = {
  draft: 'draft', edited: 'edited', submitted_for_approval: 'pending approval',
  approved: 'approved', branch_pushed: 'branch pushed', merged_to_stage: 'merged to stage',
  pr_opened: 'PR opened', implemented: 'implemented', abandoned: 'abandoned',
};

const STATUS_ORDER = ['draft', 'edited', 'submitted_for_approval', 'approved', 'branch_pushed', 'merged_to_stage', 'pr_opened', 'implemented'];

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

// Sentence-case draft status for Badges (DRAFT_STATUS_LABEL is lower-case, for prose).
const draftStatusText = (st) => { const l = DRAFT_STATUS_LABEL[st] || st; return l.charAt(0).toUpperCase() + l.slice(1); };

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// Human labels for the stepper (DRAFT_STATUS_LABEL is lower-case, for prose).
const STEP_LABEL = {
  draft: 'Draft', edited: 'Edited', submitted_for_approval: 'Submitted for approval', approved: 'Approved',
  branch_pushed: 'Branch pushed', merged_to_stage: 'Merged to stage', pr_opened: 'PR opened', implemented: 'Implemented',
};

// Draft status → Badge tone (list rows and detail header).
const DRAFT_TONE = {
  draft: 'grey', edited: 'grey', abandoned: 'grey',
  submitted_for_approval: 'amber',
  approved: 'green', implemented: 'green',
  branch_pushed: 'outline', merged_to_stage: 'outline', pr_opened: 'outline',
};

// Vertical checklist of the draft's path to staging. `implemented` reads as
// all-done (no "current" step).
function DraftStepper({ status }) {
  const idx = Math.max(0, STATUS_ORDER.indexOf(status));
  const allDone = status === 'implemented';
  return (
    <div aria-label={`Status: ${DRAFT_STATUS_LABEL[status] || status}`}>
      {STATUS_ORDER.map((s, i) => {
        const done = allDone || i < idx;
        const current = !allDone && i === idx;
        return (
          <div key={s} className="flex items-center gap-2.5 py-1.5 text-sm">
            {done ? (
              <span className="w-4 h-4 rounded-full bg-fg grid place-items-center shrink-0"><Check size={10} className="text-white" strokeWidth={3} /></span>
            ) : current ? (
              <span className="w-4 h-4 rounded-full bg-[#fdf3e1] shrink-0" style={{ boxShadow: `inset 0 0 0 4px ${STATUS.warning.color}` }} />
            ) : (
              <span className="w-4 h-4 rounded-full shrink-0" style={{ boxShadow: 'inset 0 0 0 1.5px #d4d4d4' }} />
            )}
            <span className={done ? 'text-text' : current ? 'font-medium text-fg' : 'text-faint'}>{STEP_LABEL[s]}</span>
            {current && <Badge tone="amber" className="ml-auto">Current</Badge>}
          </div>
        );
      })}
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
  // Exact tab-badge counts, loaded independently of `drafts` itself — the
  // unfiltered drafts list is capped server-side (listDraftsForBoard), so a
  // badge derived from that capped list would silently undercount once a
  // site's history grew past the cap. null = loading, never rendered as 0.
  const [draftCounts, setDraftCounts] = useState(null);
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
  }).catch((e) => {
    setDrafts([]);
    // Previously silent — a failed fetch here used to read as "Drafts (0)
    // / Done (0)", indistinguishable from a genuinely empty board. Real
    // counts (below) no longer depend on this call succeeding, but the
    // list itself failing to load is still worth telling a human about.
    setError(e.message || 'Could not load drafts');
  });

  const loadDraftCounts = () => api.actionCenter.draftCounts(siteId).then(setDraftCounts).catch(() => {});

  const [todayStats, setTodayStats] = useState(null); // null | { shipped, failed, batchLimit }
  // The server's real cap (routes/action-center.js's SAFE_FIX_BATCH_LIMIT),
  // not a copy of it. Null until the mount fetch lands, which is why the
  // button below falls back to the plain eligible count rather than a
  // hardcoded guess for that first moment.
  const safeFixBatchLimit = todayStats?.batchLimit ?? null;
  const loadTodayStats = () => api.actionCenter.todayExecutionStats(siteId).then(setTodayStats).catch(() => {});

  useEffect(() => { loadRecs(); loadDrafts(); loadDraftCounts(); loadTodayStats(); }, [siteId]);
  useEffect(() => { if (tab === 'drafts' || tab === 'implemented') { loadDrafts(); loadDraftCounts(); } }, [tab]);

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
      loadDraftCounts();
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
          loadDraftCounts();
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
        loadDraftCounts();
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
      loadDraftCounts();
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
      loadDraftCounts();
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
  // From the accurate server-side count, not the (now-capped, most-recent-
  // 150) implemented list — a site shipping more than that in a week would
  // otherwise silently undercount here.
  const implementedThisWeekCount = draftCounts?.implementedThisWeek
    ?? (drafts || []).filter((d) => d.status === 'implemented' && d.implemented_at >= daysAgo(7)).length;

  // Selected category items mapping
  const activeItems = activeCategory ? (grouped[activeCategory] || []) : [];
  const sortedItems = [...activeItems].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
  const activeMeta = activeCategory ? { label: activeCategory } : null;

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

  // Below lg the details panel sits under the list, so selecting a row scrolls
  // it into view (above lg it is a sticky right column and already visible).
  const detailsRef = useRef(null);
  const reveal = () => {
    if (window.matchMedia('(max-width: 1023px)').matches) {
      detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  const pickRecommendation = (item) => { setSelectedRecommendation(item); reveal(); };
  const pickDraft = (d) => { setSelectedDraftItem(d); reveal(); };

  const tabCount = (n) => (n !== undefined ? <span className="text-faint ml-1">{n}</span> : null);
  const tabOptions = [
    { value: 'recommendations', label: <>Recommendations{tabCount(recs?.items.length)}</> },
    // From the accurate server-side counts (drafts/counts), not the
    // board list's own length — that list is capped server-side
    // (listDraftsForBoard) so history can't grow the page unbounded
    // again the way it did before; the badges must still be right.
    { value: 'drafts', label: <>Drafts{tabCount(draftCounts?.nonImplemented ?? nonImplementedDrafts?.length)}</> },
    { value: 'implemented', label: <>Done{tabCount(draftCounts?.implemented ?? implementedDrafts.length)}</> },
  ];

  const plural = (n, one, many) => (n === 1 ? one : many);
  const introTitle = tab === 'recommendations'
    ? (recs === null ? 'Loading recommendations…'
      : highPriorityCount > 0 ? `${highPriorityCount} high-priority fixes are waiting` : 'No high-priority fixes right now')
    : tab === 'drafts'
      ? (pendingApprovalCount > 0
        ? `${pendingApprovalCount} draft${pendingApprovalCount === 1 ? '' : 's'} ${plural(pendingApprovalCount, 'is', 'are')} waiting for approval`
        : 'No drafts waiting for approval')
      : `${implementedThisWeekCount} change${implementedThisWeekCount === 1 ? '' : 's'} shipped this week`;
  const introSubtitle = tab === 'recommendations'
    ? `${recs?.items.length ?? 0} recommendations from your agents. ${safeEligibleCount} are safe to ship automatically; review the rest before they go to staging.`
    : tab === 'drafts'
      ? 'Review each draft, then approve it to push a branch and open a pull request.'
      : 'Changes your agents shipped to your site, newest first.';

  const kpis = [
    { label: 'Recommendations', value: recs?.items.length ?? 0, sub: `across ${Object.keys(grouped).length} categories` },
    { label: 'High priority', value: highPriorityCount, sub: 'fix these first' },
    { label: 'Needs review', value: pendingApprovalCount, sub: 'drafts waiting on a person' },
    { label: 'Auto-eligible', value: safeEligibleCount, sub: 'safe to ship automatically' },
  ];

  const dateInput = 'h-8 px-2.5 rounded-control bg-white text-[13px] font-medium text-fg min-w-0 flex-1 md:flex-none';

  // One badge per recommendation describing its state. Lifecycle first: a card
  // with work actually in flight, or one that has come back after a failed
  // attempt, is describing its own state more usefully than the risk tier can.
  // Blocked still wins over both — it's the one state where nothing is going to
  // happen without someone acting. Most blocked_kinds mean the server really
  // does refuse the draft, so a blocked item must never wear the "Safe" badge.
  const stateBadge = (item, detailed) => {
    if (LIFECYCLE_META[item.lifecycle] && !item.blockedReason) {
      const meta = LIFECYCLE_META[item.lifecycle];
      return (
        <Badge tone={meta.tone} className="shrink-0">
          {meta.label}{item.lifecycle === 'retry' && item.attemptCount > 1 ? ` ${item.attemptCount}×` : ''}
        </Badge>
      );
    }
    if (item.blockedReason) {
      const meta = blockedMetaFor(item);
      const blue = meta.className === 'blue';
      return <Badge tone={blue ? 'outline' : 'amber'} className="shrink-0">{detailed ? meta.badge : blue ? 'In progress' : 'Blocked'}</Badge>;
    }
    if (item.riskTier === 'safe') return <Badge tone="green" className="shrink-0">{detailed ? 'Safe · auto-eligible' : 'Safe'}</Badge>;
    return detailed ? <Badge tone="amber" className="shrink-0">Manual review required</Badge> : null;
  };

  const priorityTone = { high: 'red', medium: 'amber', low: 'grey' };
  const rowCls = (selected) => `w-full flex items-center gap-3 border-b border-border text-left hover:bg-[#fafafa] ${selected ? 'bg-primary-tint' : ''}`;
  const rowRing = (selected) => (selected ? { boxShadow: 'inset 2px 0 0 var(--primary)' } : undefined);
  const draftTarget = (d) => d.input?.page || d.input?.filePath || d.input?.topic || d.input?.market || d.input?.city || '';

  const Fact = ({ label, children }) => (
    <div className="grid grid-cols-1 md:grid-cols-[130px_1fr] gap-0.5 md:gap-3 px-4 py-3 border-b border-border text-sm">
      <dt className="text-faint">{label}</dt>
      <dd className="text-fg min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
  const callout = 'mx-5 my-3 rounded-control px-3.5 py-3 text-[13px]';
  const link = 'text-primary font-medium underline-offset-2 hover:underline';

  const sel = selectedRecommendation;
  const selMeta = sel?.blockedReason ? blockedMetaFor(sel) : null;
  const selBlue = selMeta?.className === 'blue';
  const alignment = sel ? GOAL_ALIGNMENT_META[sel.goalAlignment?.level] : null;

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12">
      <PageToolbar>
        <SegmentedTabs options={tabOptions} value={tab} onChange={setTab} />
        {tab === 'recommendations' && recs && (
          // Source filter — purely a display filter over the same
          // recommendations feed; Generate Draft/Drafts/Approval/PR logic
          // below is untouched.
          <SegmentedTabs options={SOURCE_FILTERS} value={sourceFilter} onChange={setSourceFilter} />
        )}
        <div className="flex items-center gap-2 w-full md:w-auto">
          <input type="date" value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
            className={dateInput} style={{ boxShadow: 'var(--ring)' }} aria-label="Start date" />
          <span className="text-faint shrink-0">→</span>
          <input type="date" value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
            className={dateInput} style={{ boxShadow: 'var(--ring)' }} aria-label="End date" />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Live "today" counters — distinct from the Run button's live
              eligible-count: that's "how many could ship right now," this is
              "how many actually did today," pulled from
              execution_job_recommendations (server/store/execution-jobs.js). */}
          {tab === 'recommendations' && recs && todayStats && (todayStats.shipped > 0 || todayStats.failed > 0) && (
            <span className="text-[13px] text-faint" title="Shipped / failed today, across all Execute Safe Fixes and Approve & Ship runs">
              {todayStats.shipped} shipped today
              {todayStats.failed > 0 && <span style={{ color: STATUS.critical.text }}> · {todayStats.failed} failed</span>}
            </span>
          )}
          <Button variant="light" onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
          {tab === 'recommendations' && recs && (
            <Button variant="primary" onClick={executeSafeFixes} disabled={executingSafeFixes || safeEligibleCount === 0}
              title={safeEligibleCount === 0
                ? 'No safe-tier recommendations open right now'
                : `Ship up to ${safeFixBatchLimit ?? safeEligibleCount} of ${safeEligibleCount} safe recommendations — one branch, one PR, no per-item clicks`}>
              <Zap size={14} />
              {executingSafeFixes ? 'Running…' : `Run ${Math.min(safeFixBatchLimit ?? safeEligibleCount, safeEligibleCount)} safe fixes`}
            </Button>
          )}
          {tab === 'drafts' && pendingApprovalCount > 0 && (
            <Button variant="primary" onClick={bulkApproveAllPending} disabled={executingBulkApprove}
              title={`Approve all ${pendingApprovalCount} pending draft(s) as one batch push/PR instead of one at a time`}>
              <Zap size={14} />
              {executingBulkApprove ? '…' : `Approve all pending (${pendingApprovalCount})`}
            </Button>
          )}
        </div>
      </PageToolbar>

      <PageIntro title={introTitle} subtitle={(tab === 'recommendations' ? recs !== null : drafts !== null) ? introSubtitle : null} />

      {error && (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3 mb-6 flex items-start gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {recoveringExecution && (
        <div className="rounded-card bg-muted text-text text-sm px-4 py-3 mb-6 flex items-start gap-2">
          <Zap size={14} className="shrink-0 mt-0.5" />
          <span>This batch is taking longer than the browser will wait — the run is still going on the server. Fetching its result…</span>
        </div>
      )}

      {executionResult && (
        <div className={`rounded-card text-sm px-4 py-3 mb-6 ${isRunningExecution ? 'bg-muted text-text' : 'bg-[#e8f7ee] text-[#1a7f4b]'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              {isRunningExecution
                ? <Zap size={14} className="shrink-0" />
                : <CheckCircle2 size={14} className="shrink-0" />}
              <span>
                {isRunningExecution
                  ? `Shipping… ${executionResult.shipped + executionResult.failed} of ${executionResult.job?.items?.length ?? '?'} processed so far (${executionResult.shipped} shipped${executionResult.failed > 0 ? `, ${executionResult.failed} failed` : ''}).`
                  : <>Shipped {executionResult.shipped}{executionResult.failed > 0 ? `, ${executionResult.failed} failed` : ''} — committed to one branch{executionResult.job?.pr_url ? ', one PR opened' : ''}.</>}
              </span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              {executionResult.failed > 0 && executionResult.job?.id && (
                <Button variant="light" size="sm" onClick={toggleExecutionFailures} disabled={loadingExecutionJobDetail}>
                  {loadingExecutionJobDetail ? 'Loading…' : <>{executionResult.failed} failed</>}
                </Button>
              )}
              {executionResult.job?.pr_url && (
                <a href={executionResult.job.pr_url} target="_blank" rel="noreferrer" className="btn btn--light btn--sm">
                  <GitPullRequest size={12} /> View PR
                </a>
              )}
              <Button variant="ghost" size="sm" icon aria-label="Dismiss" onClick={() => { setExecutionResult(null); setExecutionJobDetail(null); }}>×</Button>
            </span>
          </div>

          {/* Scrolls rather than truncates: a full batch can fail every item,
              and a silently cut-off list would read as "only these failed."
              Every failure stays reachable, the banner just stops pushing the
              rest of the page down. */}
          {executionJobDetail && (
            <div className="mt-3 space-y-1.5 max-h-80 overflow-y-auto">
              {executionJobDetail.items.filter((it) => it.status === 'failed').map((it) => {
                const Row = it.draft_id ? 'button' : 'div';
                return (
                  <Row
                    key={it.id}
                    type={it.draft_id ? 'button' : undefined}
                    onClick={it.draft_id ? () => openFailedDraft(it.draft_id) : undefined}
                    className={`w-full flex items-start gap-2 bg-white rounded-control px-3 py-2 text-[13px] text-left ${it.draft_id ? 'cursor-pointer' : ''}`}
                  >
                    <XCircle size={13} className="shrink-0 mt-0.5" style={{ color: STATUS.critical.color }} />
                    <span>
                      <span className="font-medium text-fg">{it.recommendation_type}</span>
                      {it.page ? <span className="text-text"> — {it.page}</span> : null}
                      <span className="block text-text mt-0.5">{it.error || 'No error message recorded'}</span>
                      {it.draft_id && (
                        <span className="block text-primary font-medium mt-1">Open draft</span>
                      )}
                    </span>
                  </Row>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'drafts' && bulkApproveResult && (
        <div className="rounded-card bg-[#e8f7ee] text-[#1a7f4b] text-sm px-4 py-3 mb-6 flex flex-wrap items-center justify-between gap-2">
          <span>
            Shipped {bulkApproveResult.shipped}{bulkApproveResult.failed > 0 ? `, ${bulkApproveResult.failed} failed` : ''} — committed to one branch{bulkApproveResult.job?.pr_url ? ', one PR opened' : ''}.
          </span>
          {bulkApproveResult.job?.pr_url && (
            <a href={bulkApproveResult.job.pr_url} target="_blank" rel="noreferrer" className="btn btn--light btn--sm shrink-0">
              <GitPullRequest size={12} /> View PR
            </a>
          )}
        </div>
      )}

      <KpiStrip items={kpis} loading={recs === null} />

      <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr] items-start mt-3">
        {/* ============ LEFT: lists ============ */}
        {tab === 'recommendations' && (
          <Section tray className="min-w-0" title="Recommendations" subtitle="Grouped by category · open a group to see its fixes">
            <div className="border-t border-border">
              {recs === null ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="px-4 py-3 border-b border-border last:border-0"><div className="h-4 bg-muted rounded-control animate-pulse" /></div>
                ))
              ) : Object.keys(grouped).length === 0 ? (
                <div className="text-sm text-faint text-center py-12">No recommendations in this range.</div>
              ) : (
                Object.entries(grouped).map(([category, items]) => {
                  const open = activeCategory === category;
                  return (
                    <div key={category}>
                      <button type="button" aria-expanded={open} onClick={() => setActiveCategory(category)}
                        className="w-full flex items-center gap-2.5 px-4 py-3 border-b border-border text-sm text-left">
                        <ChevronRight size={12} className={`text-faint shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                        <span className={open ? 'font-medium text-fg' : 'text-text'}>{category}</span>
                        <span className="text-xs text-text px-[7px] py-px rounded-full" style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)' }}>{items.length}</span>
                        {open && <span className="ml-auto text-xs text-faint">Priority</span>}
                      </button>
                      {open && (
                        <>
                          {/* Unlike the Drafts/Done lists below (which already cap at
                              max-h-[360px] overflow-y-auto), this one had no scroll
                              bound — "Show all" expanding to a dozen-plus entries just
                              grew the whole card (and page) instead of scrolling
                              internally, burying the details panel far below the fold
                              on mobile. */}
                          <div className="overflow-y-auto max-h-[360px]">
                            {(showAllRecommendations ? sortedItems : sortedItems.slice(0, 4)).map((item) => {
                              const selected = selectedRecommendation?.id === item.id;
                              const level = item.priority === 'high' ? 3 : item.priority === 'medium' ? 2 : 1;
                              const itemUrl = item.url || item.params?.page;
                              const path = itemUrl ? pagePathFor(itemUrl) : null;
                              return (
                                <button key={item.id} type="button" onClick={() => pickRecommendation(item)}
                                  aria-current={selected ? 'true' : undefined}
                                  className={`${rowCls(selected)} pl-10 pr-4 py-2.5`} style={rowRing(selected)}>
                                  <span className="flex items-end gap-[2px] shrink-0" aria-label={`${item.priority || 'low'} priority`} role="img">
                                    {[5, 8, 12].map((h, k) => (
                                      <i key={k} className="block w-[3px] rounded-[1px]" style={{ height: h, background: k < level ? 'var(--fg)' : '#d4d4d4' }} />
                                    ))}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium text-fg truncate">{titleFor(item)}</span>
                                    <span className="block text-xs text-faint truncate mt-px">{item.reason}</span>
                                  </span>
                                  {stateBadge(item, false)}
                                  {BUCKET_META[item.bucket] && <Badge tone="outline" className="shrink-0">{BUCKET_META[item.bucket].label}</Badge>}
                                  {path && (
                                    <span className="hidden md:inline text-xs text-text px-2 py-0.5 rounded-[6px] max-w-[180px] truncate"
                                      style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)' }}>{path}</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                          {sortedItems.length > 4 && (
                            <div className="pl-10 py-1.5 border-b border-border">
                              <Button variant="ghost" size="sm" onClick={() => setShowAllRecommendations(!showAllRecommendations)}>
                                {showAllRecommendations ? 'Show fewer' : `Show all ${sortedItems.length}`}
                              </Button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </Section>
        )}

        {tab === 'drafts' && (
          <Section tray className="min-w-0" title="Drafts" subtitle="Generated fixes moving towards your site">
            <div className="border-t border-border">
              {nonImplementedDrafts && nonImplementedDrafts.length > 0 && (
                <div className="px-4 py-2.5 border-b border-border overflow-x-auto no-scrollbar">
                  <SegmentedTabs value={statusFilter} onChange={setStatusFilter}
                    options={STATUS_FILTERS.map((f) => ({
                      value: f.value,
                      label: <>{f.label}<span className="text-faint ml-1">{f.value ? nonImplementedDrafts.filter((d) => d.status === f.value).length : nonImplementedDrafts.length}</span></>,
                    }))} />
                </div>
              )}
              {drafts === null ? (
                <div className="py-10 text-center text-sm text-faint">Loading list…</div>
              ) : visibleDrafts.length === 0 ? (
                <div className="py-10 text-center text-sm text-faint">No drafts matching status.</div>
              ) : (
                <div className="overflow-y-auto max-h-[360px]">
                  {visibleDrafts.map((d) => {
                    const meta = GENERATOR_META[d.action_type] || { label: d.action_type };
                    const selected = selectedDraftItem?.id === d.id;
                    return (
                      <button key={d.id} type="button" onClick={() => pickDraft(d)} aria-current={selected ? 'true' : undefined}
                        className={`${rowCls(selected)} px-4 py-3`} style={rowRing(selected)}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-fg">{meta.label}</span>
                          <span className="block font-mono text-xs text-faint truncate">{draftTarget(d)}</span>
                        </span>
                        <Badge tone={DRAFT_TONE[d.status] || 'grey'} className="shrink-0">{draftStatusText(d.status)}</Badge>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Section>
        )}

        {tab === 'implemented' && (
          <Section tray className="min-w-0" title="Shipped" subtitle="Newest first">
            <div className="border-t border-border">
              {drafts === null ? (
                <div className="py-10 text-center text-sm text-faint">Loading history…</div>
              ) : implementedDrafts.length === 0 ? (
                <div className="py-10 text-center text-sm text-faint">Nothing shipped in this range yet.</div>
              ) : (
                <div className="overflow-y-auto max-h-[360px]">
                  {implementedDrafts.map((d) => {
                    const meta = GENERATOR_META[d.action_type] || { label: d.action_type };
                    const selected = selectedDraftItem?.id === d.id;
                    return (
                      <button key={d.id} type="button" onClick={() => pickDraft(d)} aria-current={selected ? 'true' : undefined}
                        className={`${rowCls(selected)} px-4 py-3`} style={rowRing(selected)}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-fg">{meta.label}</span>
                          <span className="block font-mono text-xs text-faint truncate">{draftTarget(d)}</span>
                        </span>
                        <Badge tone="green" className="shrink-0">Implemented</Badge>
                        {d.implemented_at && <span className="text-xs text-faint shrink-0">{timeAgo(d.implemented_at)}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ============ RIGHT: details ============ */}
        <div ref={detailsRef} className="min-w-0 lg:sticky lg:top-[72px] scroll-mt-20">
          {tab === 'recommendations' && (
            <Section tray title="Details" subtitle="The selected recommendation">
              <div className="border-t border-border">
                {sel ? (
                  <>
                    <div className="px-4 py-3 border-b border-border">
                      <h3 className="text-[15px] font-medium tracking-[-0.01em] text-fg break-words">{titleFor(sel)}</h3>
                      <div className="flex flex-wrap gap-1.5 mt-2.5">
                        {stateBadge(sel, true)}
                        {BUCKET_META[sel.bucket] && <Badge tone="outline">{BUCKET_META[sel.bucket].label}</Badge>}
                        {activeMeta && <Badge tone="outline">{activeMeta.label}</Badge>}
                      </div>
                    </div>

                    <dl>
                      <Fact label="Goal">
                        {alignment ? (
                          <>
                            <span className="font-medium">{alignment.label}</span>
                            <span className="block text-text mt-0.5">{sel.goalAlignment.rationale}</span>
                          </>
                        ) : (
                          <span className="text-faint">Not tied to an active business goal</span>
                        )}
                      </Fact>
                      <Fact label="Found by">{sel.agentName || activeMeta?.label || 'Website Check'}</Fact>
                      <Fact label="Reason">{sel.reason}</Fact>
                      {sel.params.page && <Fact label="Page"><span className="font-mono text-[13px] break-all">{sel.params.page}</span></Fact>}
                      {/* blog-image (agents/blog-image.js) keys on the post's real repo
                          path, not a page URL — a distinct label so a raw path is never
                          shown as though it were a live URL. */}
                      {sel.params.filePath && <Fact label="File"><span className="font-mono text-[13px] break-all">{sel.params.filePath}</span></Fact>}
                      <Fact label="Priority">
                        <Badge tone={priorityTone[sel.priority] || 'grey'}>{sel.priority === 'high' ? 'High' : sel.priority === 'medium' ? 'Medium' : 'Low'}</Badge>
                      </Fact>
                      {sel.expectedImpact?.label && (
                        <Fact label="Expected impact"><Badge tone="green">{sel.expectedImpact.label} impact</Badge></Fact>
                      )}
                    </dl>

                    {/* Work in flight. Names the PR so "in progress" is a claim the
                        user can click on and verify, rather than one they have to
                        trust — this card used to disappear entirely at this point,
                        which is how a draft stalled at 'branch_pushed' for three days
                        stayed invisible. */}
                    {sel.draft && sel.lifecycle === 'in_progress' && (
                      <div className={`${callout} bg-muted text-text`}>
                        <p className="flex items-center gap-1.5 font-medium text-fg">
                          <GitPullRequest size={14} />
                          {sel.draft.awaitingReview ? 'Waiting on your review' : 'Being worked on now'}
                        </p>
                        <p className="mt-1.5">
                          A fix for this is at{' '}
                          <span className="font-medium text-fg">{DRAFT_STATUS_LABEL[sel.draft.status] || sel.draft.status}</span>.
                          {sel.draft.awaitingReview
                            ? ' It needs someone to approve it before it can ship.'
                            : ' Nothing to do — it will finish on its own.'}
                        </p>
                        {sel.draft.prUrl && (
                          <a href={sel.draft.prUrl} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 mt-2 ${link}`}>
                            View pull request #{sel.draft.prNumber} <ArrowRight size={12} />
                          </a>
                        )}
                      </div>
                    )}

                    {/* Why this is back. A recommendation that has been attempted
                        before and returned is a different thing from a brand-new one,
                        and the user is owed the difference — including whether the
                        system intends to try again by itself. */}
                    {sel.attemptCount > 0 && sel.lifecycle !== 'in_progress' && (
                      <div className={`${callout} bg-[#fdf3e1] text-[#8a5300]`}>
                        <p className="flex items-center gap-1.5 font-medium">
                          <History size={14} />
                          Tried {sel.attemptCount}{sel.attemptCount === 1 ? ' time' : ' times'} before
                          {sel.lastAttemptAt ? ` · last ${timeAgo(sel.lastAttemptAt)}` : ''}
                        </p>
                        {RETRY_POLICY_COPY[sel.lastFailurePolicy] && (
                          <p className="mt-1.5">{RETRY_POLICY_COPY[sel.lastFailurePolicy]}</p>
                        )}
                        {/* The raw reason is already customer-safe by the time it is
                            stored (every writer passes it through lib/errors.js or an
                            author-written constant), and it is the one detail that
                            makes a repeat failure diagnosable rather than mysterious. */}
                        {sel.lastFailureReason && (
                          <p className="mt-1.5 break-words">Last outcome: {sel.lastFailureReason}</p>
                        )}
                      </div>
                    )}

                    {/* The server already refuses to draft this (422 in
                        routes/action-center.js) — this states WHY, and what to do
                        about it, instead of leaving the user to discover it by
                        clicking a button that always fails. */}
                    {sel.blockedReason && (() => {
                      const BlockedIcon = selMeta.icon;
                      return (
                        <div className={`${callout} flex items-start gap-2.5 ${selBlue ? 'bg-muted text-text' : 'bg-[#fdf3e1] text-[#8a5300]'}`}>
                          <BlockedIcon size={14} className="shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <div className={`font-medium mb-1 ${selBlue ? 'text-fg' : ''}`}>{selMeta.heading}</div>
                            <p>{sel.blockedReason}</p>
                          </div>
                        </div>
                      );
                    })()}

                    <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3.5">
                      {(sel.params?.page || sel.params?.href) && (
                        <Button variant="light" onClick={() => recheckNow(sel)} disabled={recheckingId === sel.id}
                          title="Re-examine this page/link right now instead of waiting for its next scheduled scan">
                          <RefreshCw size={14} className={recheckingId === sel.id ? 'animate-spin' : ''} />
                          {recheckingId === sel.id ? 'Re-checking…' : 'Re-check now'}
                        </Button>
                      )}
                      {recheckResult?.id === sel.id && !recheckResult.changed && (
                        <span className="text-[13px] text-faint">Still detected — not fixed yet.</span>
                      )}
                      {sel.riskTier === 'safe' && (
                        <Button variant="light" onClick={() => generate(sel)} disabled={generatingId === sel.id || shippingId === sel.id}>
                          {generatingId === sel.id ? 'Drafting…' : 'Preview draft only'}
                        </Button>
                      )}
                      {/* 'design-degraded' is deliberately excluded here: unlike
                          every other blocked_kind, it's a failed Design Context
                          run, which never stops drafting (action-center.js's
                          generateDraft falls back to the generator's zero-config
                          template) — swapping out the real button for a
                          disabled pill would contradict the note above, which
                          already says "not blocked." */}
                      {sel.blockedReason && sel.blockedKind !== 'design-degraded' ? (
                        <Badge tone={selBlue ? 'outline' : 'amber'}>
                          {selBlue ? 'In progress — nothing to do' : 'Blocked — resolve the setup above'}
                        </Badge>
                      ) : (
                        <Button variant="primary" onClick={() => sel.riskTier === 'safe' ? approveAndShip(sel) : generate(sel)}
                          disabled={generatingId === sel.id || shippingId === sel.id}>
                          {sel.riskTier === 'safe' ? (
                            <><Zap size={14} /> {shippingId === sel.id ? 'Shipping…' : 'Approve & ship'}</>
                          ) : (
                            generatingId === sel.id ? 'Drafting fix…' : 'Generate solution draft'
                          )}
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-faint text-center py-16">Select a recommendation to see its details.</div>
                )}
              </div>
            </Section>
          )}

          {(tab === 'drafts' || tab === 'implemented') && (
            <Section tray title="Details" subtitle="The selected draft">
              <div className="border-t border-border">
                {selectedDraftItem ? (
                  <>
                    <div className="px-4 py-3 border-b border-border">
                      <h3 className="text-[15px] font-medium tracking-[-0.01em] text-fg break-words">
                        {GENERATOR_META[selectedDraftItem.action_type]?.label || selectedDraftItem.action_type}
                      </h3>
                      <div className="flex flex-wrap gap-1.5 mt-2.5">
                        <Badge tone={DRAFT_TONE[selectedDraftItem.status] || 'grey'}>
                          {draftStatusText(selectedDraftItem.status)}
                        </Badge>
                        <Badge tone="outline">Action pipeline target</Badge>
                      </div>
                    </div>

                    <dl>
                      <Fact label="Target">
                        <span className="font-mono text-[13px] break-all">
                          {selectedDraftItem.input?.page || selectedDraftItem.input?.filePath || selectedDraftItem.input?.topic || selectedDraftItem.input?.market || selectedDraftItem.input?.city || 'Root Context'}
                        </span>
                      </Fact>
                      {selectedDraftItem.implemented_at && (
                        <Fact label="Merge timeline">{new Date(selectedDraftItem.implemented_at).toLocaleString()}</Fact>
                      )}
                    </dl>

                    <div className="px-4 py-3 border-b border-border">
                      <div className="text-[13px] text-faint mb-2">Progress to staging</div>
                      <DraftStepper status={selectedDraftItem.status} />
                    </div>

                    <div className="flex flex-wrap justify-end gap-2 px-4 py-3.5">
                      <Button variant={selectedDraftItem.status === 'implemented' ? 'light' : 'primary'} onClick={() => setActiveDraft(selectedDraftItem)}>
                        {selectedDraftItem.status === 'implemented' ? 'View draft' : 'Configure & deploy draft'}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-faint text-center py-16">Select a draft to see its details.</div>
                )}
              </div>
            </Section>
          )}
        </div>
      </div>

      {activeDraft && (
        <DraftModal
          key={activeDraft.id}
          draft={activeDraft}
          siteId={siteId}
          onClose={() => setActiveDraft(null)}
          onSaved={(updated) => { setActiveDraft(updated); loadDrafts(); loadDraftCounts(); if (updated.rolled_back_at) loadRecs(); }}
          onDeleted={() => { setActiveDraft(null); loadDrafts(); loadDraftCounts(); loadRecs(); }}
        />
      )}
    </div>
  );
}
