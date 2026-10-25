// The "white panel + trays" building blocks: a grey Tray holding one or more
// white TrayCards. `cols` (1 | 2 | 3) is the column count from lg up; always
// one column below lg.
const COLS = { 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3' };

// Optional caption (`title`, `subtitle`, `source`, `action`): a row above the cards, for
// a group of several cards that have no title of their own. A single card should use
// TrayCard's own title (or `Section tray`) instead.
export function Tray({ cols = 1, title, subtitle, source, action, className = '', children }) {
  return (
    <div className={`tray ${COLS[cols] || ''} ${className}`.trim()}>
      {title && (
        <div className="col-span-full flex items-end justify-between gap-3 px-2.5 pt-1.5 pb-1">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
            {(subtitle || source) && <p className="text-xs text-faint">{subtitle}{subtitle && source ? ' · ' : ''}{source}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function TrayCard({ title, subtitle, source, action, className = '', children }) {
  return (
    <div className={`tray-card ${className}`.trim()}>
      {title && (
        <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
            {(subtitle || source) && <p className="text-xs text-faint mt-0.5">{subtitle}{subtitle && source ? ' · ' : ''}{source}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
