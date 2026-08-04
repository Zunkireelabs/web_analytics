import React from 'react';
import { Sparkles, RefreshCw, Inbox, AlertCircle, Search } from 'lucide-react';

// Dark command-center empty state (styled to live on the /analyst page's
// deep-indigo surface; the light variant remains for other pages).
export default function AnalystEmptyState({
  icon: Icon = Inbox,
  title = 'No Data Available',
  description = 'There are currently no items or insights to display for this selection.',
  actionText,
  onAction,
  compact = false,
}) {
  if (compact) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-2xl bg-slate-100/50 border border-slate-200 text-slate-400">
        <div className="w-8 h-8 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0 text-slate-400">
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-slate-800">{title}</p>
          <p className="text-[11px] text-slate-500 font-medium truncate">{description}</p>
        </div>
        {actionText && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="text-xs font-bold text-indigo-500 hover:text-indigo-500 bg-indigo-50 px-3 py-1.5 rounded-xl border border-indigo-200 transition cursor-pointer"
          >
            {actionText}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-100/70 p-8 text-center flex flex-col items-center justify-center min-h-[220px]">
      <div className="w-12 h-12 rounded-2xl bg-slate-200/60 border border-slate-200 shadow-sm flex items-center justify-center text-slate-400 mb-3.5">
        <Icon size={22} className="text-slate-400" />
      </div>
      <h4 className="text-sm font-bold text-slate-800 mb-1">{title}</h4>
      <p className="text-xs text-slate-500 max-w-md font-medium leading-relaxed mb-4">{description}</p>
      {actionText && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="an-grad-btn inline-flex items-center gap-2 text-xs font-bold px-4 py-2 rounded-xl shadow transition cursor-pointer"
        >
          <Sparkles size={14} />
          {actionText}
        </button>
      )}
    </div>
  );
}