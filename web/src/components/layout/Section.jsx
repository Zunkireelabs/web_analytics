export default function Section({ label, source, title, subtitle, action, className = '', children }) {
  return (
    <section className={className}>
      <div className="flex items-end justify-between gap-4 mb-3">
        <div className="min-w-0">
          {label && (
            <div className="label-dot">
              <span>{label}</span>
              {source && <span className="text-faint normal-case tracking-normal font-normal pl-2.5 border-l border-border-canvas">{source}</span>}
            </div>
          )}
          <h2 className={`${label ? 'mt-2 ' : ''}text-[17px] font-medium tracking-[-0.01em] text-fg`}>{title}</h2>
          {subtitle && <p className="text-sm text-text mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
