import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Network, ChevronDown, ChevronUp, AlertTriangle, Layers, TrendingUp, TrendingDown, Minus } from 'lucide-react';

const GAP_STATUS_CHIP = { pending_review: 'an-chip-amber', approved: 'an-chip-emerald', rejected: 'an-chip-slate' };

// Product → capability → the keyword clusters/gaps that relate to it, with
// real visibility numbers — the read-time view buildProductTopicMap
// (server/agents/lib/analyst-seo-mapping.js) computes fresh on every load
// from product_capabilities/keyword_clusters/keyword_gaps. No separate
// "topic map" resource is ever created or edited here; this is a lens on
// data that already exists and is managed elsewhere (Product Capabilities
// above, Keyword Discovery below).
export default function AnalystTopicMap({ clientId }) {
  const [map, setMap] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [openCapabilityId, setOpenCapabilityId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setMap(null);
    setError(null);
    setExpanded(false);
    setOpenCapabilityId(null);
    api.keywords.topicMap(clientId)
      .then(setMap)
      .catch((e) => setError(e.message || 'Failed to load the topic map.'));
  }, [clientId]);

  const loading = map === null && !error;

  return (
    <div className="an-panel p-5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 cursor-pointer"
      >
        <div className="w-8 h-8 rounded-xl grid place-items-center bg-violet-500/10 border border-violet-500/25 text-violet-600 shrink-0">
          <Network size={15} />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Product Topic Map</h2>
          <p className="text-[11px] font-medium text-slate-500">
            What search currently associates this product with, by capability
          </p>
        </div>
        {expanded ? <ChevronUp size={14} className="text-slate-400 shrink-0" /> : <ChevronDown size={14} className="text-slate-400 shrink-0" />}
      </button>

      {expanded && (
        <div className="mt-4 space-y-3">
          {error && (
            <p className="text-[11px] font-semibold text-rose-600 flex items-center gap-1.5">
              <AlertTriangle size={11} className="shrink-0" />
              {error}
            </p>
          )}

          {loading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => <div key={i} className="h-14 rounded-xl bg-slate-200/50 animate-pulse" />)}
            </div>
          ) : map && map.capabilities.length === 0 ? (
            <p className="text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
              No verified product capabilities yet — add some in Product Capabilities above to see how search
              currently associates this product with them.
            </p>
          ) : map ? (
            <div className="space-y-2">
              {map.capabilities.map(({ capability, clusters, gaps, visibility, trend }) => {
                const open = openCapabilityId === capability.id;
                const total = clusters.length + gaps.length;
                return (
                  <div key={capability.id} className="rounded-xl border border-slate-200 bg-slate-100/40 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setOpenCapabilityId(open ? null : capability.id)}
                      className="w-full flex items-center gap-3 p-3.5 text-left cursor-pointer"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-black text-slate-800">{capability.name}</span>
                          {capability.category && <span className="an-chip an-chip-violet">{capability.category}</span>}
                        </div>
                        <p className="text-[10.5px] font-semibold text-slate-500 mt-1">
                          {total === 0
                            ? 'No linked keyword activity yet'
                            : `${clusters.length} ranking cluster${clusters.length === 1 ? '' : 's'} · ${gaps.length} gap${gaps.length === 1 ? '' : 's'}`}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Visibility</div>
                        <div className="text-xs font-black text-slate-800 tabular-nums">
                          {visibility.avgImpressions != null ? visibility.avgImpressions.toLocaleString() : '—'} impr
                          {visibility.avgPosition != null && <span className="text-slate-400 font-semibold"> · pos {visibility.avgPosition}</span>}
                        </div>
                        {trend ? (
                          <div className={`flex items-center justify-end gap-1 text-[10px] font-bold mt-0.5 ${
                            trend.impressionsPctChange > 0 ? 'text-emerald-600' : trend.impressionsPctChange < 0 ? 'text-rose-600' : 'text-slate-400'
                          }`}>
                            {trend.impressionsPctChange > 0 ? <TrendingUp size={10} /> : trend.impressionsPctChange < 0 ? <TrendingDown size={10} /> : <Minus size={10} />}
                            {trend.impressionsPctChange > 0 ? '+' : ''}{trend.impressionsPctChange}% since last check
                          </div>
                        ) : (
                          <div className="text-[10px] font-medium text-slate-400 mt-0.5">Not enough history yet</div>
                        )}
                      </div>
                      {open ? <ChevronUp size={13} className="text-slate-400 shrink-0" /> : <ChevronDown size={13} className="text-slate-400 shrink-0" />}
                    </button>

                    {open && (
                      <div className="px-3.5 pb-3.5 space-y-2.5">
                        {clusters.length > 0 && (
                          <div>
                            <div className="an-label mb-1.5">Ranking clusters</div>
                            <div className="flex flex-wrap gap-1.5">
                              {clusters.map((c) => (
                                <span key={c.cluster_name} className="an-chip an-chip-cyan">{c.cluster_name}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {gaps.length > 0 && (
                          <div>
                            <div className="an-label mb-1.5">Keyword gaps</div>
                            <div className="space-y-1">
                              {gaps.map((g) => (
                                <div key={g.id} className="flex items-center gap-2 text-[11px] font-semibold text-slate-700 bg-white rounded-lg px-2.5 py-1.5">
                                  <span className={`an-chip ${GAP_STATUS_CHIP[g.status] || 'an-chip-slate'} shrink-0`}>{g.status.replace('_', ' ')}</span>
                                  <span className="truncate">{g.topic}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {total === 0 && (
                          <p className="text-[10.5px] font-medium text-slate-400">
                            Nothing discovered for this capability yet — the clustering agent runs every 14 days.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {(map.unmapped.clusters.length > 0 || map.unmapped.gaps.length > 0) && (
                <div className="rounded-xl border border-amber-300/40 bg-amber-500/[0.05] p-3.5">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Layers size={12} className="text-amber-600 shrink-0" />
                    <span className="an-label">Not linked to any verified capability</span>
                  </div>
                  <p className="text-[10.5px] font-medium text-slate-500">
                    {map.unmapped.clusters.length} cluster{map.unmapped.clusters.length === 1 ? '' : 's'} and{' '}
                    {map.unmapped.gaps.length} gap{map.unmapped.gaps.length === 1 ? '' : 's'} don't match anything in
                    Product Capabilities — either the capability list is incomplete, or these are genuinely
                    off-product topics.
                  </p>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
