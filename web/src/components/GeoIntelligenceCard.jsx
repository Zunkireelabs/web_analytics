import { useState } from 'react';
import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';
import Sparkline from './Sparkline.jsx';
import { AlertTriangle, Globe2, TrendingUp, Compass, ArrowUpRight, ArrowDownRight } from 'lucide-react';

function emptyMessage(meta) {
  if (!meta?.hasRun) return 'Geographical intelligence not analyzed yet — runs monthly.';
  if (meta.status === 'error') return 'Last run failed — check Integration Health below.';
  return `Last run (${timeAgo(meta.lastRunAt)}) completed but returned no geographical traffic.`;
}

export default function GeoIntelligenceCard({ geoIntelligence, meta, loading }) {
  const [showDetails, setShowDetails] = useState(false);

  // Compute primary metric: Top country traffic share %
  const topCountries = geoIntelligence?.topCountries || [];
  const totalSessions = topCountries.reduce((acc, c) => acc + (c.sessions || 0), 0);
  const topCountry = topCountries[0] || null;
  const topCountryShare = totalSessions > 0 && topCountry ? Math.round((topCountry.sessions / totalSessions) * 100) : 0;
  
  const animatedShare = useCountUp(topCountryShare, 900);

  if (loading) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm animate-pulse h-[180px] flex flex-col justify-between">
        <div className="space-y-3">
          <div className="h-3 w-28 bg-slate-100 rounded" />
          <div className="h-8 w-20 bg-slate-250 rounded" />
        </div>
        <div className="h-4 w-full bg-slate-100 rounded" />
      </div>
    );
  }

  if (!geoIntelligence) {
    return (
      <div className="flex items-center gap-3 rounded-3xl border border-amber-200/60 bg-gradient-to-r from-amber-500/[0.03] to-amber-500/[0.01] p-5 text-xs text-slate-500 font-semibold shadow-sm relative overflow-hidden min-h-[140px]">
        <div className="absolute left-0 inset-y-0 w-1.5 bg-amber-500" />
        <span className="w-8 h-8 rounded-xl grid place-items-center bg-amber-550/10 text-amber-600 shrink-0">
          <AlertTriangle size={15} strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="font-black text-amber-700 block text-[10px] uppercase tracking-wider mb-0.5">Analysis Pending</span>
          <span className="leading-relaxed text-slate-500">{emptyMessage(meta)}</span>
        </div>
      </div>
    );
  }

  const sparklineData = topCountries.map((c) => c.sessions).slice(0, 5);
  const growing = geoIntelligence.growingMarkets || [];
  const declining = geoIntelligence.decliningMarkets || [];
  const topLanguages = geoIntelligence.topLanguages || [];
  const lowCtr = geoIntelligence.lowCtrCountries || [];

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-6 hover:shadow-md transition-all duration-300 text-slate-700">
      {/* Top Main Share Segment */}
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <Globe2 size={12} className="text-sky-500" />
            <span>Geographic Audience Share</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-black tracking-tight text-slate-900 tabular-nums">{animatedShare}</span>
            <span className="text-xs font-bold text-slate-400">% share</span>
          </div>
          {topCountry && (
            <div className="text-[10.5px] font-semibold text-slate-500 mt-2">
              Primary Market: <span className="text-slate-800 font-bold">{topCountry.country}</span> ({topCountry.sessions.toLocaleString()} sessions total)
            </div>
          )}
        </div>
        {sparklineData.length >= 2 && (
          <div className="w-24 h-12 shrink-0 bg-slate-50/50 rounded-xl p-1.5 border border-slate-100">
            <Sparkline data={sparklineData} color="#0ea5e9" stretch dot={false} />
          </div>
        )}
      </div>

      {/* Collapsed view growing markets summary */}
      {!showDetails && growing.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100/85 space-y-2.5 animate-fade-in">
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Growing Market Vectors</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {growing.slice(0, 3).map((g) => (
              <div key={g.country} className="bg-emerald-500/[0.03] border border-emerald-500/10 rounded-xl p-2.5 flex flex-col justify-between shadow-sm">
                <span className="text-[10px] font-bold text-slate-550 truncate leading-snug">{g.country}</span>
                <span className="text-[11px] font-black mt-1 text-emerald-600 flex items-center gap-0.5 tabular-nums">
                  <ArrowUpRight size={10} strokeWidth={3} /> +{g.delta.toLocaleString()} sessions
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expanded Grid Section (Evenly Distributed Left and Right) */}
      <div className="mt-4 pt-4 border-t border-slate-100">
        <button 
          type="button" 
          onClick={() => setShowDetails((s) => !s)}
          className="text-[10px] font-black uppercase tracking-wider text-sky-500 hover:text-sky-650 hover:underline flex items-center gap-1 focus:outline-none cursor-pointer"
        >
          {showDetails ? 'Hide detailed market analysis ↑' : 'Show detailed market analysis ↓'}
        </button>
        
        {showDetails && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4 pt-4 border-t border-slate-100 items-stretch animate-slide-down">
            {/* Left Column: Growing and Declining markets list */}
            <div className="space-y-4 flex flex-col">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Target Session Deltas</div>
              <div className="space-y-2.5 flex-1">
                {growing.slice(0, 3).map((g) => (
                  <div key={g.country} className="bg-emerald-500/[0.03] border border-emerald-500/10 rounded-xl p-3 flex items-center justify-between gap-3 shadow-sm animate-fade-in">
                    <div>
                      <div className="text-xs font-bold text-slate-800 leading-tight">{g.country}</div>
                      <div className="text-[9.5px] text-slate-450 font-bold mt-1">Grew from {g.prior} to {g.recent} sessions</div>
                    </div>
                    <span className="text-xs font-black text-emerald-600 flex items-center gap-0.5 shrink-0 tabular-nums">
                      <ArrowUpRight size={12} strokeWidth={2.5} /> +{g.delta.toLocaleString()}
                    </span>
                  </div>
                ))}
                {declining.slice(0, 2).map((d) => (
                  <div key={d.country} className="bg-rose-500/[0.03] border border-rose-500/10 rounded-xl p-3 flex items-center justify-between gap-3 shadow-sm animate-fade-in">
                    <div>
                      <div className="text-xs font-bold text-slate-800 leading-tight">{d.country}</div>
                      <div className="text-[9.5px] text-slate-455 font-bold mt-1">Dropped from {d.prior} to {d.recent} sessions</div>
                    </div>
                    <span className="text-xs font-black text-rose-500 flex items-center gap-0.5 shrink-0 tabular-nums">
                      <ArrowDownRight size={12} strokeWidth={2.5} /> -{Math.abs(d.delta).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Right Column: Languages Share and Alerts */}
            <div className="space-y-4 flex flex-col">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                <Compass size={11} className="text-sky-500" />
                <span>Audience Demographics & CTR Health</span>
              </div>
              <div className="bg-slate-905 border border-slate-100 bg-slate-50 rounded-2xl p-4 flex-1 flex flex-col justify-between space-y-4 shadow-inner">
                <div className="space-y-2">
                  <div className="text-[8px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 pb-1.5 mb-1.5">Top Language Segments</div>
                  {topLanguages.slice(0, 3).map((l, i) => (
                    <div key={i} className="flex justify-between items-center text-[10px] font-mono leading-tight">
                      <span className="text-slate-500 font-bold">{l.language}</span>
                      <span className="text-sky-600 font-bold tabular-nums">{l.sessions.toLocaleString()} sessions</span>
                    </div>
                  ))}
                </div>

                {lowCtr.length > 0 && (
                  <div className="border-t border-slate-205 pt-3">
                    <div className="text-[8px] font-black uppercase tracking-widest text-rose-600 mb-2 flex items-center gap-0.5">
                      <AlertTriangle size={9} /> Search Anomalies (Low CTR)
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {lowCtr.map((c) => (
                        <span key={c.country} className="text-[9px] font-mono font-bold px-2 py-0.5 rounded bg-rose-50 border border-rose-100 text-rose-600">
                          {c.country}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
