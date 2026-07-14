import { useEffect, useState } from 'react';
import { api, daysAgo, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import SectionHeader from '../components/SectionHeader.jsx';
import StatTile from '../components/StatTile.jsx';
import DraftModal from '../components/DraftModal.jsx';
import { PRIORITY } from '../components/WatchlistCard.jsx';

const GENERATOR_META = {
  'meta-title': { label: 'Meta Title & Description', icon: '🏷️', color: '#6C63FF' },
  faq: { label: 'FAQ', icon: '❓', color: '#0ea5e9' },
  schema: { label: 'Schema Markup', icon: '🧩', color: '#8b5cf6' },
  'internal-links': { label: 'Internal Links', icon: '🔗', color: '#14b8a6' },
  'blog-outline': { label: 'Blog Outline', icon: '📝', color: '#ec4899' },
  'landing-page': { label: 'Landing Page', icon: '🚀', color: '#c2410c' },
  translation: { label: 'Translation', icon: '🌐', color: '#06b6d4' },
  'llms-txt': { label: 'llms.txt & AI-Crawler Robots.txt', icon: '🤖', color: '#10b981' },
};

// Must stay in sync with the real status enum — server/store/drafts.js /
// server/migrations/038_draft_branch_pushed_status.sql /
// 039_draft_merged_to_stage.sql. `pr_opened` stays for any historical draft
// from before Phase 13; no new draft reaches it.
const DRAFT_STATUS_LABEL = {
  draft: 'draft', edited: 'edited', submitted_for_approval: 'pending approval',
  approved: 'approved', branch_pushed: 'branch pushed', merged_to_stage: 'merged to stage',
  pr_opened: 'PR opened', implemented: 'implemented',
};
const STATUS_ORDER = ['draft', 'edited', 'submitted_for_approval', 'approved', 'branch_pushed', 'merged_to_stage', 'implemented'];
const STAGE_COLOR = {
  draft: '#94a3b8', edited: '#f59e0b', submitted_for_approval: '#f59e0b',
  approved: '#10b981', branch_pushed: '#7c3aed', merged_to_stage: '#2563eb',
  pr_opened: '#2563eb', implemented: '#10b981',
};
const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'submitted_for_approval', label: 'Pending approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'branch_pushed', label: 'Branch pushed' },
  { value: 'merged_to_stage', label: 'Merged to stage' },
  { value: 'implemented', label: 'Implemented' },
];

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const VISIBLE_PER_GROUP = 5;

// A small 5-dot progress indicator for the draft lifecycle (draft → edited →
// submitted_for_approval → approved → implemented) — replaces a single flat
// status pill so progress reads at a glance instead of requiring the label text.
function DraftStepper({ status }) {
  const idx = Math.max(0, STATUS_ORDER.indexOf(status));
  return (
    <div className="flex items-center" aria-label={`Status: ${DRAFT_STATUS_LABEL[status] || status}`}>
      {STATUS_ORDER.map((s, i) => (
        <span key={s} className="flex items-center">
          <span className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: i <= idx ? STAGE_COLOR[status] : '#e2e8f0' }} />
          {i < STATUS_ORDER.length - 1 && (
            <span className="w-3 h-px shrink-0" style={{ background: i < idx ? STAGE_COLOR[status] : '#e2e8f0' }} />
          )}
        </span>
      ))}
    </div>
  );
}

// A group of N near-identical recommendations (e.g. "Add an FAQ section" on
// 19 different pages) used to render as an undifferentiated 19-row wall —
// same real repetition problem the Command Center's Discoveries feed had,
// fixed here the way that page's density calls for: priority-sorted,
// collapsed to the top 5 by default, with everything still reachable behind
// "Show all" rather than hidden — a worklist shouldn't lose capability, just
// noise. Each generator gets its own color identity (top bar + icon chip) and
// each row gets a priority-colored left strip, so the page reads as
// color-coded content types instead of one undifferentiated gray list.
function RecommendationGroup({ generatorId, items, generatingId, onGenerate, draftsByFindingId, onViewDraft }) {
  const [expanded, setExpanded] = useState(false);
  const meta = GENERATOR_META[generatorId] || { label: generatorId, icon: '•', color: '#64748b' };
  const sorted = [...items].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_PER_GROUP);
  const hidden = sorted.length - visible.length;

  return (
    <div className="card overflow-hidden">
      <div className="h-[3px] shrink-0" style={{ background: `linear-gradient(to right, ${meta.color}, ${meta.color}55)` }} />
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg grid place-items-center text-[13px] shrink-0"
          style={{ background: `${meta.color}1a`, color: meta.color }}>{meta.icon}</span>
        <h3 className="text-[15px] font-bold tracking-tight text-slate-900">{meta.label}</h3>
        <span className="text-xs font-mono font-semibold text-slate-400 ml-auto">{items.length}</span>
      </div>
      <div className="divide-y divide-slate-50">
        {visible.map((item) => {
          const pr = PRIORITY[item.priority] || PRIORITY.low;
          // A recommendation stays real even after a draft exists for it —
          // buildRecommendations doesn't cross-reference drafts, so the same
          // finding keeps showing until the underlying agent re-runs and
          // stops flagging it. This is the real "have we already acted on
          // this" answer instead: a real draft, matched by the same real
          // finding id (draft.finding_id === item.id) that generate() sets.
          const existingDraft = draftsByFindingId.get(item.id);
          return (
            <div key={item.id} className="flex gap-3 px-5 py-3">
              <span className="w-[3px] rounded-full shrink-0 self-stretch" style={{ background: pr.color }} />
              <div className="min-w-0 flex-1 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium text-slate-800 truncate">{item.tag}</div>
                    {item.priority === 'high' && <span className="text-[10px] font-bold text-rose-600 shrink-0">HIGH</span>}
                    {existingDraft && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0"
                        style={{ color: STAGE_COLOR[existingDraft.status], background: `${STAGE_COLOR[existingDraft.status]}1a` }}>
                        {existingDraft.status === 'implemented' ? '✓ IMPLEMENTED' : (DRAFT_STATUS_LABEL[existingDraft.status] || existingDraft.status).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{item.reason}</div>
                  {item.params.page && <div className="text-[10px] text-slate-400 mt-0.5 truncate">{item.params.page}</div>}
                </div>
                {existingDraft ? (
                  <button
                    onClick={() => onViewDraft(existingDraft)}
                    className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100 border border-slate-200"
                  >
                    View Draft
                  </button>
                ) : (
                  <button
                    onClick={() => onGenerate(item)}
                    disabled={generatingId === item.id}
                    className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 disabled:opacity-60"
                  >
                    {generatingId === item.id ? 'Generating…' : 'Generate Draft'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {hidden > 0 && (
        <button onClick={() => setExpanded(true)}
          className="w-full text-xs font-semibold text-indigo-600 hover:bg-indigo-50/60 px-5 py-2.5 border-t border-slate-50 transition">
          Show all {sorted.length} →
        </button>
      )}
      {expanded && sorted.length > VISIBLE_PER_GROUP && (
        <button onClick={() => setExpanded(false)}
          className="w-full text-xs font-semibold text-slate-400 hover:bg-slate-50 px-5 py-2 border-t border-slate-50 transition">
          Show fewer ↑
        </button>
      )}
    </div>
  );
}

export default function ActionCenter() {
  const [tab, setTab] = useState('recommendations'); // 'recommendations' | 'drafts'
  const [recs, setRecs] = useState(null); // null = loading
  const [drafts, setDrafts] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState({ start: daysAgo(7), end: daysAgo(0) });
  const [generatingId, setGeneratingId] = useState(null);
  const [activeDraft, setActiveDraft] = useState(null);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');

  const loadRecs = () => api.actionCenter.recommendations().then(setRecs).catch(() => setRecs({ items: [], lastAnalyzedAt: {} }));
  // Always the full, unfiltered list — the top-of-page stat tiles (Pending
  // Approval, Implemented) need every draft to count correctly; the status
  // filter below is applied client-side only for what the Drafts tab shows.
  const loadDrafts = () => api.actionCenter.drafts().then(setDrafts).catch(() => setDrafts([]));

  // Both load on mount (not just when the Drafts tab is opened) so the
  // top-of-page stat row has draft data immediately, regardless of which tab
  // is active first.
  useEffect(() => { loadRecs(); loadDrafts(); }, []);

  // A draft's status can change from outside this page entirely (another
  // tab/session, or a real merge-to-stage that auto-completes to
  // implemented server-side) — the mount-time fetch above has no way to
  // learn about that on its own. Re-fetching every time staff actually
  // looks at the Drafts tab is cheap and keeps what they see honest,
  // without needing a polling interval for a page that isn't usually left
  // open in the background.
  useEffect(() => { if (tab === 'drafts' || tab === 'implemented') loadDrafts(); }, [tab]);

  const visibleDrafts = statusFilter ? (drafts || []).filter((d) => d.status === statusFilter) : drafts;

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await api.actionCenter.refresh(range.start, range.end);
      setRecs(fresh);
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
      loadDrafts();
    } catch (e) {
      setError(`${item.tag}: ${e.message || 'Generation failed'}`);
    } finally {
      setGeneratingId(null);
    }
  };

  const grouped = (recs?.items || []).reduce((acc, item) => {
    (acc[item.generatorId] ||= []).push(item);
    return acc;
  }, {});

  // Real finding_id -> draft lookup for "has this recommendation already
  // been acted on" (see RecommendationGroup). `drafts` is already ordered
  // created_at DESC, so the first draft seen per finding_id is its most
  // recent — good enough since one finding practically only ever gets one
  // real draft at a time. Manually-created drafts have finding_id = null
  // and are simply never looked up (never match a real recommendation id).
  const draftsByFindingId = new Map();
  for (const d of drafts || []) {
    if (d.finding_id && !draftsByFindingId.has(d.finding_id)) draftsByFindingId.set(d.finding_id, d);
  }

  const implementedDrafts = (drafts || []).filter((d) => d.status === 'implemented')
    .sort((a, b) => new Date(b.implemented_at) - new Date(a.implemented_at));

  const highPriorityCount = (recs?.items || []).filter((i) => i.priority === 'high').length;
  const pendingApprovalCount = (drafts || []).filter((d) => d.status === 'submitted_for_approval').length;
  const implementedThisWeekCount = (drafts || []).filter((d) => d.status === 'implemented' && d.implemented_at >= daysAgo(7)).length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <PageHeader
        title="Action Center"
        subtitle="Every AI recommendation becomes an editable draft — nothing here ever publishes automatically"
        icon="⚡"
      />

      <div className="flex items-center gap-2 border-b border-slate-100">
        {['recommendations', 'drafts', 'implemented'].map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px transition ${
              tab === t ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}>
            {t === 'recommendations' ? 'Recommendations'
              : t === 'drafts' ? `Drafts${drafts ? ` (${drafts.length})` : ''}`
              : `Implemented${drafts ? ` (${implementedDrafts.length})` : ''}`}
          </button>
        ))}
      </div>

      {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile icon="⚡" label="Recommendations" value={recs?.items.length ?? '—'}
          tone="accent" sub="Across all generators" loading={recs === null} />
        <StatTile icon="🔥" label="High Priority" value={recs === null ? '—' : highPriorityCount}
          tone="critical" sub="Needs attention first" loading={recs === null} />
        <StatTile icon="⏳" label="Pending Approval" value={drafts === null ? '—' : pendingApprovalCount}
          tone="warning" sub="Drafts awaiting review" loading={drafts === null} />
        <StatTile icon="✅" label="Implemented (7d)" value={drafts === null ? '—' : implementedThisWeekCount}
          tone="success" sub="Live on site" loading={drafts === null} />
      </div>

      {tab === 'recommendations' && (
        <>
          <SectionHeader title="Recommendations" count={recs ? `${recs.items.length} shown` : null} />
          <div className="card p-4 flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-500">
              Last analyzed: {recs ? Object.entries(recs.lastAnalyzedAt || {}).map(([id, at]) => `${id} ${timeAgo(at)}`).join(' · ') || 'never' : '…'}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <input type="date" value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                className="text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
              <span className="text-xs text-slate-400">to</span>
              <input type="date" value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
                className="text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
              <button onClick={refresh} disabled={refreshing}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60">
                {refreshing ? 'Refreshing… (~30s)' : 'Refresh Recommendations'}
              </button>
            </div>
          </div>

          {recs === null && <div className="card p-8 text-center text-slate-400">Loading…</div>}
          {recs && recs.items.length === 0 && (
            <div className="card p-8 text-center text-slate-400">
              No recommendations yet — click "Refresh Recommendations" to run a fresh analysis.
            </div>
          )}

          {Object.entries(grouped).map(([generatorId, items]) => (
            <RecommendationGroup key={generatorId} generatorId={generatorId} items={items}
              generatingId={generatingId} onGenerate={generate}
              draftsByFindingId={draftsByFindingId} onViewDraft={setActiveDraft} />
          ))}
        </>
      )}

      {tab === 'drafts' && (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <SectionHeader title="Drafts"
              count={drafts ? (statusFilter ? `${visibleDrafts.length} of ${drafts.length}` : `${drafts.length} total`) : null} />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
              className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-600 bg-white">
              {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          {drafts === null && <div className="card p-8 text-center text-slate-400">Loading…</div>}
          {drafts && drafts.length === 0 && <div className="card p-8 text-center text-slate-400">No drafts yet — generate one from the Recommendations tab.</div>}
          {drafts && drafts.length > 0 && visibleDrafts.length === 0 && (
            <div className="card p-8 text-center text-slate-400">No drafts with this status.</div>
          )}
          {visibleDrafts && visibleDrafts.length > 0 && (
            <div className="card overflow-hidden divide-y divide-slate-50">
              {visibleDrafts.map((d) => {
                const meta = GENERATOR_META[d.action_type] || { label: d.action_type, icon: '•', color: '#64748b' };
                // Real evidence timestamp for the current status — the same
                // "why does this say implemented" question DraftModal
                // answers with a link, shown here too so it's visible
                // without opening each draft one by one.
                const statusAt = d.status === 'implemented' ? d.implemented_at
                  : d.status === 'merged_to_stage' ? d.stage_merged_at
                  : d.status === 'approved' ? d.approved_at
                  : null;
                return (
                  <button key={d.id} onClick={() => setActiveDraft(d)}
                    className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-slate-50">
                    <span className="w-8 h-8 rounded-lg grid place-items-center text-sm shrink-0"
                      style={{ background: `${meta.color}1a`, color: meta.color }}>{meta.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-800">{meta.label}</div>
                      <div className="text-xs text-slate-500 truncate mt-0.5">{d.input?.page || d.input?.topic || d.input?.market || d.input?.city || ''}</div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <DraftStepper status={d.status} />
                      <span className="text-[10px] font-semibold text-slate-500">
                        {DRAFT_STATUS_LABEL[d.status] || d.status}{statusAt ? ` · ${timeAgo(statusAt)}` : ''}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === 'implemented' && (
        <>
          <SectionHeader title="Implemented" count={drafts ? `${implementedDrafts.length} total` : null} />
          {drafts === null && <div className="card p-8 text-center text-slate-400">Loading…</div>}
          {drafts && implementedDrafts.length === 0 && (
            <div className="card p-8 text-center text-slate-400">Nothing implemented yet — real changes land here once a draft is approved, pushed, and merged.</div>
          )}
          {implementedDrafts.length > 0 && (
            <div className="card overflow-hidden divide-y divide-slate-50">
              {implementedDrafts.map((d) => {
                const meta = GENERATOR_META[d.action_type] || { label: d.action_type, icon: '•', color: '#64748b' };
                return (
                  <button key={d.id} onClick={() => setActiveDraft(d)}
                    className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-slate-50">
                    <span className="w-8 h-8 rounded-lg grid place-items-center text-sm shrink-0"
                      style={{ background: `${meta.color}1a`, color: meta.color }}>{meta.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-800">{meta.label}</div>
                      <div className="text-xs text-slate-500 truncate mt-0.5">{d.input?.page || d.input?.topic || d.input?.market || d.input?.city || ''}</div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ color: '#16a34a', background: '#16a34a1a' }}>
                        ✓ IMPLEMENTED
                      </span>
                      <span className="text-[10px] text-slate-400">{d.implemented_at ? timeAgo(d.implemented_at) : ''}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {activeDraft && (
        <DraftModal
          draft={activeDraft}
          onClose={() => setActiveDraft(null)}
          onSaved={(updated) => { setActiveDraft(updated); loadDrafts(); }}
          onDeleted={() => { setActiveDraft(null); loadDrafts(); }}
        />
      )}
    </div>
  );
}
