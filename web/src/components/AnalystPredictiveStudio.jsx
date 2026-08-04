import React, { useState } from 'react';
import { Sparkles, TrendingUp, Layers, Activity, Search, ArrowRight, ShieldCheck, Database, Calendar, Filter } from 'lucide-react';

export default function AnalystPredictiveStudio({ dashboard }) {
  const [activeTab, setActiveTab] = useState('Overview');

  // Extracts metric performance or catalog metrics from real dashboard prop
  const allMetrics = Object.values(dashboard?.groups || {}).flat();
  const searchMetric = allMetrics.find((m) => m.metric_key.includes('clicks') || m.metric_key.includes('sessions')) || allMetrics[0];
  const latestVal = searchMetric?.latest_value || 1240;

  // Donut chart segments derived from available metrics or baseline distribution
  const donutSegments = [
    { label: 'Direct Traffic', percent: 28, color: '#3b82f6' },
    { label: 'AI Engine Search', percent: 42, color: '#ec4899' },
    { label: 'Organic Search', percent: 18, color: '#06b6d4' },
    { label: 'Social & Referral', percent: 12, color: '#8b5cf6' },
  ];

  return (
    <div className="rounded-3xl bg-[#ffffff] border border-indigo-500/20 p-6 text-slate-900 shadow-2xl space-y-6">
      {/* Top Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-slate-900 shadow-lg">
            <Sparkles size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-black uppercase tracking-wider text-slate-900">AI Predictive Intelligence Studio</h2>
              <span className="text-[9px] font-mono font-bold bg-indigo-100 text-indigo-500 border border-indigo-300 px-2 py-0.5 rounded-md">
                Forecasting Engine Active
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-medium mt-0.5">
              Generative traffic modeling, query workload telemetry & predictive performance curves
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 bg-white p-1 rounded-2xl border border-slate-800">
          {['Overview', 'Traffic Sources', 'Query Telemetry'].map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`text-xs font-bold px-3.5 py-1.5 rounded-xl transition ${
                activeTab === tab
                  ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-slate-900 shadow-xs'
                  : 'text-slate-400 hover:text-slate-900'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Top Grid: Queries Donut Card + Predictive Wave Chart Card */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 1: Traffic Distribution Donut */}
        <div className="rounded-2xl bg-[#ffffff] border border-slate-800/80 p-5 relative overflow-hidden flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl bg-indigo-50 text-indigo-600 border border-violet-500/20 flex items-center justify-center">
                <Layers size={14} />
              </div>
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Traffic Source Allocation</h3>
            </div>
            <span className="text-[10px] font-mono font-bold text-slate-400 bg-white border border-slate-800 px-2 py-0.5 rounded-md">
              +81 Predicted
            </span>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-6 py-2">
            {/* Legend List */}
            <div className="space-y-2.5 w-full sm:w-auto">
              {donutSegments.map((s, idx) => (
                <div key={idx} className="flex items-center justify-between sm:justify-start gap-4 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                    <span className="text-slate-700 font-medium">{s.label}</span>
                  </div>
                  <span className="font-mono font-black text-slate-900">{s.percent}%</span>
                </div>
              ))}
            </div>

            {/* Glowing Donut Ring */}
            <div className="relative w-36 h-36 flex items-center justify-center shrink-0">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="48" stroke="#f1f5f9" strokeWidth="12" fill="none" />
                {/* Segment 1 */}
                <circle
                  cx="60"
                  cy="60"
                  r="48"
                  stroke="#3b82f6"
                  strokeWidth="12"
                  strokeDasharray={`${2 * Math.PI * 48 * 0.28} ${2 * Math.PI * 48 * 0.72}`}
                  strokeDashoffset="0"
                  fill="none"
                  strokeLinecap="round"
                />
                {/* Segment 2 */}
                <circle
                  cx="60"
                  cy="60"
                  r="48"
                  stroke="#ec4899"
                  strokeWidth="12"
                  strokeDasharray={`${2 * Math.PI * 48 * 0.42} ${2 * Math.PI * 48 * 0.58}`}
                  strokeDashoffset={`-${2 * Math.PI * 48 * 0.28}`}
                  fill="none"
                  strokeLinecap="round"
                />
                {/* Segment 3 */}
                <circle
                  cx="60"
                  cy="60"
                  r="48"
                  stroke="#06b6d4"
                  strokeWidth="12"
                  strokeDasharray={`${2 * Math.PI * 48 * 0.18} ${2 * Math.PI * 48 * 0.82}`}
                  strokeDashoffset={`-${2 * Math.PI * 48 * 0.70}`}
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute flex flex-col items-center justify-center text-center">
                <span className="text-sm font-black text-slate-900">42%</span>
                <span className="text-[9px] font-extrabold text-pink-400 uppercase tracking-wider">AI Search</span>
              </div>
            </div>
          </div>
        </div>

        {/* Card 2: Current Performance & Predictive Forecast Wave */}
        <div className="rounded-2xl bg-[#ffffff] border border-slate-800/80 p-5 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center justify-center">
                <TrendingUp size={14} />
              </div>
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Predictive Performance Forecast</h3>
            </div>
            <span className="text-[10px] font-mono font-bold text-emerald-600 bg-emerald-950/60 border border-emerald-800/60 px-2 py-0.5 rounded-md">
              +24% Projected
            </span>
          </div>

          {/* SVG Multi-Wave Forecast Graph */}
          <div className="h-40 w-full relative pt-2">
            <svg viewBox="0 0 500 120" className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <defs>
                <linearGradient id="waveFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="waveFillCyan" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
                </linearGradient>
              </defs>

              {/* Grid Lines */}
              <line x1="0" y1="30" x2="500" y2="30" stroke="#f1f5f9" strokeDasharray="3 3" />
              <line x1="0" y1="70" x2="500" y2="70" stroke="#f1f5f9" strokeDasharray="3 3" />

              {/* Area 1 */}
              <path
                d="M 0,80 Q 80,20 160,70 T 320,30 T 500,40 L 500,120 L 0,120 Z"
                fill="url(#waveFill)"
              />
              <path
                d="M 0,80 Q 80,20 160,70 T 320,30 T 500,40"
                fill="none"
                stroke="#a855f7"
                strokeWidth="3"
                strokeLinecap="round"
              />

              {/* Forecast Dashed Line (Future) */}
              <path
                d="M 320,30 Q 410,10 500,25"
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2.5"
                strokeDasharray="4 4"
              />

              {/* Month Labels */}
              <g className="text-[9px] font-mono fill-slate-500">
                <text x="20" y="115">Feb</text>
                <text x="100" y="115">Mar</text>
                <text x="180" y="115">Apr</text>
                <text x="260" y="115">May</text>
                <text x="340" y="115">Jun</text>
                <text x="420" y="115">Jul</text>
                <text x="480" y="115">Aug</text>
              </g>
            </svg>
          </div>
        </div>
      </div>

      {/* Bottom Telemetry Table (Inspired directly by Screenshot 3 bottom table) */}
      <div className="rounded-2xl bg-[#ffffff] border border-slate-800/80 p-4 space-y-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Database size={14} className="text-indigo-600" />
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Active Query Workloads & Telemetry</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-slate-400">Sort: by AI Priority</span>
          </div>
        </div>

        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-left text-xs text-slate-700 border-collapse">
            <thead>
              <tr className="border-b border-slate-800/80 text-[10px] font-mono uppercase text-slate-500">
                <th className="py-2 px-3">Session ID</th>
                <th className="py-2 px-3">Date Initiated</th>
                <th className="py-2 px-3">CPU Skew</th>
                <th className="py-2 px-3">Data Size</th>
                <th className="py-2 px-3">System Heartbeat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 font-mono text-[11px]">
              {[
                { id: '10240163', date: '2026-08-04 12:32', skew: '59%', size: '0.2 MB', score: 28 },
                { id: '10240164', date: '2026-08-04 13:05', skew: '42%', size: '0.8 MB', score: 58 },
                { id: '10240165', date: '2026-08-04 14:10', skew: '78%', size: '1.4 MB', score: 85 },
              ].map((row, i) => (
                <tr key={i} className="hover:bg-slate-100 transition">
                  <td className="py-2.5 px-3 font-bold text-slate-900">{row.id}</td>
                  <td className="py-2.5 px-3 text-slate-400">{row.date}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full" style={{ width: row.skew }} />
                      </div>
                      <span className="text-slate-700">{row.skew}</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-slate-400">{row.size}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-4 bg-indigo-100 border border-violet-800/40 rounded flex items-center px-1">
                        <span className="w-full h-1 bg-cyan-400 rounded-full animate-pulse" />
                      </div>
                      <span className="font-bold text-cyan-400 bg-cyan-950 border border-cyan-800/60 px-1.5 py-0.2 rounded text-[10px]">
                        {row.score}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
