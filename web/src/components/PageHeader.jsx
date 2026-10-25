// Consistent page header: optional icon + title + subtitle, with an optional right slot.
export default function PageHeader({ title, subtitle, icon, right }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-2">
      <div className="flex items-center gap-4">
        {icon && (
          <div
            className="w-10 h-10 rounded-control bg-white grid place-items-center text-lg shrink-0"
            style={{ boxShadow: 'var(--ring)' }}
          >
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-2xl sm:text-[28px] font-semibold tracking-[-0.03em] text-fg leading-tight">{title}</h1>
          {subtitle && <p className="text-sm text-text mt-1">{subtitle}</p>}
        </div>
      </div>
      {/* Centered on mobile when this wraps to its own full-width row (e.g.
          Insights' From/To date card) instead of sitting at its natural
          width pushed to one side; reverts to right-aligned at sm+ where it
          shares the row with the title instead of wrapping. */}
      {right && <div className="flex items-center flex-wrap justify-center sm:justify-end gap-3 w-full sm:w-auto">{right}</div>}
    </div>
  );
}
