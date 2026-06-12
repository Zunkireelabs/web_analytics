// Consistent page header: optional gradient icon + title + subtitle, with an optional right slot.
export default function PageHeader({ title, subtitle, icon, right }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {icon && (
          <div className="w-11 h-11 rounded-2xl grid place-items-center text-white text-lg shadow-lg shadow-indigo-500/25 shrink-0"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="flex items-end gap-3">{right}</div>}
    </div>
  );
}
