// The shared settings card: header (icon + title + description, optional action),
// body as given, optional footer. Callers add their own body padding; rows use
// `px-5 py-3 border-b border-border last:border-0`.
// Wraps itself in a grey tray; `bare` skips the tray (just the white card) for callers
// that put several cards in one tray of their own (Account's two-up).
export default function SettingsCard({ icon: Icon, title, description, action, footer, children, className = '', style, bare = false }) {
  const card = (
    <div className={`tray-card ${className}`.trim()} style={style}>
      <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-border">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            {Icon && <Icon size={15} className="text-faint" />}
            {title}
          </h2>
          {description && <p className="text-[13px] text-text mt-0.5 pl-6">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
      {footer && <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">{footer}</div>}
    </div>
  );
  return bare ? card : <div className="tray">{card}</div>;
}

// Definition list for read-only facts: rows = [[label, value], …]; rows with a
// falsy value are skipped.
export function SettingsRows({ rows }) {
  return (
    <dl className="px-5 py-1">
      {rows.filter(([, value]) => value).map(([label, value]) => (
        <div key={label} className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-x-3 py-2.5 border-b border-border last:border-0">
          <dt className="text-[13px] text-faint">{label}</dt>
          <dd className="text-sm text-fg min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
