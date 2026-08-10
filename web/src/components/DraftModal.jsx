import { useState } from 'react';
import { api } from '../api.js';
import DraftPreview from './DraftPreview.jsx';
import { 
  FileText, 
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
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion
} from 'lucide-react';

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

const GENERATOR_COLORS = {
  'meta-title': '#6C63FF',
  faq: '#0ea5e9',
  schema: '#8b5cf6',
  'internal-links': '#14b8a6',
  'blog-outline': '#ec4899',
  'landing-page': '#c2410c',
  translation: '#06b6d4',
  'llms-txt': '#10b981',
  'security-headers': '#ef4444',
  'html-lang': '#0891b2',
  viewport: '#0d9488',
  canonical: '#7c3aed',
  'robots-fix': '#059669',
  'open-graph': '#db2777',
  'broken-link-fix': '#dc2626',
  'redirect-fix': '#d97706',
  'expand-content': '#4f46e5',
  sitemap: '#65a30d',
  'geo-audit': '#0ea5e9',
  'cookie-policy': '#f59e0b',
  'privacy-policy': '#d97706',
  'terms-of-service': '#b45309',
  'duplicate-id-fix': '#f97316',
  breadcrumbs: '#84cc16',
  'schema-repair': '#a855f7',
  'alt-text': '#f472b6',
};

// Kept in sync with server/store/drafts.js's MERGE_MANDATORY_TYPES — every
// type here has a real merge-to-stage strategy, so "mark implemented
// manually" (the legacy bypass button) must never show for it.
const MERGE_MANDATORY_TYPES = ['meta-title', 'faq', 'llms-txt', 'schema', 'internal-links', 'landing-page', 'blog-outline', 'translation', 'security-headers', 'html-lang', 'viewport', 'canonical', 'robots-fix', 'open-graph', 'broken-link-fix', 'redirect-fix', 'expand-content', 'sitemap', 'cookie-policy', 'privacy-policy', 'terms-of-service'];

// Generator ids with NO implementer registered at all, by deliberate design
// (see each generator's own file — duplicate-id-fix.js, geo-audit.js): the
// safe fix genuinely can't be known from a static page fetch (every CSS
// selector / JS call / anchor that might reference a renamed id, e.g.), so
// these only ever produce a plan for a developer to apply by hand in their
// own repo — never a real file diff or branch. Kept in sync with
// server/implementers/*.js's `handles` arrays (nothing there lists these
// two ids) so the UI never invites an action that can only ever 404 with
// "No implementer wired".
const ADVISORY_ONLY_TYPES = ['duplicate-id-fix', 'geo-audit'];

const STATUS_INFO = {
  draft: { label: 'Draft · never published', color: '#6366f1', bg: '#6366f10c', border: '#6366f120' },
  edited: { label: 'Edited draft · never published', color: '#f59e0b', bg: '#f59e0b0c', border: '#f59e0b20' },
  submitted_for_approval: { label: 'Submitted for approval', color: '#f59e0b', bg: '#f59e0b0c', border: '#f59e0b20' },
  approved: { label: 'Approved · not yet live', color: '#059669', bg: '#0596690c', border: '#05966920' },
  branch_pushed: { label: 'Branch pushed · review before opening PR', color: '#7c3aed', bg: '#7c3aed0c', border: '#7c3aed20' },
  merged_to_stage: { label: 'Merged to stage', color: '#2563eb', bg: '#2563eb0c', border: '#2563eb20' },
  pr_opened: { label: 'PR opened · review & merge on GitHub', color: '#2563eb', bg: '#2563eb0c', border: '#2563eb20' },
  implemented: { label: 'Implemented · live on main', color: '#16a34a', bg: '#16a34a0c', border: '#16a34a20' },
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
      <span className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
        <ShieldCheck size={11} /> {label}
      </span>
    );
  }
  if (check.ok === false) {
    return (
      <span className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1">
        <ShieldAlert size={11} /> {label}
      </span>
    );
  }
  // ok === null/undefined — not yet known (clientBuild before a PR exists,
  // or before this repo has the CI workflow installed).
  return (
    <span className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-200 flex items-center gap-1">
      <ShieldQuestion size={11} /> {label}
    </span>
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
    <div className={`px-6 py-3 border-b border-slate-100 text-xs leading-relaxed ${failing ? 'bg-rose-50' : pending ? 'bg-slate-50' : 'bg-emerald-50/40'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        {checks.map((k) => <ValidationBadge key={k} checkKey={k} check={v[k]} />)}
      </div>
      {failing && (
        <div className="flex items-start gap-2 mt-2 text-rose-700">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span><span className="font-extrabold">{VALIDATION_LABELS[failing]} failed:</span> {v[failing].error || 'validation failed'}</span>
        </div>
      )}
      {v.clientBuild?.mergedDespiteNotPassing && (
        <div className="flex items-start gap-2 mt-2 text-amber-700">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span><span className="font-extrabold">Merged despite a non-passing build check</span> — this was merged on GitHub before (or without) the rendering-validation check passing. Check the live page.</span>
        </div>
      )}
      {v.clientBuild?.checksUrl && (v.clientBuild.ok !== true || v.clientBuild.mergedDespiteNotPassing) && (
        <a href={v.clientBuild.checksUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-2 font-bold text-indigo-600 hover:underline">
          View client CI logs <ExternalLink size={11} />
        </a>
      )}
      {allPassing && !v.clientBuild?.mergedDespiteNotPassing && (
        <div className="flex items-center gap-1.5 mt-2 text-emerald-700 font-bold">
          <Check size={12} strokeWidth={3} /> All checked validations passing.
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
    <p className="text-[10px] text-slate-400 italic mt-1">
      {matchedVia === 'code-search'
        ? 'Found via GitHub code search — not in url_file_map, review carefully before merging.'
        : `Found on source page: ${matchedFrom}`}
    </p>
  );
}

function FileDiffBlock({ filePath, renderMode, live, changedRegions, oldContent, newContent, matchedVia, matchedFrom }) {
  const header = (
    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-extrabold uppercase tracking-wide flex-wrap">
      <GitBranch size={12} />
      <span>Target:</span>
      <code className="font-mono text-slate-600 bg-slate-100 rounded px-1.5 py-0.5">{filePath}</code>
      {renderMode === 'schema-only' && (
        <span className="ml-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100 normal-case tracking-normal font-bold">
          Schema only — visible page content unchanged
        </span>
      )}
    </div>
  );

  // Implemented drafts have nothing pending to diff against — this shows
  // what's actually sitting in the live marker(s) right now, read fresh
  // every time this loads (backend.js's previewLiveMarkerContent), not a
  // before/after.
  if (live) {
    return (
      <div className="mt-4 space-y-4 animate-slide-down">
        {header}
        <MatchedViaCaption matchedVia={matchedVia} matchedFrom={matchedFrom} />
        {changedRegions.map((r, i) => (
          <div key={i} className="space-y-2 border border-slate-100 rounded-2xl overflow-hidden">
            {r.field && (
              <div className="bg-slate-50 px-4 py-2 border-b border-slate-100 text-[10px] font-black uppercase tracking-wider text-slate-450">
                Field: {r.field}
              </div>
            )}
            <div className="bg-emerald-50/20 p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 mb-2 flex items-center gap-1">
                <span>✓ Currently Live</span>
              </p>
              <pre className="text-[11px] font-mono whitespace-pre-wrap text-emerald-950/85 leading-relaxed max-h-48 overflow-y-auto custom-scrollbar">{r.content}</pre>
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
    <div className="mt-4 space-y-4 animate-slide-down">
      {header}
      <MatchedViaCaption matchedVia={matchedVia} matchedFrom={matchedFrom} />
      {regions.map((r, i) => (
        <div key={i} className="space-y-2 border border-slate-100 rounded-2xl overflow-hidden">
          {r.field && r.field !== filePath && (
            <div className="bg-slate-50 px-4 py-2 border-b border-slate-100 text-[10px] font-black uppercase tracking-wider text-slate-450">
              Field: {r.field}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
            <div className="bg-rose-50/20 p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-rose-500 mb-2 flex items-center gap-1">
                <span>− Current Staged</span>
              </p>
              <pre className="text-[11px] font-mono whitespace-pre-wrap text-rose-950/80 leading-relaxed max-h-48 overflow-y-auto custom-scrollbar">{r.before || '(empty)'}</pre>
            </div>
            <div className="bg-emerald-50/20 p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 mb-2 flex items-center gap-1">
                <span>+ Draft Proposal</span>
              </p>
              <pre className="text-[11px] font-mono whitespace-pre-wrap text-emerald-950/85 leading-relaxed max-h-48 overflow-y-auto custom-scrollbar">{r.after}</pre>
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

export default function DraftModal({ draft, onClose, onSaved, onDeleted }) {
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
  const brandColor = GENERATOR_COLORS[draft.action_type] || '#6366f1';
  const [showDiff, setShowDiff] = useState(true);

  const selectTitle = async (title) => {
    try {
      const updated = await api.actionCenter.saveDraft(draft.id, { ...draft.content, selectedTitle: title });
      onSaved(updated);
    } catch (e) {
      setError(e.message || 'Could not select title');
    }
  };

  const loadFilePreview = async () => {
    setFilePreview('loading');
    try {
      const result = await api.actionCenter.previewDraft(draft.id);
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
      const updated = await apiFn(draft.id, renderMode);
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
          api.actionCenter.draft(draft.id).then(onSaved).catch(() => setError(e.message || 'Action failed'));
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
      const result = await api.actionCenter.rollback(draft.id);
      setRollbackPr({ prNumber: result.prNumber, prUrl: result.prUrl });
      // The backend just marked this draft rolled_back_at, which reopens its
      // finding in Recommendations (getDraftedFindingIds) — refetch so the
      // caller's onSaved reloads Recs, not just Drafts.
      api.actionCenter.draft(draft.id).then(onSaved).catch(() => {});
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
      const updated = await api.actionCenter.saveDraft(draft.id, parsed);
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
      await api.actionCenter.deleteDraft(draft.id);
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
      await api.actionCenter.reject(draft.id, 'sent_back_to_recommendations');
      onDeleted(draft.id);
    } catch (e) {
      if (e.status === 404) { setDraftGone(true); return; }
      setError(e.message || 'Failed to send back to Recommendations');
    } finally {
      setTransitioning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-md flex items-center justify-center p-4" onClick={onClose}>
      <div 
        className="bg-white/95 backdrop-blur-md rounded-3xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col border border-slate-200/60 overflow-hidden animate-slide-up" 
        onClick={(e) => e.stopPropagation()}
      >
        {/* Color stripe for branding */}
        <div className="h-1.5 shrink-0" style={{ background: `linear-gradient(to right, ${brandColor}, ${brandColor}44)` }} />

        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 bg-slate-50/20">
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-xl grid place-items-center text-sm shrink-0 shadow-sm border border-slate-150 bg-white"
              style={{ color: brandColor }}>
              <Sparkles size={14} />
            </span>
            <div>
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                {ACTION_LABELS[draft.action_type] || draft.action_type}
              </div>
              <div 
                className="text-xs font-black uppercase tracking-wide mt-1 px-2.5 py-0.5 rounded-full border w-fit"
                style={{ color: status.color, backgroundColor: status.bg, borderColor: status.border }}
              >
                {status.label}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full border border-slate-200/70 hover:border-slate-300 grid place-items-center text-slate-400 hover:text-slate-700 transition active:scale-95 shrink-0"
            aria-label="Close modal"
          >
            <X size={15} />
          </button>
        </div>

        {/* Error/Notice banners */}
        {draftGone && (
          <div className="px-6 py-3 border-b border-slate-100 bg-rose-50 text-xs text-rose-700 leading-relaxed flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <AlertTriangle size={14} className="text-rose-500 shrink-0" />
              <span><span className="font-extrabold">This draft no longer exists on the server.</span> It was likely discarded or already handled from another tab or session — this view is showing stale data. Close it and refresh the list.</span>
            </span>
            <button
              type="button"
              onClick={() => onDeleted(draft.id)}
              className="text-[11px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg bg-rose-600 text-white hover:bg-rose-700 transition shrink-0"
            >
              Close &amp; Refresh
            </button>
          </div>
        )}
        {draft.apply_error && (
          <div className="px-6 py-3 border-b border-slate-100 bg-rose-50 text-xs text-rose-700 leading-relaxed flex items-center gap-2">
            <AlertTriangle size={14} className="text-rose-500 shrink-0" />
            <span><span className="font-extrabold">Deployment Attempt Failed:</span> {draft.apply_error}</span>
          </div>
        )}

        {draft.stage_merge_url && (
          <div className="px-6 py-3 border-b border-slate-100 bg-indigo-50/30 flex items-center justify-between gap-3 text-xs">
            <a href={draft.stage_merge_url} target="_blank" rel="noopener noreferrer" className="font-bold text-indigo-600 hover:underline flex items-center gap-1">
              View merge commit on GitHub <ExternalLink size={12} />
            </a>
            <span className="font-extrabold text-emerald-600 flex items-center gap-1">
              <Check size={12} strokeWidth={3} /> Merged to stage
            </span>
          </div>
        )}

        {draft.pr_url && (
          <div className="px-6 py-3 border-b border-slate-100 bg-indigo-50/30 flex items-center justify-between gap-3 text-xs">
            <a href={draft.pr_url} target="_blank" rel="noopener noreferrer" className="font-bold text-indigo-600 hover:underline flex items-center gap-1">
              View PR on GitHub <ExternalLink size={12} />
            </a>
            <div className="flex items-center gap-2">
              {draft.sibling_count > 0 && (
                <span
                  className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200"
                  title={`This branch also contains ${draft.sibling_count} other approved draft(s) pushed today.`}
                >
                  Shared · +{draft.sibling_count}
                </span>
              )}
              {draft.status === 'implemented' ? (
                <span className="font-extrabold text-emerald-600 flex items-center gap-1">
                  <Check size={12} strokeWidth={3} /> Merged to main
                </span>
              ) : (
                <span className="font-extrabold text-amber-600">
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
          <div className="px-6 py-3 border-b border-slate-100 bg-rose-50 text-xs text-rose-700 leading-relaxed flex items-center gap-2">
            <AlertTriangle size={14} className="text-rose-500 shrink-0" />
            <span><span className="font-extrabold">This PR has conflicts:</span> its branch has diverged from the target branch and can no longer auto-merge on GitHub. Resolve the conflict there before merging.</span>
          </div>
        )}

        <ValidationStatusBanner draft={draft} />

        {draft.rolled_back_at && !rollbackPr && (
          <div className="px-6 py-3 border-b border-slate-100 bg-amber-50 text-xs text-amber-800 leading-relaxed flex items-center gap-2">
            <Undo size={14} className="text-amber-500 shrink-0" />
            <span><span className="font-extrabold">Rolled back:</span> a revert PR was opened for this draft. Its finding has reopened in Recommendations for another attempt.</span>
          </div>
        )}

        {rollbackPr && (
          <div className="px-6 py-3 border-b border-slate-100 bg-indigo-50/30 flex items-center justify-between gap-3 text-xs">
            <a href={rollbackPr.prUrl} target="_blank" rel="noopener noreferrer" className="font-bold text-indigo-600 hover:underline flex items-center gap-1">
              View rollback PR on GitHub <ExternalLink size={12} />
            </a>
            <span className="font-extrabold text-amber-600">Awaiting merge</span>
          </div>
        )}

        {draft.gsc_notification && !draft.gsc_notification.skipped && (
          <div className="px-6 py-3 border-b border-slate-100 bg-slate-50 text-xs text-slate-500 flex items-center gap-2">
            {draft.gsc_notification.sitemapSubmit?.ok ? (
              <>
                <Check size={12} className="text-emerald-500 shrink-0" strokeWidth={3} />
                <span>Sitemap resubmitted to Search Console — this page is prioritized for a faster recrawl.</span>
              </>
            ) : (
              <>
                <AlertTriangle size={12} className="text-amber-500 shrink-0" />
                <span>Search Console sitemap resubmission didn't go through: {draft.gsc_notification.sitemapSubmit?.error || 'unknown error'}.</span>
              </>
            )}
          </div>
        )}

        {/* Modal Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 custom-scrollbar">
          {editing ? (
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center justify-between">
                <span>Direct JSON Editor</span>
                <span className="text-rose-500">Caution: formatting errors will reject compile</span>
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-full h-64 sm:h-96 max-h-[50vh] text-xs font-mono border border-slate-200 rounded-2xl p-4 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-400 bg-slate-950 text-slate-200 scrollbar-thin"
                spellCheck={false}
              />
            </div>
          ) : (
            <>
              {/* Draft Content Card Wrapper */}
              <div className="bg-slate-50/50 border border-slate-150 rounded-3xl p-5">
                <DraftPreview actionType={draft.action_type} content={draft.content}
                  onSelectTitle={draft.action_type === 'meta-title' && draft.status !== 'implemented' ? selectTitle : undefined} />
              </div>

              {/* GitHub File Diff Preview Section — for an implemented draft
                  this shows the real, currently-live content instead of a
                  pending diff (see FileDiffPreview's `result.live` branch).
                  Skipped entirely for advisory-only types (no implementer
                  exists, so there is no file diff to fetch — see
                  ADVISORY_ONLY_TYPES above) in favor of a plain explanation,
                  so this never invites a "No implementer wired" dead end. */}
              {ADVISORY_ONLY_TYPES.includes(draft.action_type) ? (
                <div className="mt-5 pt-5 border-t border-slate-100">
                  <div className="text-xs text-slate-600 bg-slate-50 border border-slate-150 rounded-2xl p-4 leading-relaxed flex items-start gap-2.5">
                    <AlertTriangle size={16} className="text-slate-400 shrink-0 mt-0.5" />
                    <p>
                      This is an advisory fix plan, not an automatic file change — the safe rename can't be confirmed from a static page fetch alone (every CSS selector, JS call, and anchor link that might reference these ids would need checking). Copy the plan above and apply it by hand in your own repo, then mark this draft implemented.
                    </p>
                  </div>
                </div>
              ) : (
              <div className="mt-5 pt-5 border-t border-slate-100">
                  {draft.status === 'branch_pushed' && (
                    <div className="text-xs text-indigo-700 bg-indigo-50/60 border border-indigo-100/50 rounded-2xl p-4 mb-4 leading-relaxed flex items-start gap-2.5">
                      <GitBranch size={16} className="text-indigo-500 shrink-0 mt-0.5" />
                      <p>
                        This branch has been pushed to GitHub. Review the real file diff below, then open a PR — a human still needs to review and merge it into <code>main</code> on GitHub before it's live.
                      </p>
                    </div>
                  )}
                  {draft.status === 'pr_opened' && (
                    <div className="text-xs text-indigo-700 bg-indigo-50/60 border border-indigo-100/50 rounded-2xl p-4 mb-4 leading-relaxed flex items-start gap-2.5">
                      <GitBranch size={16} className="text-indigo-500 shrink-0 mt-0.5" />
                      <p>
                        A PR is open against <code>main</code>. Review and merge it on GitHub, then click Check PR Status here to mark this draft implemented.
                      </p>
                    </div>
                  )}

                  {!filePreview && (
                    <button
                      type="button"
                      onClick={loadFilePreview}
                      className="text-[11px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl text-slate-650 hover:bg-slate-100 border border-slate-250 transition duration-150 active:scale-[0.98] shadow-sm flex items-center gap-1.5"
                    >
                      <GitBranch size={12} /> {draft.status === 'implemented' ? 'Show what\'s live on GitHub' : 'Show real file diff from GitHub'}
                    </button>
                  )}
                  {filePreview === 'loading' && (
                    <div className="text-xs text-slate-400 flex items-center gap-1.5 animate-pulse">
                      <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                      Fetching real git repository diff…
                    </div>
                  )}
                  {filePreview && filePreview !== 'loading' && (
                    <div className="space-y-3 mt-3">
                      <button 
                        type="button" 
                        onClick={() => setShowDiff(!showDiff)}
                        className="text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-indigo-650 hover:border-slate-350 transition duration-150 flex items-center gap-1 shadow-sm active:scale-95 focus:outline-none"
                      >
                        <span>{showDiff ? 'Hide File Diff' : 'Show File Diff'}</span>
                        {showDiff ? <ChevronUp size={10} strokeWidth={2.5} /> : <ChevronDown size={10} strokeWidth={2.5} />}
                      </button>
                      
                      {showDiff && (
                        filePreview.ok ? <FileDiffPreview result={filePreview} /> : (
                          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-2xl p-4 leading-relaxed flex items-center gap-2">
                            <AlertTriangle size={14} className="text-amber-500 shrink-0" />
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
            <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-2xl p-3 mt-3 flex items-center gap-2">
              <AlertTriangle size={14} className="text-rose-500 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {activeRenderModeConfirm && (
            <div className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-100 rounded-2xl p-4 mt-3 space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <span className="font-extrabold">Render mode unclear</span>
                  {typeof activeRenderModeConfirm.confidence === 'number' && ` (${activeRenderModeConfirm.confidence}% confidence)`}
                  {': '}{activeRenderModeConfirm.reason}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-6">
                <button
                  onClick={() => runPublishAction(activeRenderModeConfirm.call, 'visible')}
                  disabled={transitioning}
                  className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2 rounded-xl bg-white border border-amber-200 text-amber-800 hover:bg-amber-100 transition disabled:opacity-60"
                >
                  Use Visible
                </button>
                <button
                  onClick={() => runPublishAction(activeRenderModeConfirm.call, 'schema-only')}
                  disabled={transitioning}
                  className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2 rounded-xl bg-white border border-amber-200 text-amber-800 hover:bg-amber-100 transition disabled:opacity-60"
                >
                  Use Schema-only
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-6 py-4 border-t border-slate-100 bg-slate-50/50 rounded-b-3xl">
          {draftGone ? (
            <button
              onClick={() => onDeleted(draft.id)}
              className="text-[11px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-sm ml-auto"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
            >
              Close &amp; Refresh
            </button>
          ) : draft.status !== 'implemented' ? (
            <div className="flex items-center gap-1">
              <button
                onClick={sendBackToRecommendation}
                disabled={transitioning}
                title="Abandon this draft and reopen its finding in Recommendations"
                className="text-[11px] font-black uppercase tracking-wider text-amber-600 hover:text-amber-700 flex items-center gap-1 px-2.5 py-2 rounded-lg hover:bg-amber-50/60 transition disabled:opacity-60"
              >
                <RotateCcw size={12} /> Send Back to Recommendation
              </button>
              <button
                onClick={remove}
                className="text-[11px] font-black uppercase tracking-wider text-rose-500 hover:text-rose-700 flex items-center gap-1 px-2.5 py-2 rounded-lg hover:bg-rose-50/40 transition"
              >
                <Trash2 size={12} /> Discard Draft
              </button>
            </div>
          ) : <span />}

          {!draftGone && (
          <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">
            {editing ? (
              <>
                <button
                  onClick={() => setEditing(false)}
                  className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-slate-500 hover:bg-slate-100 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="text-[11px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-sm hover:shadow-indigo-500/15 disabled:opacity-60 flex items-center gap-1"
                  style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                >
                  <Save size={12} /> {saving ? 'Saving…' : 'Save Draft'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={copy}
                  className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-slate-600 hover:bg-slate-100 border border-slate-205 transition duration-150 shadow-sm active:scale-[0.98] flex items-center gap-1"
                >
                  <Copy size={12} /> {copyLabel}
                </button>

                {(draft.status === 'draft' || draft.status === 'edited') && (
                  <>
                    <button
                      onClick={startEdit}
                      className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-indigo-600 hover:bg-indigo-50 border border-indigo-200 transition duration-150 shadow-sm active:scale-[0.98] flex items-center gap-1"
                    >
                      <Edit3 size={12} /> Edit
                    </button>
                    <button
                      onClick={() => transition(() => api.actionCenter.submitDraft(draft.id))}
                      disabled={transitioning}
                      className="text-[11px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-indigo-100 hover:shadow-indigo-500/15 disabled:opacity-60 flex items-center gap-1"
                      style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                    >
                      <Check size={12} strokeWidth={2.5} /> {transitioning ? 'Submitting…' : 'Submit for Approval'}
                    </button>
                  </>
                )}

                {draft.status === 'submitted_for_approval' && (
                  <button
                    onClick={() => runPublishAction('approve')}
                    disabled={transitioning}
                    className="text-[11px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-emerald-100 hover:shadow-emerald-500/15 disabled:opacity-60 flex items-center gap-1"
                    style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}
                  >
                    <Check size={12} strokeWidth={2.5} /> {transitioning ? 'Publishing…' : 'Approve & Publish'}
                  </button>
                )}

                {draft.status === 'approved' && (
                  <>
                    {!MERGE_MANDATORY_TYPES.includes(draft.action_type) && (
                      <button
                        onClick={() => transition(() => api.actionCenter.implementDraft(draft.id))}
                        disabled={transitioning}
                        className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-slate-500 hover:bg-slate-100 border border-slate-200 disabled:opacity-60 transition"
                      >
                        Mark Implemented manually
                      </button>
                    )}
                    {!ADVISORY_ONLY_TYPES.includes(draft.action_type) && (
                      <button
                        onClick={() => runPublishAction('push-branch')}
                        disabled={transitioning}
                        className="text-[11px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md hover:shadow-indigo-500/15 disabled:opacity-60 flex items-center gap-1"
                        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                      >
                        <GitBranch size={12} /> {transitioning ? 'Pushing…' : 'Push Branch'}
                      </button>
                    )}
                  </>
                )}

                {draft.status === 'branch_pushed' && (
                  <>
                    <span
                      className="text-[10px] font-mono text-slate-400 truncate max-w-[140px] hidden sm:inline-block bg-slate-100 rounded-lg px-2 py-1"
                      title={draft.branch_name}
                    >
                      {draft.branch_name}
                    </span>
                    {draft.sibling_count > 0 && (
                      <span
                        className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200"
                        title={`This branch also contains ${draft.sibling_count} other approved draft(s) pushed today.`}
                      >
                        Shared · +{draft.sibling_count}
                      </span>
                    )}
                    <button
                      onClick={() => transition(() => api.actionCenter.openPr(draft.id))}
                      disabled={transitioning}
                      className="text-[11px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md hover:shadow-indigo-500/15 disabled:opacity-60 flex items-center gap-1"
                      style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                    >
                      <GitBranch size={12} /> {transitioning ? 'Opening PR…' : 'Open PR'}
                    </button>
                  </>
                )}

                {draft.status === 'pr_opened' && (
                  <>
                    <span className="text-[10px] font-semibold text-slate-400 max-w-[200px] leading-snug">
                      Waiting on a human to review and merge the PR on GitHub. This also refreshes the client build (CI) check above.
                    </span>
                    <button
                      onClick={() => transition(() => api.actionCenter.checkPrStatus(draft.id))}
                      disabled={transitioning}
                      className="text-[11px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md hover:shadow-indigo-500/15 disabled:opacity-60 flex items-center gap-1"
                      style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                    >
                      <Check size={12} strokeWidth={2.5} /> {transitioning ? 'Checking…' : 'Check PR Status'}
                    </button>
                  </>
                )}

                {draft.status === 'merged_to_stage' && (
                  <>
                    <span className="text-[10px] font-semibold text-slate-400 max-w-[200px] leading-snug">
                      Live on staging.
                    </span>
                    {draft.rollback_snapshot && !draft.sibling_count && !draft.rolled_back_at && (
                      <button
                        onClick={rollback}
                        disabled={transitioning}
                        title="Restore this file to exactly what it was right before this draft's merge"
                        className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-slate-500 hover:bg-slate-100 border border-slate-200 disabled:opacity-60 transition flex items-center gap-1"
                      >
                        <Undo size={12} /> {transitioning ? 'Opening PR…' : 'Rollback'}
                      </button>
                    )}
                    {draft.rollback_snapshot && draft.sibling_count > 0 && (
                      <span
                        className="text-[10px] font-semibold text-slate-400"
                        title="Rollback is disabled because this branch is shared with other drafts."
                      >
                        Rollback unavailable (shared branch)
                      </span>
                    )}
                    <button
                      onClick={() => transition(() => api.actionCenter.implementDraft(draft.id))}
                      disabled={transitioning}
                      className="text-[11px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md hover:shadow-emerald-500/15 disabled:opacity-60 shrink-0"
                      style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}
                    >
                      Mark Implemented
                    </button>
                  </>
                )}

                {/* implemented is terminal for the transitions above, but a real
                    rollback_snapshot (captured at merge time) is still valid — the
                    merge that snapshot reverts happened regardless of whether this
                    draft was additionally marked implemented afterward. */}
                {draft.status === 'implemented' && draft.rollback_snapshot && !draft.sibling_count && !draft.rolled_back_at && (
                  <button
                    onClick={rollback}
                    disabled={transitioning}
                    title="Restore this file to exactly what it was right before this draft's merge"
                    className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-slate-500 hover:bg-slate-100 border border-slate-200 disabled:opacity-60 transition flex items-center gap-1"
                  >
                    <Undo size={12} /> {transitioning ? 'Opening PR…' : 'Rollback'}
                  </button>
                )}
                {draft.status === 'implemented' && draft.rollback_snapshot && draft.sibling_count > 0 && (
                  <span
                    className="text-[10px] font-semibold text-slate-400"
                    title="Rollback is disabled because this branch is shared with other drafts."
                  >
                    Rollback unavailable (shared branch)
                  </span>
                )}
              </>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
