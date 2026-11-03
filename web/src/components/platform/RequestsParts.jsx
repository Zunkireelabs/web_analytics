// Small pieces shared by the Requests, Approvals and Access on hold lists, so the three look the same.

export const initials = (s) => {
  const w = String(s || '?').trim().split(/\s+/).filter(Boolean);
  return ((w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)) || '?').toUpperCase();
};

export const Avatar = ({ name, size = 32 }) => (
  <span className="rounded-[9px] bg-primary-tint text-primary grid place-items-center text-[11.5px] font-semibold shrink-0"
    style={{ width: size, height: size, boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>{initials(name)}</span>
);

const PILL = {
  warn: ['#fdf3e1', '#8a5300', '#e08a00'], trial: ['#eaf1fb', '#2a5db0', '#2a5db0'], client: ['var(--green-tint)', 'var(--green)', 'var(--green)'],
  ended: ['#fdecec', '#b42318', '#b42318'], rejected: ['#f4f2ef', '#525252', '#a3a3a3'],
};
export const StatusPill = ({ tone, children }) => {
  const [bg, fg, dot] = PILL[tone] || PILL.rejected;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 h-6 rounded-full text-[12.5px] whitespace-nowrap" style={{ background: bg, color: fg }}>
      <i className="size-1.5 rounded-full not-italic" style={{ background: dot }} />{children}
    </span>
  );
};

export const CountChip = ({ children }) => (
  <span className="inline-flex items-center h-6 px-2.5 rounded-full bg-muted text-xs text-text whitespace-nowrap">{children}</span>
);

export const Note = ({ note, onClose }) => (note ? (
  <div className={`mx-4 sm:mx-5 mt-3 rounded-control px-3 py-2 text-[13px] flex items-start gap-3 ${note.bad ? 'bg-[#fdecec] text-[#b42318]' : 'bg-green-tint text-green'}`} role="status">
    <div className="min-w-0 flex-1"><p>{note.text}</p>{note.link && <a href={note.link} className="mt-1 block break-all underline underline-offset-2">{note.link}</a>}</div>
    {onClose && <button type="button" onClick={onClose} className="text-xs underline underline-offset-2 shrink-0">Dismiss</button>}
  </div>
) : null);

export const LoadingRows = ({ n = 4 }) => (
  <div aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} className="h-[65px] border-t border-border px-4 sm:px-5 flex items-center"><div className="h-8 w-full rounded-control bg-muted animate-pulse" /></div>)}</div>
);

export const EmptyRow = ({ children }) => <p className="px-4 sm:px-5 py-8 text-center text-[13px] text-faint border-t border-border">{children}</p>;

export const ErrorRow = ({ onRetry }) => (
  <p className="px-4 sm:px-5 py-6 text-center text-[13px] border-t border-border" style={{ color: '#b42318' }}>
    Could not load this list. <button type="button" className="underline underline-offset-2" onClick={onRetry}>Try again</button>
  </p>
);

// Column header row for the grid lists; hidden on phones where each row stacks.
export const HeadRow = ({ cols, labels }) => (
  <div className="hidden lg:grid items-center gap-x-4 px-4 sm:px-5 h-10 border-t border-border text-[12.5px] text-faint" style={{ gridTemplateColumns: cols }}>
    {labels.map((l, i) => <span key={i}>{l}</span>)}
  </div>
);
