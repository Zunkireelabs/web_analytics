import { Children, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { DEFAULT_ROW_LIMIT, visibleRows } from './list-rows.js';

// A titled tray holding one white card. A long list never gets its own scroll box (a scroll area inside a page that
// already scrolls steals the wheel and cuts rows in half): it shows its first `limit` rows, and "Show all" opens the
// rest in place, so the page has exactly one scroll. The header and footer stay put.
export default function ListCard({ title, subtitle, action, footer, empty, children, limit = DEFAULT_ROW_LIMIT }) {
  const [expanded, setExpanded] = useState(false);
  const rows = Children.toArray(children);
  const shown = visibleRows(rows, limit, expanded);
  const hidden = rows.length - shown.length;
  return (
    <div className="tray">
      <div className="col-span-full flex items-end justify-between gap-3 px-2.5 pt-1.5 pb-1">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
          {subtitle && <p className="text-xs text-faint">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="tray-card overflow-hidden">
        {empty
          ? <div className="px-4 py-6 text-[13px] text-text">{empty}</div>
          : <div>{shown}</div>}
        {!empty && rows.length > limit && (
          <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 border-t border-border text-[13px] font-medium text-primary-strong hover:bg-muted">
            {expanded ? 'Show fewer' : `Show all ${rows.length}`}
            <ChevronDown size={14} className={expanded ? 'rotate-180' : ''} aria-hidden />
            {!expanded && hidden > 0 && <span className="sr-only">({hidden} more)</span>}
          </button>
        )}
        {footer && <div className="tbl-foot">{footer}</div>}
      </div>
    </div>
  );
}

export const ROW = 'flex items-start gap-3 px-4 py-2.5 border-t border-border first:border-t-0 text-[13px]';
