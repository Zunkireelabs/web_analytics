// One white card in a grey tray. The rows scroll inside the card when the list grows, so the header and
// footer stay put and the page height does not change as data is added.
export default function Card({ title, subtitle, action, footer, empty, loading, maxHeight, children }) {
  return (
    <div className="tray">
      <div className="tray-card overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
            {subtitle && <p className="text-xs text-faint mt-0.5">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        {loading ? (
          <div className="px-4 pb-4 space-y-2.5">
            <div className="h-3 w-48 bg-muted rounded-control animate-pulse" />
            <div className="h-6 w-24 bg-muted rounded-control animate-pulse" />
            <div className="h-3 w-40 bg-muted rounded-control animate-pulse" />
          </div>
        ) : empty ? (
          <div className="px-4 pb-4 pt-1 text-[13px] text-text border-t border-border">{empty}</div>
        ) : maxHeight ? (
          <div className="custom-scrollbar overflow-y-auto" style={{ maxHeight }}>{children}</div>
        ) : children}
        {footer && !loading && !empty && <div className="tbl-foot">{footer}</div>}
      </div>
    </div>
  );
}

export const ROW = 'flex items-start gap-3 px-4 py-2.5 border-t border-border first:border-t-0 text-[13px]';
