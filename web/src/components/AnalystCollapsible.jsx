import { ChevronDown, ChevronUp } from 'lucide-react';
import { Tray } from './layout/Tray.jsx';

// A TrayCard whose header is the toggle: same header typography as TrayCard,
// used by the two collapsed-by-default Evidence cards on the Analyst page.
export default function AnalystCollapsible({ title, subtitle, badge, expanded, onToggle, children }) {
  return (
    <Tray>
      <div className="tray-card">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="w-full flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5 text-left cursor-pointer"
        >
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
            {subtitle && <p className="text-xs text-faint mt-0.5">{subtitle}</p>}
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {badge}
            {expanded ? <ChevronUp size={14} className="text-faint" /> : <ChevronDown size={14} className="text-faint" />}
          </div>
        </button>
        {expanded && <div className="px-4 pb-4 space-y-3">{children}</div>}
      </div>
    </Tray>
  );
}
