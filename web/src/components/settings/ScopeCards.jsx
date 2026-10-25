// The three settings levels (Account / Workspace / Project) as one grey segmented
// bar; the current one is a raised white tile with a dark icon square.
// items: [{ key, label, description, icon, onSelect }]
export default function ScopeCards({ items, current }) {
  return (
    <div role="tablist" className="grid gap-1 mt-5 p-1.5 rounded-[16px] bg-[#ececeb]"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0,1fr))` }}>
      {items.map(({ key, label, description, icon: Icon, onSelect }) => {
        const isCurrent = key === current;
        return (
          <button key={key} type="button" role="tab" onClick={onSelect}
            aria-selected={isCurrent} aria-current={isCurrent ? 'page' : undefined}
            className={`flex flex-col sm:flex-row items-start sm:items-center gap-1.5 sm:gap-3 text-left px-2.5 py-2 sm:px-3 sm:py-2.5 rounded-[12px] min-w-0 transition-colors ${isCurrent ? 'bg-white' : 'hover:bg-white/50'}`}
            style={isCurrent ? { boxShadow: '0 1px 3px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.04)' } : undefined}>
            <span className={`w-7 h-7 sm:w-8 sm:h-8 rounded-[9px] grid place-items-center shrink-0 ${isCurrent ? 'bg-fg text-white' : 'bg-white text-fg'}`}
              style={isCurrent ? undefined : { boxShadow: '0 0 0 1px rgba(0,0,0,.06)' }}>
              {Icon && <Icon size={16} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-fg">{label}</span>
              <span className="hidden sm:block text-xs text-faint mt-0.5 truncate">{description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
