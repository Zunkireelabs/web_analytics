import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import DraftPreview from './DraftPreview.jsx';
import Button from './Button.jsx';
import Badge from './Badge.jsx';
import {
  GitBranch,
  Check,
  AlertTriangle,
  Trash2,
  Copy,
  Edit3,
  Sparkles,
  X,
  ExternalLink,
  Save,
  Undo,
  RotateCcw,
} from 'lucide-react';
import { STATUS } from '../lib/palette.js';

// Callout styles shared by every banner/notice in the modal body.
const CALLOUT = 'mx-5 mt-4 rounded-control px-3.5 py-3 text-[13px]';
const CALLOUT_TONE = {
  error: 'bg-[#fdecec] text-[#b42318]',
  warning: 'bg-[#fdf3e1] text-[#8a5300]',
  info: 'bg-muted text-text',
  success: 'bg-[#e8f7ee] text-[#1a7f4b]',
};
const LINK = 'font-medium underline underline-offset-2';

const ACTION_LABELS = {
  'meta-title': 'Meta Title & Description', faq: 'FAQ', schema: 'Schema Markup',
  'internal-links': 'Internal Links', 'blog-outline': 'Blog Post',
  'landing-page': 'Landing Page', translation: 'Translation', 'llms-txt': 'llms.txt & AI-Crawler Robots.txt',
  'security-headers': 'Security Headers', 'html-lang': 'Page Language',
  viewport: 'Viewport Meta Tag', canonical: 'Canonical Tag', 'robots-fix': 'Robots.txt Fix',
  'open-graph': 'Open Graph Tags', 'broken-link-fix': 'Broken Link Removal', 'redirect-fix': 'Redirect Link Fix',

  'expand-content': 'Content Expansion', sitemap: 'Sitemap Update', 'geo-audit': 'GEO Audit Report', 'direct-answer': 'Direct Answer',

  'cookie-policy': 'Cookie Policy', 'privacy-policy': 'Privacy Policy', 'terms-of-service': 'Terms of Service',
  'duplicate-id-fix': 'Duplicate ID Fix Plan', breadcrumbs: 'Breadcrumbs Schema',
  'schema-repair': 'Structured Data Repair', 'alt-text': 'Image Alt Text',
};

// Must match server/store/drafts.js's MERGE_MANDATORY_TYPES EXACTLY — every
// type here has a real merge-to-stage strategy, so "mark implemented
// manually" (the legacy bypass button) must never show for it.
//
// This is a hand-maintained mirror of a server constant, and it had already
// drifted: qa-content, analytics-install, breadcrumbs, schema-repair and
// alt-text were added server-side but never here, so this modal offered
// "Mark Implemented manually" for all five while markDraftImplemented()'s
// own `NOT (action_type = ANY($3))` guard silently refused the update — a
// button that could only ever fail. Re-synced below; if you add a type to
// the server list, add it here in the same commit.
//
// duplicate-id-fix is deliberately absent from BOTH lists even though it now
// has a real merge strategy: it's the one type whose implementer legitimately
// refuses (see PARTIAL_AUTO_APPLY_TYPES), and a human applying those
// refusals by hand still needs the manual bypass.
const MERGE_MANDATORY_TYPES = ['meta-title', 'faq', 'llms-txt', 'schema', 'internal-links', 'landing-page', 'blog-outline', 'translation', 'security-headers', 'html-lang', 'viewport', 'canonical', 'robots-fix', 'open-graph', 'broken-link-fix', 'redirect-fix', 'expand-content', 'qa-content', 'analytics-install', 'sitemap', 'cookie-policy', 'privacy-policy', 'terms-of-service', 'breadcrumbs', 'schema-repair', 'alt-text'];

// Generator ids with NO implementer registered at all, by deliberate design
// (see generators/geo-audit.js): the output is a report for a human to read,
// never a file diff or a branch. Kept in sync with
// server/implementers/*.js's `handles` arrays (nothing there lists this id)
// so the UI never invites an action that can only ever fail with "No
// implementer wired".
//
// duplicate-id-fix used to be listed here and no longer is. That was correct
// when written (2026-08-06), but 2026-08-07 added
// implementers/lib/duplicate-id-inject.js and put 'duplicate-id-fix' into
// backend.js's `handles` — the list here was never updated, which left the
// backend's real push/preview/merge path unreachable, since the human's
// "Push Branch" click is its only entry point (risk-tiers.js keeps this
// generator at 'manual' tier, so the Execute Safe Fixes auto-chain never
// reaches it either). See PARTIAL_AUTO_APPLY_TYPES below.
const ADVISORY_ONLY_TYPES = ['geo-audit'];

// Has a real implementer, but one that only auto-applies a narrow,
// provably-safe subset and deliberately REFUSES the rest rather than
// guessing (duplicate-id-fix: only an SVG paint-def id referenced solely by
// `url(#id)` inside its own <svg>; anything a CSS rule, JS call, or #anchor
// might reference refuses, all-or-nothing per draft). So the push path is
// offered — it genuinely works for that shape — but never presented as
// guaranteed, and the manual fallback stays available for the refusals.
const PARTIAL_AUTO_APPLY_TYPES = ['duplicate-id-fix'];

// label + Badge tone for the header status pill.
const STATUS_INFO = {
  draft: { label: 'Draft · never published', tone: 'grey' },
  edited: { label: 'Edited draft · never published', tone: 'grey' },
  submitted_for_approval: { label: 'Submitted for approval', tone: 'amber' },
  approved: { label: 'Approved · not yet live', tone: 'green' },
  branch_pushed: { label: 'Branch pushed · review before opening PR', tone: 'outline' },
  merged_to_stage: { label: 'Merged to stage', tone: 'green' },
  pr_opened: { label: 'PR opened · review & merge on GitHub', tone: 'outline' },
  implemented: { label: 'Implemented · live on main', tone: 'green' },
};

// The Approval Gate's persisted validation_status (server/routes/lib/
// approval-gate.js + server/implementers/lib/rendering-gate.js) — never
// just informational, so this always renders the specific reason a check
// failed and, for the client-build check, a real link to that repo's own
// CI logs (the only place a build-time failure can actually be diagnosed —
// this app never runs that build itself, see the action-center-onboarding
// skill's §1b). `ok: null` (clientBuild before a PR/check exists yet, or
// before this repo has the rendering-validation workflow installed) reads
// as "pending," never as a silent pass.
const VALIDATION_LABELS = {
  qualityGate: 'Quality Gate',
  renderingConfig: 'Rendering Config',
  clientBuild: 'Client Build (CI)',
};

function ValidationBadge({ checkKey, check }) {
  if (!check) return null;
  const label = VALIDATION_LABELS[checkKey] || checkKey;
  if (check.ok === true) {
    return (
      <Badge tone="outline"><Check size={12} strokeWidth={2.5} style={{ color: STATUS.good.color }} /> {label}</Badge>
    );
  }
  if (check.ok === false) {
    return (
      <Badge tone="outline"><X size={12} strokeWidth={2.5} style={{ color: STATUS.critical.color }} /> {label}</Badge>
    );
  }
  // ok === null/undefined — not yet known (clientBuild before a PR exists,
  // or before this repo has the CI workflow installed).
  return (
    <Badge tone="outline"><AlertTriangle size={12} style={{ color: STATUS.warning.color }} /> {label}</Badge>
  );
}

// One banner, shown whenever ANY known check has failed — badges for every
// check that's been evaluated so far (pass/fail/pending), plus the specific
// blocking reason and, for a failed/pending client-build check, a direct
// link to that repo's real CI Checks tab. Rendered even for a draft that
// isn't blocked right now (e.g. clientBuild still pending on an open PR) so
// "first-class, not informational" holds for the whole lifecycle, not just
// the moment of rejection.
function ValidationStatusBanner({ draft }) {
  const v = draft.validation_status;
  if (!v) return null;
  const checks = ['qualityGate', 'renderingConfig', 'clientBuild'].filter((k) => v[k]);
  if (!checks.length) return null;

  const failing = checks.find((k) => v[k].ok === false);
  const pending = checks.find((k) => v[k].ok !== true && v[k].ok !== false);
  const allPassing = checks.every((k) => v[k].ok === true);

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border text-[13px]">
      {checks.map((k) => <ValidationBadge key={k} checkKey={k} check={v[k]} />)}
      {failing && (
        <div className="w-full flex items-start gap-2" style={{ color: '#b42318' }}>
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span><span className="font-medium">{VALIDATION_LABELS[failing]} failed:</span> {v[failing].error || 'validation failed'}</span>
        </div>
      )}
      {v.clientBuild?.mergedDespiteNotPassing && (
        <div className="w-full flex items-start gap-2" style={{ color: '#8a5300' }}>
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span><span className="font-medium">Merged despite a non-passing build check</span> — this was merged on GitHub before (or without) the rendering-validation check passing. Check the live page.</span>
        </div>
      )}
      {v.clientBuild?.checksUrl && (v.clientBuild.ok !== true || v.clientBuild.mergedDespiteNotPassing) && (
        <a href={v.clientBuild.checksUrl} target="_blank" rel="noopener noreferrer" className="w-full inline-flex items-center gap-1 text-primary font-medium hover:underline">
          View client CI logs <ExternalLink size={12} />
        </a>
      )}
      {allPassing && !v.clientBuild?.mergedDespiteNotPassing && (
        <div className="w-full flex items-center gap-1.5" style={{ color: '#1a7f4b' }}>
          <Check size={14} strokeWidth={2.5} /> All checked validations passing.
        </div>
      )}
    </div>
  );
}

// matchedVia/matchedFrom only ever appear on broken-link-fix results
// (server/implementers/backend.js's computeBrokenLinkFixMerge) — undefined,
// and so invisible, for every other action type.
function MatchedViaCaption({ matchedVia, matchedFrom }) {
  if (!matchedVia) return null;
  return (
    <p className="text-xs text-faint px-3 py-2 border-b border-border">
      {matchedVia === 'code-search'
        ? 'Found via GitHub code search — not in url_file_map, review carefully before merging.'
        : `Found on source page: ${matchedFrom}`}
    </p>
  );
}

const DIFF_RING = { boxShadow: 'inset 0 0 0 1px var(--border-2)' };
const DIFF_LINES = 'font-mono text-xs leading-5 px-3 py-2 whitespace-pre-wrap max-h-48 overflow-y-auto custom-scrollbar';

function FileDiffBlock({ filePath, renderMode, live, changedRegions, oldContent, newContent, matchedVia, matchedFrom }) {
  const header = (
    <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-[#fcfcfb] border-b border-border font-mono text-xs text-text">
      <GitBranch size={12} className="text-faint" />
      <span>Target:</span>
      <code className="font-mono text-fg break-all">{filePath}</code>
      {renderMode === 'schema-only' && (
        <Badge tone="outline" className="font-sans">Schema only — visible page content unchanged</Badge>
      )}
    </div>
  );

  // Implemented drafts have nothing pending to diff against — this shows
  // what's actually sitting in the live marker(s) right now, read fresh
  // every time this loads (backend.js's previewLiveMarkerContent), not a
  // before/after.
  if (live) {
    return (
      <div className="mt-4 rounded-control overflow-hidden animate-slide-down" style={DIFF_RING}>
        {header}
        <MatchedViaCaption matchedVia={matchedVia} matchedFrom={matchedFrom} />
        {changedRegions.map((r, i) => (
          <div key={i} className="border-b border-border last:border-0">
            {r.field && (
              <div className="bg-[#fcfcfb] px-3 py-2 border-b border-border font-mono text-xs text-text">
                Field: {r.field}
              </div>
            )}
            <div className="bg-[#e8f7ee] text-[#14532d]">
              <p className="text-xs px-3 pt-2 flex items-center gap-1">
                <Check size={12} strokeWidth={2.5} /> <span>Currently live</span>
              </p>
              <pre className={DIFF_LINES}>{r.content}</pre>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const regions = changedRegions?.length
    ? changedRegions
    : [{ field: filePath, before: oldContent, after: newContent }];
  return (
    <div className="mt-4 rounded-control overflow-hidden animate-slide-down" style={DIFF_RING}>
      {header}
      <MatchedViaCaption matchedVia={matchedVia} matchedFrom={matchedFrom} />
      {regions.map((r, i) => (
        <div key={i} className="border-b border-border last:border-0">
          {r.field && r.field !== filePath && (
            <div className="bg-[#fcfcfb] px-3 py-2 border-b border-border font-mono text-xs text-text">
              Field: {r.field}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
            <div className="bg-[#fdecec] text-[#7f1d1d]">
              <p className="text-xs px-3 pt-2">− Current staged</p>
              <pre className={DIFF_LINES}>{r.before || '(empty)'}</pre>
            </div>
            <div className="bg-[#e8f7ee] text-[#14532d]">
              <p className="text-xs px-3 pt-2">+ Draft proposal</p>
              <pre className={DIFF_LINES}>{r.after}</pre>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// `result.files` (an array) only ever appears on broken-link-fix results —
// every other action type keeps returning the legacy single-file shape
// ({filePath, oldContent, newContent, ...}) and renders identically to
// before this existed.
function FileDiffPreview({ result }) {
  if (Array.isArray(result.files)) {
    return (
      <div className="space-y-6">
        {result.files.map((f, i) => (
          <FileDiffBlock key={f.filePath + i} {...f} live={result.live} />
        ))}
      </div>
    );
  }
  return <FileDiffBlock {...result} />;
}

export default function DraftModal({ draft, siteId, onClose, onSaved, onDeleted }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(draft.content, null, 2));
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [copyLabel, setCopyLabel] = useState('Copy');
  const [error, setError] = useState(null);
  const [filePreview, setFilePreview] = useState(null); // null | 'loading' | {ok, ...} | {ok:false, error}
  // Set when a server call tells us this exact draft row no longer exists
  // (404) — most often because it was discarded from another tab/session
  // while this modal stayed open on stale data. Once true, every action
  // button is disabled (they'd just 404 too) in favor of one clear way out.
  const [draftGone, setDraftGone] = useState(false);
  const status = STATUS_INFO[draft.status] || STATUS_INFO.draft;
  const [showDiff, setShowDiff] = useState(true);

  // Escape closes the modal, like the shared Modal/Drawer.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selectTitle = async (title) => {
    try {
      const updated = await api.actionCenter.saveDraft(draft.id, { ...draft.content, selectedTitle: title }, siteId);
      onSaved(updated);
    } catch (e) {
      setError(e.message || 'Could not select title');
    }
  };

  const loadFilePreview = async () => {
    setFilePreview('loading');
    try {
      const result = await api.actionCenter.previewDraft(draft.id, siteId);
      setFilePreview(result);
    } catch (e) {
      if (e.status === 404) setDraftGone(true);
      setFilePreview({ ok: false, error: e.message || 'Preview failed' });
    }
  };

  const transition = async (action) => {
    setTransitioning(true);
    setError(null);
    setRenderModeConfirm(null);
    try {
      const updated = await action();
      onSaved(updated);
    } catch (e) {
      if (e.status === 404) setDraftGone(true);
      setError(e.message || 'Action failed');
    } finally {
      setTransitioning(false);
    }
  };

  // Approve/Push Branch are no longer "fire once" — the backend inspects the
  // live target page fresh every call and can come back genuinely unsure
  // (render-mode-uncertain), which isn't a normal failure: it's a real
  // question that needs a human answer before either action can proceed.
  // null | { call: 'approve'|'push-branch', reason, confidence, suggestedMode }
  const [renderModeConfirm, setRenderModeConfirm] = useState(null);
  const [rollbackPr, setRollbackPr] = useState(null); // null | {prNumber, prUrl}

  // Fallback for when local state is empty (fresh modal open / page reload)
  // but the backend already persisted a render-mode-uncertain result
  // (draft.render_mode_confirm — see recordApplyFailure) — without this, a
  // failure from an earlier session/render would only ever show the plain
  // red apply_error banner, with no way to act on it short of retrying the
  // exact same action to reproduce the failure. `call` is always
  // 'push-branch' here since both persist sites only ever fire post-approval.
  const persistedRenderModeConfirm = !renderModeConfirm && draft.render_mode_confirm
    ? { call: 'push-branch', ...draft.render_mode_confirm }
    : null;
  const activeRenderModeConfirm = renderModeConfirm || persistedRenderModeConfirm;

  const runPublishAction = async (call, renderMode) => {
    setTransitioning(true);
    setError(null);
    try {
      const apiFn = call === 'approve' ? api.actionCenter.approveDraft : api.actionCenter.pushBranch;
      const updated = await apiFn(draft.id, renderMode, siteId);
      setRenderModeConfirm(null);
      onSaved(updated);
    } catch (e) {
      if (e.reason === 'render-mode-uncertain' && !renderMode) {
        if (e.status && e.status !== 'submitted_for_approval') {
          // The backend told us this draft's real status already moved past
          // what the retry prompt assumes (approve() flipped it to
          // 'approved' before apply() hit this error) — refresh from the
          // server instead of showing a stale "Use Visible"/"Use
          // Schema-only" prompt for a state that's no longer true.
          setRenderModeConfirm(null);
          api.actionCenter.draft(draft.id, siteId).then(onSaved).catch(() => setError(e.message || 'Action failed'));
        } else {
          setRenderModeConfirm({ call, reason: e.message, confidence: e.confidence, suggestedMode: e.suggestedMode });
        }
      } else {
        setRenderModeConfirm(null);
        setError(e.message || 'Action failed');
      }
    } finally {
      setTransitioning(false);
    }
  };

  // Not a plain transition() — POST .../rollback opens a real PR (never
  // merges straight to production) and returns {ok, prNumber, prUrl,
  // branchName}, not a draft row. The draft itself is unchanged until a
  // human merges that PR on GitHub, so there's nothing to re-fetch — just
  // surface the PR link so staff can go review/merge it.
  const rollback = async () => {
    setTransitioning(true);
    setError(null);
    try {
      const result = await api.actionCenter.rollback(draft.id, siteId);
      setRollbackPr({ prNumber: result.prNumber, prUrl: result.prUrl });
      // The backend just marked this draft rolled_back_at, which reopens its
      // finding in Recommendations (getDraftedFindingIds) — refetch so the
      // caller's onSaved reloads Recs, not just Drafts.
      api.actionCenter.draft(draft.id, siteId).then(onSaved).catch(() => {});
    } catch (e) {
      setError(e.message || 'Rollback failed');
    } finally {
      setTransitioning(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(draft.content, null, 2));
      setCopyLabel('Copied ✓');
      setTimeout(() => setCopyLabel('Copy'), 1500);
    } catch {
      setCopyLabel('Copy failed');
      setTimeout(() => setCopyLabel('Copy'), 1500);
    }
  };

  const startEdit = () => { setText(JSON.stringify(draft.content, null, 2)); setError(null); setEditing(true); };

  const save = async () => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Not valid JSON — fix formatting before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.actionCenter.saveDraft(draft.id, parsed, siteId);
      setEditing(false);
      onSaved(updated);
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm('Discard this draft? This cannot be undone.')) return;
    try {
      await api.actionCenter.deleteDraft(draft.id, siteId);
      onDeleted(draft.id);
    } catch (e) {
      if (e.status === 404) { setDraftGone(true); return; }
      setError(e.message || 'Delete failed');
    }
  };

  // Abandons this draft (keeps it around for the audit trail, unlike
  // Discard which deletes the row outright) and — because getDraftedFindingIds
  // excludes 'abandoned' drafts — its finding immediately reopens back in
  // Recommendations for another attempt.
  const sendBackToRecommendation = async () => {
    if (!confirm('Send this back to Recommendations? This draft will be abandoned and the finding will reopen in Recs.')) return;
    setTransitioning(true);
    setError(null);
    try {
      await api.actionCenter.reject(draft.id, 'sent_back_to_recommendations', siteId);
      onDeleted(draft.id);
    } catch (e) {
      if (e.status === 404) { setDraftGone(true); return; }
      setError(e.message || 'Failed to send back to Recommendations');
    } finally {
      setTransitioning(false);
    }
  };

  const leftActions = draft.status !== 'implemented';
  // Rollback only ever shows for a merged/implemented draft; the single
  // control covers both statuses (identical conditions in each).
  const rollbackable = draft.status === 'merged_to_stage' || draft.status === 'implemented';
  const dangerGhost = 'text-[#b42318] hover:text-[#912018]';

  return createPortal(
    <div className="fixed inset-0 z-50 bg-neutral-900/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-[720px] max-h-[90vh] flex flex-col bg-white rounded-card overflow-hidden"
        style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 30px 60px -20px rgba(0,0,0,.12)' }}
        role="dialog" aria-label="Draft"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
          <span className="w-8 h-8 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0"
            style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>
            <Sparkles size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">
              {ACTION_LABELS[draft.action_type] || draft.action_type}
            </div>
            <Badge tone={status.tone} className="mt-1">{status.label}</Badge>
          </div>
          <Button variant="ghost" size="sm" icon aria-label="Close" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        {/* Modal Scrollable Content Body (banners + content) */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {/* Error/Notice banners */}
          {draftGone && (
            <div className={`${CALLOUT} ${CALLOUT_TONE.error} flex items-center justify-between gap-3 flex-wrap`}>
              <span className="flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span><span className="font-medium">This draft no longer exists on the server.</span> It was likely discarded or already handled from another tab or session — this view is showing stale data. Close it and refresh the list.</span>
              </span>
              <Button variant="light" size="sm" onClick={() => onDeleted(draft.id)}>Close &amp; refresh</Button>
            </div>
          )}
          {draft.apply_error && (
            <div className={`${CALLOUT} ${CALLOUT_TONE.error} flex items-start gap-2`}>
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span><span className="font-medium">Deployment attempt failed:</span> {draft.apply_error}</span>
            </div>
          )}

          {draft.stage_merge_url && (
            <div className={`${CALLOUT} ${CALLOUT_TONE.info} flex items-center justify-between gap-3`}>
              <a href={draft.stage_merge_url} target="_blank" rel="noopener noreferrer" className={`${LINK} text-primary flex items-center gap-1`}>
                View merge commit on GitHub <ExternalLink size={12} />
              </a>
              <span className="font-medium flex items-center gap-1" style={{ color: STATUS.good.text }}>
                <Check size={12} strokeWidth={2.5} /> Merged to stage
              </span>
            </div>
          )}

          {draft.pr_url && (
            <div className={`${CALLOUT} ${CALLOUT_TONE.info} flex items-center justify-between gap-3 flex-wrap`}>
              <a href={draft.pr_url} target="_blank" rel="noopener noreferrer" className={`${LINK} text-primary flex items-center gap-1`}>
                View PR on GitHub <ExternalLink size={12} />
              </a>
              <div className="flex items-center gap-2">
                {draft.sibling_count > 0 && (
                  <span title={`This branch also contains ${draft.sibling_count} other approved draft(s) pushed today.`}>
                    <Badge tone="amber">Shared · +{draft.sibling_count}</Badge>
                  </span>
                )}
                {draft.status === 'implemented' ? (
                  <span className="font-medium flex items-center gap-1" style={{ color: STATUS.good.text }}>
                    <Check size={12} strokeWidth={2.5} /> Merged to main
                  </span>
                ) : (
                  <span className="font-medium" style={{ color: STATUS.warning.text }}>
                    {draft.pr_state === 'closed' ? 'PR closed' : 'Awaiting merge'}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Real evidence from GitHub's own mergeable_state (recorded by
              checkDraftPrStatus — manual click, webhook, or the hourly poll
              fallback) — this is what would have caught today's incident days
              earlier instead of only at merge time. 'dirty' is GitHub's own
              "has real, unresolvable-by-GitHub conflicts" signal. */}
          {draft.status === 'pr_opened' && draft.pr_mergeable_state === 'dirty' && (
            <div className={`${CALLOUT} ${CALLOUT_TONE.error} flex items-start gap-2`}>
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span><span className="font-medium">This PR has conflicts:</span> its branch has diverged from the target branch and can no longer auto-merge on GitHub. Resolve the conflict there before merging.</span>
            </div>
          )}

          <ValidationStatusBanner draft={draft} />

          {draft.rolled_back_at && !rollbackPr && (
            <div className={`${CALLOUT} ${CALLOUT_TONE.warning} flex items-start gap-2`}>
              <Undo size={14} className="shrink-0 mt-0.5" />
              <span><span className="font-medium">Rolled back:</span> a revert PR was opened for this draft. Its finding has reopened in Recommendations for another attempt.</span>
            </div>
          )}

          {rollbackPr && (
            <div className={`${CALLOUT} ${CALLOUT_TONE.info} flex items-center justify-between gap-3`}>
              <a href={rollbackPr.prUrl} target="_blank" rel="noopener noreferrer" className={`${LINK} text-primary flex items-center gap-1`}>
                View rollback PR on GitHub <ExternalLink size={12} />
              </a>
              <span className="font-medium" style={{ color: STATUS.warning.text }}>Awaiting merge</span>
            </div>
          )}

          {draft.gsc_notification && !draft.gsc_notification.skipped && (
            <div className={`${CALLOUT} flex items-center gap-2 ${draft.gsc_notification.sitemapSubmit?.ok ? CALLOUT_TONE.success : CALLOUT_TONE.warning}`}>
              {draft.gsc_notification.sitemapSubmit?.ok ? (
                <>
                  <Check size={14} className="shrink-0" strokeWidth={2.5} />
                  <span>Sitemap resubmitted to Search Console — this page is prioritized for a faster recrawl.</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={14} className="shrink-0" />
                  <span>Search Console sitemap resubmission didn't go through: {draft.gsc_notification.sitemapSubmit?.error || 'unknown error'}.</span>
                </>
              )}
            </div>
          )}

          <div className="px-4 py-3 space-y-5">
            {editing ? (
              <div className="space-y-2">
                <div className="text-xs flex items-center justify-between gap-3 flex-wrap">
                  <span className="font-medium text-fg">Direct JSON editor</span>
                  <span style={{ color: STATUS.critical.text }}>Caution: formatting errors will reject compile</span>
                </div>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className="w-full h-64 sm:h-96 max-h-[50vh] rounded-control px-3 py-2.5 font-mono text-xs leading-5 text-fg bg-white outline-none transition-shadow shadow-[0_0_0_1px_var(--input),0_1px_2px_rgba(0,0,0,.03)] focus:shadow-[0_0_0_1px_var(--primary),0_0_0_4px_var(--primary-tint)]"
                  spellCheck={false}
                />
              </div>
            ) : (
              <>
                <DraftPreview actionType={draft.action_type} content={draft.content}
                  onSelectTitle={draft.action_type === 'meta-title' && draft.status !== 'implemented' ? selectTitle : undefined} />

                {/* GitHub File Diff Preview Section — for an implemented draft
                    this shows the real, currently-live content instead of a
                    pending diff (see FileDiffPreview's `result.live` branch).
                    Skipped entirely for advisory-only types (no implementer
                    exists, so there is no file diff to fetch — see
                    ADVISORY_ONLY_TYPES above) in favor of a plain explanation,
                    so this never invites a "No implementer wired" dead end. */}
                {ADVISORY_ONLY_TYPES.includes(draft.action_type) ? (
                  <div className="pt-5 border-t border-border">
                    <div className={`${CALLOUT_TONE.info} rounded-control px-3.5 py-3 text-[13px] flex items-start gap-2`}>
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      <p>
                        This is a report, not a file change — there's nothing here to push to your repo. Read the findings above and use the prioritized fix list to decide what to act on; each item names the generator that can draft the real fix for it.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="pt-5 border-t border-border space-y-4">
                    {/* Sets the expectation BEFORE the click rather than
                        letting a refusal come back as a bare error — the
                        refusal is the designed-for outcome here, not a fault
                        (see PARTIAL_AUTO_APPLY_TYPES above). */}
                    {PARTIAL_AUTO_APPLY_TYPES.includes(draft.action_type) && draft.status !== 'implemented' && (
                      <div className={`${CALLOUT_TONE.warning} rounded-control px-3.5 py-3 text-[13px] flex items-start gap-2`}>
                        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                        <p>
                          Only part of this plan can be applied automatically: a duplicate id on an SVG gradient/clip/mask that nothing outside its own <code className="font-mono text-xs">&lt;svg&gt;</code> references. If any id in the plan is referenced by a CSS selector, a JS call, or an <code className="font-mono text-xs">#anchor</code>, Push Branch will refuse the whole draft rather than half-rename the page — apply those by hand and mark this draft implemented instead.
                        </p>
                      </div>
                    )}
                    {draft.status === 'branch_pushed' && (
                      <div className={`${CALLOUT_TONE.info} rounded-control px-3.5 py-3 text-[13px] flex items-start gap-2`}>
                        <GitBranch size={14} className="shrink-0 mt-0.5" />
                        <p>
                          This branch has been pushed to GitHub. Review the real file diff below, then open a PR — a human still needs to review and merge it into <code className="font-mono text-xs">main</code> on GitHub before it's live.
                        </p>
                      </div>
                    )}
                    {draft.status === 'pr_opened' && (
                      <div className={`${CALLOUT_TONE.info} rounded-control px-3.5 py-3 text-[13px] flex items-start gap-2`}>
                        <GitBranch size={14} className="shrink-0 mt-0.5" />
                        <p>
                          A PR is open against <code className="font-mono text-xs">main</code>. Review and merge it on GitHub, then click Check PR Status here to mark this draft implemented.
                        </p>
                      </div>
                    )}

                    {!filePreview && (
                      <Button variant="light" onClick={loadFilePreview}>
                        <GitBranch size={14} /> {draft.status === 'implemented' ? 'Show what\'s live on GitHub' : 'Show real file diff from GitHub'}
                      </Button>
                    )}
                    {filePreview === 'loading' && (
                      <div className="text-[13px] text-faint">Fetching real git repository diff…</div>
                    )}
                    {filePreview && filePreview !== 'loading' && (
                      <div className="space-y-3">
                        <Button variant="ghost" size="sm" className="-ml-2.5" onClick={() => setShowDiff(!showDiff)} aria-expanded={showDiff}>
                          {showDiff ? 'Hide file diff' : 'Show file diff'}
                        </Button>

                        {showDiff && (
                          filePreview.ok ? <FileDiffPreview result={filePreview} /> : (
                            <div className={`${CALLOUT_TONE.warning} rounded-control px-3.5 py-3 text-[13px] flex items-center gap-2`}>
                              <AlertTriangle size={14} className="shrink-0" />
                              <span>{filePreview.error}</span>
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {error && (
              <div className={`${CALLOUT_TONE.error} rounded-control px-3.5 py-3 text-[13px] flex items-center gap-2`}>
                <AlertTriangle size={14} className="shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {activeRenderModeConfirm && (
              <div className="bg-muted text-text rounded-control p-4 text-[13px] space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: STATUS.warning.color }} />
                  <span>
                    <span className="font-medium text-fg">Render mode unclear</span>
                    {typeof activeRenderModeConfirm.confidence === 'number' && ` (${activeRenderModeConfirm.confidence}% confidence)`}
                    {': '}{activeRenderModeConfirm.reason}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-6">
                  <Button variant="light" onClick={() => runPublishAction(activeRenderModeConfirm.call, 'visible')} disabled={transitioning}>
                    Use visible
                  </Button>
                  <Button variant="light" onClick={() => runPublishAction(activeRenderModeConfirm.call, 'schema-only')} disabled={transitioning}>
                    Use schema-only
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer Controls */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3.5 border-t border-border bg-white">
          {draftGone ? (
            <Button variant="primary" className="ml-auto" onClick={() => onDeleted(draft.id)}>Close &amp; refresh</Button>
          ) : (
            <div className="flex flex-wrap items-center gap-1 w-full sm:w-auto">
              {leftActions && (
                <>
                  <Button variant="ghost" onClick={sendBackToRecommendation} disabled={transitioning}
                    title="Abandon this draft and reopen its finding in Recommendations">
                    <RotateCcw size={14} /> Send back to recommendation
                  </Button>
                  <Button variant="ghost" className={dangerGhost} onClick={remove}>
                    <Trash2 size={14} /> Discard draft
                  </Button>
                </>
              )}
              {!editing && rollbackable && draft.rollback_snapshot && (draft.status === 'implemented' || draft.status === 'merged_to_stage') && !draft.sibling_count && !draft.rolled_back_at && (
                <Button variant="ghost" className={dangerGhost} onClick={rollback} disabled={transitioning}
                  title="Restore this file to exactly what it was right before this draft's merge">
                  <Undo size={14} /> {transitioning ? 'Opening PR…' : 'Rollback'}
                </Button>
              )}
              {!editing && rollbackable && draft.rollback_snapshot && draft.sibling_count > 0 && (
                <span className="text-xs text-faint px-2" title="Rollback is disabled because this branch is shared with other drafts.">
                  Rollback unavailable (shared branch)
                </span>
              )}
            </div>
          )}

          {!draftGone && (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2 w-full sm:w-auto [&>button]:flex-1 sm:[&>button]:flex-none">
              {editing ? (
                <>
                  <Button variant="light" onClick={() => setEditing(false)}>Cancel</Button>
                  <Button variant="dark" onClick={save} disabled={saving}>
                    <Save size={14} /> {saving ? 'Saving…' : 'Save draft'}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="light" onClick={copy}>
                    <Copy size={14} /> {copyLabel}
                  </Button>

                  {(draft.status === 'draft' || draft.status === 'edited') && (
                    <>
                      <Button variant="light" onClick={startEdit}>
                        <Edit3 size={14} /> Edit
                      </Button>
                      <Button variant="primary" onClick={() => transition(() => api.actionCenter.submitDraft(draft.id, siteId))} disabled={transitioning}>
                        <Check size={14} strokeWidth={2.5} /> {transitioning ? 'Submitting…' : 'Submit for approval'}
                      </Button>
                    </>
                  )}

                  {draft.status === 'submitted_for_approval' && (
                    <Button variant="primary" onClick={() => runPublishAction('approve')} disabled={transitioning}>
                      <Check size={14} strokeWidth={2.5} /> {transitioning ? 'Publishing…' : 'Approve & publish'}
                    </Button>
                  )}

                  {draft.status === 'approved' && (
                    <>
                      {!MERGE_MANDATORY_TYPES.includes(draft.action_type) && (
                        <Button variant="light" onClick={() => transition(() => api.actionCenter.implementDraft(draft.id, siteId))} disabled={transitioning}>
                          Mark implemented manually
                        </Button>
                      )}
                      {!ADVISORY_ONLY_TYPES.includes(draft.action_type) && (
                        <Button variant="primary" onClick={() => runPublishAction('push-branch')} disabled={transitioning}>
                          <GitBranch size={14} /> {transitioning ? 'Pushing…' : 'Push branch'}
                        </Button>
                      )}
                    </>
                  )}

                  {draft.status === 'branch_pushed' && (
                    <>
                      <span className="text-xs font-mono text-text truncate max-w-[140px] hidden sm:inline-block bg-muted rounded-control px-2 py-1"
                        title={draft.branch_name}>
                        {draft.branch_name}
                      </span>
                      {draft.sibling_count > 0 && (
                        <span title={`This branch also contains ${draft.sibling_count} other approved draft(s) pushed today.`}>
                          <Badge tone="amber">Shared · +{draft.sibling_count}</Badge>
                        </span>
                      )}
                      <Button variant="primary" onClick={() => transition(() => api.actionCenter.openPr(draft.id, siteId))} disabled={transitioning}>
                        <GitBranch size={14} /> {transitioning ? 'Opening PR…' : 'Open PR'}
                      </Button>
                    </>
                  )}

                  {draft.status === 'pr_opened' && (
                    <>
                      <span className="text-xs text-faint max-w-[200px] leading-snug">
                        Waiting on a human to review and merge the PR on GitHub. This also refreshes the client build (CI) check above.
                      </span>
                      <Button variant="light" onClick={() => transition(() => api.actionCenter.checkPrStatus(draft.id, siteId))} disabled={transitioning}>
                        <Check size={14} strokeWidth={2.5} /> {transitioning ? 'Checking…' : 'Check PR status'}
                      </Button>
                    </>
                  )}

                  {draft.status === 'merged_to_stage' && (
                    <>
                      <span className="text-xs text-faint max-w-[200px] leading-snug">
                        Live on staging.
                      </span>
                      <Button variant="primary" onClick={() => transition(() => api.actionCenter.implementDraft(draft.id, siteId))} disabled={transitioning}>
                        Mark implemented
                      </Button>
                    </>
                  )}

                  {/* implemented is terminal for the transitions above, but a real
                      rollback_snapshot (captured at merge time) is still valid — the
                      merge that snapshot reverts happened regardless of whether this
                      draft was additionally marked implemented afterward. (Rollback
                      itself, for merged_to_stage and implemented alike, sits in the
                      left group above.) */}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
