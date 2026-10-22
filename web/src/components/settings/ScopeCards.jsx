// The three settings levels (Account / Workspace / Project) as a row of tiles;
// the current one is raised and marked.
// items: [{ key, label, description, icon, onSelect }]
export default function ScopeCards({ items, current }) {
  return (
    <div className="grid gap-3 mt-5" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0,1fr))` }}>
      {items.map(({ key, label, description, icon: Icon, onSelect }) => {
        const isCurrent = key === current;
        return (
          <button key={key} type="button" onClick={onSelect}
            aria-current={isCurrent ? 'page' : undefined}
            className={`flex flex-col sm:flex-row items-start gap-1.5 sm:gap-3 text-left px-2.5 py-2.5 sm:px-3.5 sm:py-3 rounded-card min-w-0 ${isCurrent ? 'bg-white' : 'hover:bg-white/60'}`}
            style={{ boxShadow: isCurrent ? 'var(--ring)' : '0 0 0 1px var(--border-canvas)' }}>
            <span className="w-7 h-7 rounded-control grid place-items-center bg-white text-faint shrink-0"
              style={{ boxShadow: '0 0 0 1px var(--border-canvas)' }}>
              {Icon && <Icon size={15} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium text-fg">
                {label}
                {isCurrent && <span className="hidden sm:inline text-[11px] font-medium text-text bg-muted rounded-[6px] px-1.5">You're here</span>}
              </span>
              <span className="hidden sm:block text-xs text-faint mt-0.5 truncate">{description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
