import React from 'react';

// Loading placeholders shaped like the cards they stand in for — grey blocks
// (bg-muted) inside the same tray + white card the real sections use.
function Shell({ children }) {
  return (
    <div className="tray">
      <div className="tray-card p-4 animate-pulse">{children}</div>
    </div>
  );
}

export default function AnalystSkeletonLoader({ variant = 'card', rows = 3 }) {
  if (variant === 'hero') {
    return (
      <Shell>
        <div className="space-y-2 mb-5">
          <div className="h-4 bg-muted rounded-control w-1/4" />
          <div className="h-3 bg-muted rounded-control w-1/3" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-muted rounded-card p-4 space-y-2">
              <div className="h-3 bg-white/70 rounded w-1/3" />
              <div className="h-4 bg-white/70 rounded w-5/6" />
              <div className="h-3 bg-white/70 rounded w-4/6" />
            </div>
          ))}
        </div>
      </Shell>
    );
  }

  if (variant === 'list') {
    return (
      <div className="space-y-2 animate-pulse">
        {Array.from({ length: rows }).map((_, idx) => (
          <div key={idx} className="flex items-center gap-3 p-3 rounded-card bg-muted">
            <div className="w-6 h-6 rounded-control bg-white/70 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 bg-white/70 rounded w-3/4" />
              <div className="h-2.5 bg-white/70 rounded w-1/2" />
            </div>
            <div className="w-12 h-4 bg-white/70 rounded-control shrink-0" />
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'chart') {
    return (
      <Shell>
        <div className="flex items-center justify-between mb-4">
          <div className="h-4 bg-muted rounded-control w-1/3" />
          <div className="h-6 bg-muted rounded-control w-20" />
        </div>
        <div className="h-48 bg-muted rounded-card flex items-end justify-between p-4 gap-2">
          {[40, 65, 30, 85, 55, 70, 90, 45, 60, 80].map((h, i) => (
            <div key={i} className="w-full bg-white/70 rounded-t-control" style={{ height: `${h}%` }} />
          ))}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center gap-2 mb-4">
        <div className="w-4 h-4 rounded bg-muted" />
        <div className="h-4 bg-muted rounded-control w-1/3" />
      </div>
      <div className="space-y-2">
        <div className="h-3.5 bg-muted rounded-control w-5/6" />
        <div className="h-3.5 bg-muted rounded-control w-4/6" />
      </div>
    </Shell>
  );
}
