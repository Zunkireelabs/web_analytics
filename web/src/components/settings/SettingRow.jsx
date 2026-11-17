import { useState } from 'react';
import Badge from '../Badge.jsx';

// One settings line: what it is (with a short hint), its current value, and at most ONE action on the right.
// Editing happens in a popup the action opens, never in a form left open on the page, so a settings tab stays short.
// Phone: label on top, value under it, the action beside both. From 640px: label | value | action in one line.
export default function SettingRow({ label, hint, badge, value, muted = false, action }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[200px_minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 items-center py-3 border-b border-border last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-fg">{label}{badge && <Badge tone={badge.tone} className="ml-1.5 align-middle">{badge.label}</Badge>}</div>
        {hint && <div className="text-xs text-faint">{hint}</div>}
      </div>
      <div className={`min-w-0 text-sm row-start-2 sm:row-start-1 sm:col-start-2 ${muted ? 'text-faint' : 'text-fg'}`}>{value}</div>
      <div className="row-span-2 sm:row-span-1 col-start-2 sm:col-start-3 row-start-1 shrink-0">{action}</div>
    </div>
  );
}

// A list as chips: the first `fold` items, then "+N more". Opening it shows every item in place; "Show less" folds it.
export function ChipList({ items, fold = 2 }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, fold);
  const rest = items.length - fold;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {shown.map((t) => <Badge key={t} tone="grey">{t}</Badge>)}
      {rest > 0 && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-[13px] font-medium text-primary hover:underline">
          {open ? 'Show less' : `+${rest} more`}
        </button>
      )}
    </span>
  );
}
