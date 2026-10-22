export default function Section({ label, source, title, subtitle, action, className = '', children }) {
  return (
    <section className={className}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 mb-2.5">
        <div className="min-w-0">
          {label && (
            <div className="label-dot">
              <span>{label}</span>
              {source && <span className="text-faint normal-case tracking-normal font-normal pl-2.5 border-l border-border-canvas">{source}</span>}
            </div>
          )}
          <h2 className={`${label ? 'mt-1.5 ' : ''}text-[15px] font-medium tracking-[-0.01em] text-fg`}>{title}</h2>
          {subtitle && <p className="text-[13px] text-text mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
