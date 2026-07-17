// Consistent page header: optional gradient icon + title + subtitle, with an optional right slot.
export default function PageHeader({ title, subtitle, icon, right }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-2">
      <div className="flex items-center gap-4">
        {icon && (
          <div
            className="w-12 h-12 rounded-2xl grid place-items-center text-white text-xl shadow-lg shrink-0 transition-transform duration-300 hover:rotate-3"
            style={{
              background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)',
              boxShadow: '0 8px 20px -4px rgba(108,99,255,0.4)'
            }}
          >
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-950 font-sans leading-none">{title}</h1>
          {subtitle && <p className="text-xs font-semibold text-slate-400 mt-1.5 uppercase tracking-wider">{subtitle}</p>}
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
