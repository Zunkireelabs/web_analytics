import React from 'react';
import { Sparkles, Inbox } from 'lucide-react';
import Button from './Button.jsx';

// Empty state for the Analyst page — the same dashed-tile empty treatment as
// the rest of the app, with an optional action.
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
      <div className="flex items-center gap-3 p-4 rounded-card bg-muted">
        <div className="w-8 h-8 rounded-control bg-white grid place-items-center shrink-0 text-faint" style={{ boxShadow: 'var(--ring)' }}>
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg">{title}</p>
          <p className="text-xs text-faint truncate">{description}</p>
        </div>
        {actionText && onAction && (
          <Button variant="light" size="sm" onClick={onAction}>{actionText}</Button>
        )}
      </div>
    );
  }

  return (
    <div className="tray">
      <div className="tray-card p-8 text-center flex flex-col items-center justify-center min-h-[220px]">
        <div className="w-11 h-11 rounded-card bg-muted grid place-items-center text-faint mb-3.5">
          <Icon size={20} />
        </div>
        <h4 className="text-[15px] font-semibold text-fg mb-1">{title}</h4>
        <p className="text-[13px] text-text max-w-md leading-5 mb-4">{description}</p>
        {actionText && onAction && (
          <Button variant="primary" onClick={onAction}>
            <Sparkles size={14} />
            {actionText}
          </Button>
        )}
      </div>
    </div>
  );
}
