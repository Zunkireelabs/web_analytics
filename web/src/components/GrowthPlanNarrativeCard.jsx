import { Sparkles, Bot, ArrowRight, ShieldCheck, CheckCircle2, TrendingUp, Compass } from 'lucide-react';
import { timeAgo } from '../api.js';

const STEPS = [
  {
    key: 'currentStateSummary',
    number: '01',
    label: 'Where You Stand',
    icon: Compass,
    accent: 'from-amber-500/10 to-amber-500/0 border-amber-200/60 text-amber-600',
    badge: 'Baseline Status',
  },
  {
    key: 'growthPlan',
    number: '02',
    label: 'How Our Agents Grow You',
    icon: Bot,
    accent: 'from-indigo-500/10 to-indigo-500/0 border-indigo-200/60 text-indigo-600',
    badge: 'Active AI Strategy',
  },
  {
    key: 'twoMonthOutlook',
    number: '03',
    label: 'In ~2 Months',
    icon: TrendingUp,
    accent: 'from-emerald-500/10 to-emerald-500/0 border-emerald-200/60 text-emerald-600',
    badge: 'Projected Target',
  },
];

export default function GrowthPlanNarrativeCard({ growthPlan, loading }) {
  if (loading) {
    return (
      <div className="card p-6 text-center space-y-2 animate-pulse">
        <div className="h-4 bg-slate-200 rounded w-1/4 mx-auto" />
        <div className="h-16 bg-slate-100 rounded" />
      </div>
    );
  }

  if (!growthPlan?.available) {
    return null;
  }

  return (
    <div className="card p-6 space-y-6 border border-[#6C63FF]/20 bg-gradient-to-br from-indigo-500/[0.03] via-purple-500/[0.02] to-white/90 shadow-md fade-up">
      {/* Header with AI Active Badge */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-slate-200/60">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-[#6C63FF] to-[#8b5cf6] text-white grid place-items-center shadow-md shadow-indigo-500/25 shrink-0">
            <Sparkles size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-black text-slate-900 tracking-tight">Your Custom Growth Roadmap</h3>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider text-indigo-700 bg-indigo-100/80 border border-indigo-200/50 shadow-2xs">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 animate-ping" />
                AI Agent Active
              </span>
            </div>
            <p className="text-xs text-slate-400 font-medium mt-0.5">
              Grounded in your real onboarding baseline & automated site audit findings
            </p>
          </div>
        </div>
        {growthPlan.generatedAt && (
          <span className="text-[10px] font-bold text-slate-400 bg-slate-100/80 px-2.5 py-1 rounded-full border border-slate-200/50 shrink-0">
            Updated {timeAgo(growthPlan.generatedAt)}
          </span>
        )}
      </div>

      {/* 3 Step Roadmap Cards */}
      <div className="grid md:grid-cols-3 gap-4">
        {STEPS.map(({ key, number, label, icon: Icon, accent, badge }) => (
          <div
            key={key}
            className="group relative p-5 rounded-2xl border border-slate-200/80 bg-white/90 hover:bg-white hover:border-slate-300 hover:shadow-lg transition-all duration-300 flex flex-col justify-between"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black font-mono text-slate-300 group-hover:text-indigo-600 transition-colors">
                    {number}
                  </span>
                  <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-slate-100 text-slate-600 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors`}>
                    {badge}
                  </span>
                </div>
                <div className={`w-7 h-7 rounded-xl grid place-items-center bg-slate-100 text-slate-500 group-hover:bg-indigo-600 group-hover:text-white transition-all duration-300`}>
                  <Icon size={14} />
                </div>
              </div>

              <div>
                <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider mb-1.5">{label}</h4>
                <p className="text-xs text-slate-600 font-medium leading-relaxed">{growthPlan[key]}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

