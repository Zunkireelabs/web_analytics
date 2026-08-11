import { useEffect, useMemo, useState } from 'react';
import {
  Search, Layers, Table2, Fingerprint, ChevronDown, ChevronUp, CheckCircle2, Ban,
  Sparkles, Target, Inbox, AlertTriangle,
} from 'lucide-react';
import { api } from '../api.js';
import { SEVERITY_META } from '../lib/analystFormat.js';
import AnalystSkeletonLoader from './AnalystSkeletonLoader.jsx';
import AnalystEmptyState from './AnalystEmptyState.jsx';

// cluster_type (migration 079_keyword_clusters.sql's CHECK constraint) —
// same an-chip-* palette as everywhere else on the page, arbitrary but
// stable mapping since the DB doesn't carry a color of its own.
const CLUSTER_TYPE_META = {
  service: { label: 'Service', chip: 'an-chip-violet' },
  product: { label: 'Product', chip: 'an-chip-cyan' },
  general: { label: 'General', chip: 'an-chip-slate' },
};

// gaps' status vocabulary matches api.keywords.gaps()/updateGapStatus() —
// pending_review/approved/rejected, not the DB's own accepted/dismissed
// (see server/store/data-analyst.js's GAP_STATUS_FROM_DB).
const GAP_STATUS_META = {
  pending_review: { label: 'Pending Review', chip: 'an-chip-amber' },
  approved: { label: 'Approved', chip: 'an-chip-emerald' },
  rejected: { label: 'Rejected', chip: 'an-chip-rose' },
};

const GAP_SOURCE_META = {
  internal_analysis: { label: 'Internal Analysis', chip: 'an-chip-slate' },
  claude_research: { label: 'Claude Research', chip: 'an-chip-violet' },
};

const TABS = [
  { id: 'clusters', label: 'Clusters', icon: Layers },
  { id: 'gaps', label: 'Gaps', icon: Table2 },
  { id: 'profile', label: 'Site Profile', icon: Fingerprint },
];

export default function AnalystKeywordDiscovery({ clientId }) {
  const [activeTab, setActiveTab] = useState('clusters');
  const [clustersState, setClustersState] = useState(null); // null=loading | {data}
  const [gapsState, setGapsState] = useState(null);
  const [profileState, setProfileState] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    setClustersState(null);
    api.keywords.clusters(clientId)
      .then((data) => setClustersState({ data }))
      .catch((e) => setClustersState({ data: [], error: e.message || 'Failed to load keyword clusters.' }));
  }, [clientId]);

  useEffect(() => {
    setGapsState(null);
    api.keywords.gaps(clientId)
      .then((data) => setGapsState({ data }))
      .catch((e) => setGapsState({ data: [], error: e.message || 'Failed to load keyword gaps.' }));
  }, [clientId]);

  useEffect(() => {
    setProfileState(null);
    api.keywords.profile(clientId)
      .then((data) => setProfileState({ data }))
      .catch((e) => setProfileState({ data: null, error: e.message || 'Failed to load site profile.' }));
  }, [clientId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const updateGapStatus = async (gap, status) => {
    const prevGaps = gapsState?.data || [];
    setGapsState({ data: prevGaps.map((g) => (g.id === gap.id ? { ...g, status } : g)) });
    try {
      const updated = await api.keywords.updateGapStatus(clientId, gap.id, status);
      const ac = updated?.actionCenter;
      const message = status === 'approved'
        ? (ac?.draftId
          ? `“${gap.topic}” approved — a proposed draft is ready for review in Action Center.`
          : ac?.draftError
            ? `“${gap.topic}” approved — queued in Action Center, but draft generation needs a retry (${ac.draftError}).`
            : ac?.eligible
              ? `“${gap.topic}” approved — sent to Action Center.`
              : `“${gap.topic}” approved.`)
        : `“${gap.topic}” marked ${GAP_STATUS_META[status].label.toLowerCase()}.`;
      setToast({ tone: status === 'approved' ? 'success' : 'neutral', message });
    } catch (e) {
      setGapsState({ data: prevGaps });
      setToast({ tone: 'error', message: e.message || 'Failed to update gap status.' });
    }
  };

  return (
    <div className="an-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-500 grid place-items-center">
            <Search size={15} />
          </div>
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-900">Keyword Discovery</h3>
            <p className="text-[10px] font-medium text-slate-400">Semantic clusters, coverage gaps & site profile from the clustering agent</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1.5 rounded-lg border transition cursor-pointer ${
                  active
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-500'
                    : 'bg-slate-100/60 border-slate-200 text-slate-400 hover:text-slate-800'
                }`}
              >
                <Icon size={11} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <NarrativePanel clientId={clientId} />

      {activeTab === 'clusters' && <ClustersTab state={clustersState} />}
      {activeTab === 'gaps' && <GapsTab state={gapsState} onUpdateStatus={updateGapStatus} />}
      {activeTab === 'profile' && <ProfileTab state={profileState} />}

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 text-xs font-bold px-4 py-2.5 rounded-xl shadow-lg border ${
            toast.tone === 'success'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
              : toast.tone === 'error'
                ? 'bg-rose-50 border-rose-300 text-rose-700'
                : 'bg-slate-100 border-slate-300 text-slate-700'
          }`}
        >
          {toast.tone === 'success' ? <CheckCircle2 size={14} /> : toast.tone === 'error' ? <AlertTriangle size={14} /> : <Ban size={14} />}
          {toast.message}
        </div>
      )}
    </div>
  );
}

// Supplementary AI narrative (server/agents/keyword-narrative.js) — separate
// from AnalystExecutiveSummary's Python pipeline, styled as a subtler inline
// card (not the hero gradient) since it's a secondary panel on this page.
function NarrativePanel({ clientId }) {
  const [state, setState] = useState(null); // null=loading | {data|null, error?}

  useEffect(() => {
    setState(null);
    api.keywords.narrative(clientId)
      .then((data) => setState({ data }))
      .catch((e) => setState({ data: null, error: e.message || 'Failed to load keyword narrative.' }));
  }, [clientId]);

  if (state === null) {
    return <AnalystSkeletonLoader variant="card" />;
  }

  if (state.error) {
    return (
      <p className="text-xs font-semibold text-rose-600 p-2.5 rounded-xl bg-rose-50 border border-rose-500/25 mb-4">
        {state.error}
      </p>
    );
  }

  if (!state.data) {
    return (
      <div className="rounded-2xl bg-slate-100/40 border border-slate-200 p-4 mb-4 text-center">
        <p className="text-[11px] font-medium text-slate-500">
          Keyword analysis runs every 14 days. First report coming soon.
        </p>
      </div>
    );
  }

  const days = Math.floor((Date.now() - new Date(state.data.created_at)) / 86400000);
  const updatedLabel = days <= 0 ? 'Last updated today' : `Last updated ${days} day${days === 1 ? '' : 's'} ago`;

  return (
    <div className="rounded-2xl bg-slate-50 border border-indigo-200/40 p-4 mb-4">
      <div className="flex items-center gap-2 mb-2 text-indigo-500">
        <Sparkles size={13} />
        <span className="text-[10px] font-black uppercase tracking-wider">AI Narrative</span>
      </div>
      <p className="text-xs font-medium text-slate-700 leading-relaxed whitespace-pre-line">{state.data.narrative}</p>
      <p className="text-[9.5px] font-medium text-slate-400 mt-3 pt-2 border-t border-slate-200">{updatedLabel}</p>
    </div>
  );
}

function ClustersTab({ state }) {
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  const toggleExpanded = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (state === null) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AnalystSkeletonLoader variant="card" />
        <AnalystSkeletonLoader variant="card" />
      </div>
    );
  }

  const clusters = state.data || [];

  if (state.error) {
    return (
      <p className="text-xs font-semibold text-rose-600 p-2.5 rounded-xl bg-rose-50 border border-rose-500/25">
        {state.error}
      </p>
    );
  }

  if (clusters.length === 0) {
    return (
      <AnalystEmptyState
        icon={Layers}
        title="No Keyword Clusters Yet"
        description="The clustering agent groups semantically-similar search queries into topic clusters every 14 days. Check back after the next run."
        compact
      />
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {clusters.map((cluster, idx) => {
        const clusterId = cluster.id ?? idx;
        const typeMeta = CLUSTER_TYPE_META[cluster.cluster_type] || CLUSTER_TYPE_META.general;
        const keywords = cluster.keywords_json || [];
        const expanded = expandedIds.has(clusterId);
        const hasGap = Number(cluster.gap_score) > 0;

        return (
          <div key={clusterId} className="rounded-2xl bg-slate-100/40 border border-slate-200 p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11.5px] font-bold text-slate-800 truncate">{cluster.cluster_name}</p>
                <span className={`an-chip mt-1.5 ${typeMeta.chip}`}>{typeMeta.label}</span>
              </div>
              {hasGap && (
                <span className="an-chip an-chip-amber shrink-0">
                  <Target size={9} />
                  Gap {Math.round(cluster.gap_score).toLocaleString()}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-slate-200 text-[9.5px] font-semibold text-slate-500">
              <span>Avg. Impressions {Math.round(cluster.avg_impressions).toLocaleString()}</span>
              <span>Avg. Position {cluster.avg_position != null ? Number(cluster.avg_position).toFixed(1) : '—'}</span>
            </div>

            <button
              type="button"
              onClick={() => toggleExpanded(clusterId)}
              className="flex items-center gap-1 mt-2.5 text-[9.5px] font-bold text-indigo-500 hover:text-indigo-600 transition cursor-pointer"
            >
              {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {keywords.length} keyword{keywords.length === 1 ? '' : 's'}
            </button>

            {expanded && (
              <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto custom-scrollbar pr-1">
                {keywords.map((kw, kwIdx) => (
                  <li key={kwIdx} className="flex items-center justify-between gap-2 text-[9.5px] font-semibold text-slate-500 bg-slate-100 rounded-lg px-2 py-1">
                    <span className="truncate">{kw.keyword}</span>
                    <span className="shrink-0 text-slate-400">
                      {kw.impressions != null ? Math.round(kw.impressions).toLocaleString() : '—'} impr · pos {kw.avg_position != null ? Number(kw.avg_position).toFixed(1) : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GapsTab({ state, onUpdateStatus }) {
  const [filter, setFilter] = useState('all');

  const gaps = state?.data || [];
  const filtered = useMemo(() => {
    if (filter === 'all') return gaps;
    return gaps.filter((g) => g.status === filter);
  }, [gaps, filter]);

  if (state === null) {
    return <AnalystSkeletonLoader variant="list" rows={4} />;
  }

  if (state.error) {
    return (
      <p className="text-xs font-semibold text-rose-600 p-2.5 rounded-xl bg-rose-50 border border-rose-500/25">
        {state.error}
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-1 mb-3 overflow-x-auto no-scrollbar">
        {['all', 'pending_review', 'approved', 'rejected'].map((key) => {
          const active = filter === key;
          const label = key === 'all' ? 'All' : GAP_STATUS_META[key].label;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`text-[8.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border transition ${
                active
                  ? 'bg-slate-100 border-white/15 text-slate-900'
                  : 'bg-slate-200/60 border-slate-200 text-slate-400 hover:text-slate-800'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <AnalystEmptyState
          icon={Inbox}
          title="No Keyword Gaps"
          description="No zero-coverage topics identified for this filter yet — the clustering agent's gap analysis runs every 14 days."
          compact
        />
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[11px] min-w-[560px]">
            <thead>
              <tr className="text-[9px] font-black uppercase tracking-wider text-slate-400 border-b border-slate-200">
                <th className="text-left font-black py-2 px-1">Topic</th>
                <th className="text-left font-black py-2 px-1">Reason</th>
                <th className="text-left font-black py-2 px-1">Priority</th>
                <th className="text-left font-black py-2 px-1">Source</th>
                <th className="text-left font-black py-2 px-1">Status</th>
                <th className="text-right font-black py-2 px-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((gap) => {
                const priorityMeta = SEVERITY_META[gap.priority] || SEVERITY_META.low;
                const statusMeta = GAP_STATUS_META[gap.status] || GAP_STATUS_META.pending_review;
                const sourceMeta = GAP_SOURCE_META[gap.source] || GAP_SOURCE_META.internal_analysis;
                const pending = gap.status === 'pending_review';

                return (
                  <tr key={gap.id} className="border-b border-slate-200/60 last:border-0">
                    <td className="py-2 px-1 font-bold text-slate-800">{gap.topic}</td>
                    <td className="py-2 px-1 font-medium text-slate-500 max-w-[220px] truncate">{gap.reason || '—'}</td>
                    <td className="py-2 px-1">
                      <span
                        className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{ color: priorityMeta.color, backgroundColor: priorityMeta.bg }}
                      >
                        {priorityMeta.label}
                      </span>
                    </td>
                    <td className="py-2 px-1">
                      <span className={`an-chip ${sourceMeta.chip}`}>
                        {gap.source === 'claude_research' && <Sparkles size={9} />}
                        {sourceMeta.label}
                      </span>
                    </td>
                    <td className="py-2 px-1">
                      <span className={`an-chip ${statusMeta.chip}`}>{statusMeta.label}</span>
                    </td>
                    <td className="py-2 px-1">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onUpdateStatus(gap, 'approved')}
                          disabled={!pending}
                          className="p-1 rounded-md text-slate-500 hover:text-emerald-600 hover:bg-slate-100 transition disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          title="Approve"
                        >
                          <CheckCircle2 size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onUpdateStatus(gap, 'rejected')}
                          disabled={!pending}
                          className="p-1 rounded-md text-slate-500 hover:text-rose-600 hover:bg-slate-100 transition disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          title="Dismiss"
                        >
                          <Ban size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProfileTab({ state }) {
  if (state === null) {
    return <AnalystSkeletonLoader variant="card" />;
  }

  if (state.error) {
    return (
      <p className="text-xs font-semibold text-rose-600 p-2.5 rounded-xl bg-rose-50 border border-rose-500/25">
        {state.error}
      </p>
    );
  }

  const profile = state.data;

  if (!profile) {
    return (
      <AnalystEmptyState
        icon={Fingerprint}
        title="No Site Profile Yet"
        description="The clustering agent profiles a site's industry and main topics as part of its own run — check back after the next one."
        compact
      />
    );
  }

  const topics = profile.main_topics || [];

  return (
    <div className="rounded-2xl bg-slate-100/40 border border-slate-200 p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-1">Industry</p>
          <p className="text-xs font-bold text-slate-800">{profile.industry || '—'}</p>
        </div>
        <div>
          <p className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-1">Site Type</p>
          <p className="text-xs font-bold text-slate-800">{profile.site_type || '—'}</p>
        </div>
      </div>

      <div>
        <p className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-1.5">Main Topics</p>
        {topics.length === 0 ? (
          <p className="text-[10px] font-medium text-slate-500">No topics identified yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {topics.map((topic, idx) => (
              <span key={idx} className="an-chip an-chip-violet">{topic}</span>
            ))}
          </div>
        )}
      </div>

      {profile.profiled_at && (
        <p className="text-[9.5px] font-medium text-slate-500 pt-2 border-t border-slate-200">
          Last profiled {new Date(profile.profiled_at).toLocaleDateString()}
        </p>
      )}
    </div>
  );
}
