import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ChevronDown, ChevronUp, AlertTriangle, Layers, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { STATUS } from '../lib/palette.js';
import Badge from './Badge.jsx';
import AnalystCollapsible from './AnalystCollapsible.jsx';

const GAP_STATUS_TONE = { pending_review: 'amber', approved: 'green', rejected: 'grey' };

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
    <AnalystCollapsible
      title="Product topic map"
      subtitle="What search currently associates this product with, by capability"
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {error && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: STATUS.critical.text }}>
          <AlertTriangle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-14 rounded-card bg-muted animate-pulse" />)}
        </div>
      ) : map && map.capabilities.length === 0 ? (
        <p className="text-[13px] text-text bg-muted rounded-card px-4 py-3">
          No verified product capabilities yet — add some in Product Capabilities above to see how search
          currently associates this product with them.
        </p>
      ) : map ? (
        <div className="space-y-2">
          {map.capabilities.map(({ capability, clusters, gaps, visibility, trend }) => {
            const open = openCapabilityId === capability.id;
            const total = clusters.length + gaps.length;
            const trendColor = trend?.impressionsPctChange > 0 ? STATUS.good.text
              : trend?.impressionsPctChange < 0 ? STATUS.critical.text : STATUS.neutral.text;
            return (
              <div key={capability.id} className="rounded-card bg-white overflow-hidden" style={{ boxShadow: 'var(--ring)' }}>
                <button
                  type="button"
                  onClick={() => setOpenCapabilityId(open ? null : capability.id)}
                  aria-expanded={open}
                  className="w-full flex items-center gap-3 p-3.5 text-left cursor-pointer"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium text-fg">{capability.name}</span>
                      {capability.category && <Badge tone="primary">{capability.category}</Badge>}
                    </div>
                    <p className="text-xs text-faint mt-1">
                      {total === 0
                        ? 'No linked keyword activity yet'
                        : `${clusters.length} ranking cluster${clusters.length === 1 ? '' : 's'} · ${gaps.length} gap${gaps.length === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-faint">Visibility</div>
                    <div className="text-[13px] font-medium text-fg tnum">
                      {visibility.avgImpressions != null ? visibility.avgImpressions.toLocaleString() : '—'} impr
                      {visibility.avgPosition != null && <span className="text-faint font-normal"> · pos {visibility.avgPosition}</span>}
                    </div>
                    {trend ? (
                      <div className="flex items-center justify-end gap-1 text-xs mt-0.5" style={{ color: trendColor }}>
                        {trend.impressionsPctChange > 0 ? <TrendingUp size={11} /> : trend.impressionsPctChange < 0 ? <TrendingDown size={11} /> : <Minus size={11} />}
                        {trend.impressionsPctChange > 0 ? '+' : ''}{trend.impressionsPctChange}% since last check
                      </div>
                    ) : (
                      <div className="text-xs text-faint mt-0.5">Not enough history yet</div>
                    )}
                  </div>
                  {open ? <ChevronUp size={14} className="text-faint shrink-0" /> : <ChevronDown size={14} className="text-faint shrink-0" />}
                </button>

                {open && (
                  <div className="px-3.5 pb-3.5 space-y-3">
                    {clusters.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-fg mb-1.5">Ranking clusters</div>
                        <div className="flex flex-wrap gap-1.5">
                          {clusters.map((c) => (
                            <Badge key={c.cluster_name} tone="outline">{c.cluster_name}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {gaps.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-fg mb-1.5">Keyword gaps</div>
                        <div className="space-y-1">
                          {gaps.map((g) => (
                            <div key={g.id} className="flex items-center gap-2 text-[13px] text-fg bg-muted rounded-control px-2.5 py-1.5">
                              <Badge tone={GAP_STATUS_TONE[g.status] || 'grey'} className="shrink-0">{g.status.replace('_', ' ')}</Badge>
                              <span className="truncate">{g.topic}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {total === 0 && (
                      <p className="text-xs text-faint">
                        Nothing discovered for this capability yet — the clustering agent runs every 14 days.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {(map.unmapped.clusters.length > 0 || map.unmapped.gaps.length > 0) && (
            <div className="rounded-card p-3.5" style={{ background: STATUS.warning.tint }}>
              <div className="flex items-center gap-2 mb-1.5">
                <Layers size={13} className="shrink-0" style={{ color: STATUS.warning.color }} />
                <span className="text-[13px] font-medium text-fg">Not linked to any verified capability</span>
              </div>
              <p className="text-xs text-text">
                {map.unmapped.clusters.length} cluster{map.unmapped.clusters.length === 1 ? '' : 's'} and{' '}
                {map.unmapped.gaps.length} gap{map.unmapped.gaps.length === 1 ? '' : 's'} don't match anything in
                Product Capabilities — either the capability list is incomplete, or these are genuinely
                off-product topics.
              </p>
            </div>
          )}
        </div>
      ) : null}
    </AnalystCollapsible>
  );
}
