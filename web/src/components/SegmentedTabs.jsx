export default function SegmentedTabs({ options, value, onChange, className = '' }) {
  return (
    <div className={`toggle ${className}`.trim()} role="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={active ? 'is-on' : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
