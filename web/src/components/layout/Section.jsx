import { Tray, TrayCard } from './Tray.jsx';

// `tray` opts into the white-card-in-a-grey-tray look (the label is dropped and
// the source moves into the card's grey line); without it Section renders as before.
export default function Section({ label, source, title, subtitle, action, className = '', tray = false, cols, children }) {
  if (tray) {
    return (
      <section className={className}>
        <Tray cols={cols}><TrayCard title={title} subtitle={subtitle} source={source} action={action}>{children}</TrayCard></Tray>
      </section>
    );
  }
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
          <h2 className={`${label ? 'mt-1.5 ' : ''}text-[15px] font-semibold tracking-[-0.01em] text-fg`}>{title}</h2>
          {subtitle && <p className="text-[13px] text-text mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
