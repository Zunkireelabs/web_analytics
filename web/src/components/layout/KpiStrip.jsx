import { STATUS } from '../../lib/palette.js';
import Sparkline from '../Sparkline.jsx';

const DELTA_COLOR = { good: STATUS.good.text, bad: STATUS.critical.text };
const LG_GRID = { 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5' };

// Hairlines between cells: a top border on every cell past the first row and a
// left border on every cell past the first column, per breakpoint, so there is
// never a double line or a gap at either column count.
function cellBorders(i, lgCols) {
  const base = 2;
  const cls = ['border-border'];
  if (i >= base) cls.push('border-t');
  if (i % base !== 0) cls.push('border-l');
  if (i >= lgCols) cls.push('lg:border-t');
  else if (i >= base) cls.push('lg:border-t-0');
  if (i % lgCols !== 0) cls.push('lg:border-l');
  else if (i % base !== 0) cls.push('lg:border-l-0');
  return cls.join(' ');
}

// `bare` renders just the grid (for use inside a card the caller owns); each item may
// carry an optional `spark: number[]` drawn as a small sparkline under the sub.
// `cols` is the column count from lg up (default 4; 2 below lg).
export default function KpiStrip({ items = [], loading = false, bare = false, cols = 4 }) {
  const cells = loading ? Array.from({ length: items.length || 8 }) : items;
  const grid = (
      <div className={`grid grid-cols-2 ${LG_GRID[cols] || LG_GRID[4]}`}>
        {cells.map((it, i) => (
          <div key={loading ? i : it.label} className={`px-5 py-4 min-w-0 ${cellBorders(i, cols)}`}>
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
                {it.spark && it.spark.length >= 2 && (
                  <div className="mt-2 h-7"><Sparkline data={it.spark} stretch dot={false} /></div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
  );
  return bare ? grid : <div className="card overflow-hidden">{grid}</div>;
}
