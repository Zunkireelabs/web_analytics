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
  FolderSync
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
};

const DRAFT_STATUS_LABEL = {
  draft: 'draft', edited: 'edited', submitted_for_approval: 'pending approval',
  approved: 'approved', branch_pushed: 'branch pushed', merged_to_stage: 'merged to stage',
  pr_opened: 'PR opened', implemented: 'implemented',
};

const STATUS_ORDER = ['draft', 'edited', 'submitted_for_approval', 'approved', 'branch_pushed', 'merged_to_stage', 'pr_opened', 'implemented'];
const STAGE_COLOR = {
  draft: '#94a3b8', edited: '#f59e0b', submitted_for_approval: '#f59e0b',
  approved: '#10b981', branch_pushed: '#7c3aed', merged_to_stage: '#2563eb',
  pr_opened: '#2563eb', implemented: '#10b981',
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
  const [statusFilter, setStatusFilter] = useState('');
  
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
    const groupedKeys = Object.keys(
      (data?.items || []).reduce((acc, item) => {
        (acc[item.generatorId] ||= []).push(item);
        return acc;
      }, {})
    );
    if (groupedKeys.length > 0) setActiveCategory(groupedKeys[0]);
  }).catch(() => setRecs({ items: [], lastAnalyzedAt: {} }));

  const loadDrafts = () => api.actionCenter.drafts().then((data) => {
    setDrafts(data);
    if (data && data.length > 0) setSelectedDraftItem(data[0]);
  }).catch(() => setDrafts([]));

  useEffect(() => { loadRecs(); loadDrafts(); }, []);
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

  // Implemented drafts belong on the Implemented tab only — never mixed
  // into the Drafts tab's own list, "All Drafts" included.
  const nonImplementedDrafts = drafts === null ? null : drafts.filter((d) => d.status !== 'implemented');
  const visibleDrafts = statusFilter ? (nonImplementedDrafts || []).filter((d) => d.status === statusFilter) : nonImplementedDrafts;

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await api.actionCenter.refresh(range.start, range.end);
      setRecs(fresh);
      const groupedKeys = Object.keys(
        (fresh?.items || []).reduce((acc, item) => {
          (acc[item.generatorId] ||= []).push(item);
          return acc;
        }, {})
      );
      if (groupedKeys.length > 0) setActiveCategory(groupedKeys[0]);
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

  const grouped = (recs?.items || []).reduce((acc, item) => {
    (acc[item.generatorId] ||= []).push(item);
    return acc;
  }, {});

  const implementedDrafts = (drafts || []).filter((d) => d.status === 'implemented')
    .sort((a, b) => new Date(b.implemented_at) - new Date(a.implemented_at));

  const highPriorityCount = (recs?.items || []).filter((i) => i.priority === 'high').length;
  const pendingApprovalCount = (drafts || []).filter((d) => d.status === 'submitted_for_approval').length;
  const implementedThisWeekCount = (drafts || []).filter((d) => d.status === 'implemented' && d.implemented_at >= daysAgo(7)).length;

  // Selected category items mapping
  const activeItems = activeCategory ? (grouped[activeCategory] || []) : [];
  const sortedItems = [...activeItems].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
  const activeMeta = activeCategory ? GENERATOR_META[activeCategory] : null;

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

      {/* QUICK COMMAND METRIC HEADER PANEL */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        
        {/* Tab switch panel (Left, 4-cols) */}
        <div className="lg:col-span-4 bg-slate-100/90 p-1.5 rounded-2xl border border-slate-200/80 flex shadow-sm items-center justify-between">
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

        {/* Date controllers & refresh pipeline (Right, 8-cols) */}
        <div className="lg:col-span-8 bg-white border border-slate-205 rounded-2xl p-2.5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
          
          {/* Quick stats indicators with distinct colored chips */}
          <div className="flex items-center gap-2.5 text-[10.5px] font-black uppercase tracking-wider shrink-0">
            <span className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-100 text-indigo-700 px-3 py-1.5 rounded-xl shadow-sm"><Sparkles size={11} className="text-indigo-550 animate-pulse" /> Recs: <strong className="ml-0.5">{recs?.items.length ?? 0}</strong></span>
            <span className="flex items-center gap-1.5 bg-rose-50 border border-rose-100 text-rose-700 px-3 py-1.5 rounded-xl shadow-sm"><AlertTriangle size={11} className="text-rose-550" /> High: <strong className="ml-0.5">{highPriorityCount}</strong></span>
            <span className="flex items-center gap-1.5 bg-amber-50 border border-amber-100 text-amber-700 px-3 py-1.5 rounded-xl shadow-sm"><Clock size={11} className="text-amber-550" /> Review: <strong className="ml-0.5">{pendingApprovalCount}</strong></span>
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
          
          {/* Categories select checklist (Recommendations tab) */}
          {tab === 'recommendations' && recs && Object.keys(grouped).length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 px-1 flex items-center gap-1 mb-1">
                <Layers size={11} className="text-indigo-550" />
                <span>Categories ({Object.keys(grouped).length})</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {Object.entries(grouped).map(([generatorId, items]) => {
                  const meta = GENERATOR_META[generatorId] || { label: generatorId, icon: '•', color: '#64748b' };
                  const active = activeCategory === generatorId;
                  return (
                    <button 
                      key={generatorId} 
                      onClick={() => setActiveCategory(generatorId)}
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
                              <span className="text-xs font-black text-slate-800 leading-snug truncate">{item.tag}</span>
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
                      <div>
                        <h3 className="text-sm font-black text-slate-900 leading-none">{selectedRecommendation.tag}</h3>
                        <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider mt-1.5">Diagnosed by: {selectedRecommendation.agentName || activeMeta?.label}</p>
                      </div>
                    </div>

                    <div className="p-6 space-y-4">
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Diagnostic Reason</div>
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
                          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Priority Rank</div>
                          <span className={`inline-flex items-center gap-1 text-[9.5px] font-black uppercase tracking-wider px-3 py-1 rounded-full border ${
                            selectedRecommendation.priority === 'high' ? 'bg-rose-50 border-rose-100 text-rose-600' : 'bg-slate-50 border-slate-200 text-slate-600'
                          }`}>
                            {selectedRecommendation.priority === 'high' ? '⚠️ High' : '• Normal'}
                          </span>
                        </div>
                        {selectedRecommendation.expectedImpact?.label && (
                          <div>
                            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Expected Return</div>
                            <span className="inline-flex items-center gap-1 text-[9.5px] font-black uppercase tracking-wider px-3 py-1 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-600">
                              🚀 {selectedRecommendation.expectedImpact.label} Impact
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="p-6 border-t border-slate-100 bg-slate-50/30 flex justify-end">
                    <button
                      onClick={() => generate(selectedRecommendation)}
                      disabled={generatingId === selectedRecommendation.id}
                      className="text-[10.5px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md hover:shadow-indigo-500/10 disabled:opacity-60 cursor-pointer"
                      style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                    >
                      {generatingId === selectedRecommendation.id ? 'Drafting Fix…' : 'Generate Solution Draft'}
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
          onSaved={(updated) => { setActiveDraft(updated); loadDrafts(); }}
          onDeleted={() => { setActiveDraft(null); loadDrafts(); }}
        />
      )}
    </div>
  );
}
