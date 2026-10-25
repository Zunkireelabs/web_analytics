// Underline tabs for a settings level: tabs = [{ key, label, icon }].
export default function UnderlineTabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" className="flex gap-5 mt-5 border-b border-border-canvas overflow-x-auto no-scrollbar">
      {tabs.map(({ key, label, icon: Icon }) => {
        const active = key === value;
        return (
          <button key={key} type="button" role="tab" aria-selected={active} onClick={() => onChange(key)}
            className={`inline-flex items-center gap-1.5 h-[38px] -mb-px border-b-2 text-sm whitespace-nowrap ${
              active ? 'border-fg text-fg font-medium' : 'border-transparent text-text hover:text-fg'
            }`}>
            {Icon && <Icon size={14} className={active ? 'text-fg' : 'text-faint'} />}
            {label}
          </button>
        );
      })}
    </div>
  );
}
