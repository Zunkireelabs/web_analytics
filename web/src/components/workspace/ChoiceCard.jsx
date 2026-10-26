// A selectable card with a radio dot: the standard way to pick one option in the
// workspace screens (permission level, kind of business, token access).
const RING = '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)';
const RING_ON = '0 0 0 1px var(--primary), 0 0 0 4px var(--primary-tint)';

export default function ChoiceCard({ selected, onSelect, title, description, disabled = false, children }) {
  return (
    <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect}
      className="w-full flex items-start gap-3 p-3 rounded-card bg-white text-left disabled:opacity-60"
      style={{ boxShadow: selected ? RING_ON : RING }}>
      <span className="w-4 h-4 mt-0.5 rounded-full shrink-0 grid place-items-center"
        style={{ boxShadow: selected ? '0 0 0 1px var(--primary)' : '0 0 0 1px var(--input)' }}>
        {selected && <span className="w-2 h-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-fg">{title}</span>
        {description && <span className="block text-xs text-faint mt-px leading-[17px]">{description}</span>}
        {children}
      </span>
    </button>
  );
}
