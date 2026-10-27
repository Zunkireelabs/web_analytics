// A titled tray holding one white card whose rows scroll inside it, so a long list never
// stretches the page; the header and footer stay put.
export default function ListCard({ title, subtitle, action, footer, empty, children, maxHeight = 340 }) {
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
          : <div className="custom-scrollbar overflow-y-auto" style={{ maxHeight }}>{children}</div>}
        {footer && <div className="tbl-foot">{footer}</div>}
      </div>
    </div>
  );
}

export const ROW = 'flex items-start gap-3 px-4 py-2.5 border-t border-border first:border-t-0 text-[13px]';
