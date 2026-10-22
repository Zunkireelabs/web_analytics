import { STATUS } from '../../lib/palette.js';

const DELTA_COLOR = { good: STATUS.good.text, bad: STATUS.critical.text };
const COLS = { base: 2, lg: 4 };

// Hairlines between cells: a top border on every cell past the first row and a
// left border on every cell past the first column, per breakpoint, so there is
// never a double line or a gap at either column count.
function cellBorders(i) {
  const cls = ['border-border'];
  if (i >= COLS.base) cls.push('border-t');
  if (i % COLS.base !== 0) cls.push('border-l');
  if (i >= COLS.lg) cls.push('lg:border-t');
  else if (i >= COLS.base) cls.push('lg:border-t-0');
  if (i % COLS.lg !== 0) cls.push('lg:border-l');
  else if (i % COLS.base !== 0) cls.push('lg:border-l-0');
  return cls.join(' ');
}

export default function KpiStrip({ items = [], loading = false }) {
  const cells = loading ? Array.from({ length: items.length || 8 }) : items;
  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-2 lg:grid-cols-4">
        {cells.map((it, i) => (
          <div key={loading ? i : it.label} className={`px-5 py-4 min-w-0 ${cellBorders(i)}`}>
            {loading ? (
              <>
                <div className="h-3 w-20 bg-muted rounded-control animate-pulse" />
                <div className="h-6 w-16 bg-muted rounded-control animate-pulse mt-2.5" />
              </>
            ) : (
              <>
                <div className="text-[13px] text-text truncate">{it.label}</div>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="text-[22px] font-medium tracking-[-0.02em] text-fg tnum truncate">{it.value}</span>
                  {it.delta && (
                    <span className={`text-[13px] font-medium shrink-0${DELTA_COLOR[it.delta.tone] ? '' : ' text-faint'}`}
                      style={DELTA_COLOR[it.delta.tone] ? { color: DELTA_COLOR[it.delta.tone] } : undefined}>
                      {it.delta.text}
                    </span>
                  )}
                </div>
                {it.sub && <div className="mt-0.5 text-xs leading-4 text-faint">{it.sub}</div>}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
