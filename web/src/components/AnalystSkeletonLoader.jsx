import React from 'react';

export default function AnalystSkeletonLoader({ variant = 'card', rows = 3 }) {
  if (variant === 'hero') {
    return (
      <div className="rounded-3xl p-7 bg-white border border-slate-800 text-slate-900 relative overflow-hidden animate-pulse">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-xl bg-slate-100" />
          <div className="space-y-2 flex-1">
            <div className="h-4 bg-slate-100 rounded-md w-1/4" />
            <div className="h-3 bg-slate-100 rounded-md w-1/3" />
          </div>
        </div>
        <div className="h-8 bg-slate-100 rounded-lg w-2/3 mb-6" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-slate-100 rounded-2xl border border-slate-800 p-4 space-y-2">
              <div className="h-3 bg-slate-700/50 rounded w-1/3" />
              <div className="h-4 bg-slate-700/30 rounded w-5/6" />
              <div className="h-3 bg-slate-700/20 rounded w-4/6" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (variant === 'list') {
    return (
      <div className="space-y-2.5 animate-pulse">
        {Array.from({ length: rows }).map((_, idx) => (
          <div key={idx} className="flex items-center gap-3 p-3 rounded-2xl border border-slate-800 bg-slate-100/80">
            <div className="w-6 h-6 rounded-lg bg-slate-100 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 bg-slate-100 rounded w-3/4" />
              <div className="h-2.5 bg-slate-100 rounded w-1/2" />
            </div>
            <div className="w-12 h-4 bg-slate-100 rounded-md shrink-0" />
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'chart') {
    return (
      <div className="an-panel p-6 space-y-4 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-4 bg-slate-100 rounded w-1/3" />
          <div className="h-6 bg-slate-100 rounded-lg w-20" />
        </div>
        <div className="h-48 bg-slate-100/80 rounded-2xl flex items-end justify-between p-4 gap-2">
          {[40, 65, 30, 85, 55, 70, 90, 45, 60, 80].map((h, i) => (
            <div key={i} className="w-full bg-slate-100 rounded-t-lg" style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="an-panel p-6 space-y-4 animate-pulse">
      <div className="flex items-center gap-2">
        <div className="w-4 h-4 rounded bg-slate-100" />
        <div className="h-4 bg-slate-100 rounded w-1/3" />
      </div>
      <div className="space-y-2">
        <div className="h-3.5 bg-slate-200/60 rounded w-5/6" />
        <div className="h-3.5 bg-slate-100 rounded w-4/6" />
      </div>
    </div>
  );
}