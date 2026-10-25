import { STATUS } from '../lib/palette.js';

const fmtInt = (v) => Number(v).toLocaleString();

// Same day, one week ago and one week before that both fall on the same
// weekday — useful context a bare date doesn't give at a glance.
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// `history[].label` has a different real shape per report period (server/
// routes/metrics.js): daily is a plain "YYYY-MM-DD", weekly is a range
// "YYYY-MM-DD – YYYY-MM-DD", monthly is "YYYY-MM". Parsing a range or
// bare-month string as if it were a single YMD date used to silently
// produce "Invalid Date" on the Weekly tab — this handles all three shapes.
function friendlyDate(label) {
  const rangeMatch = /^(\d{4}-\d{2}-\d{2})\s*–\s*(\d{4}-\d{2}-\d{2})$/.exec(label || '');
  if (rangeMatch) {
    const d = new Date(`${rangeMatch[1]}T00:00:00Z`);
    const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    return { weekday: 'Week of', day: `${month} ${d.getUTCDate()}` };
  }
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(label || '');
  if (monthMatch) {
    const d = new Date(`${label}-01T00:00:00Z`);
    return { weekday: d.toLocaleDateString('en-US', { year: 'numeric', timeZone: 'UTC' }), day: d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }) };
  }
  const d = new Date(`${label}T00:00:00Z`);
  const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return { weekday: WEEKDAY[d.getUTCDay()], day: `${month} ${d.getUTCDate()}` };
}

// Compact scannable list of recent same-period snapshots — metrics only,
// since narrative is only ever persisted for the current period. Each row's
// magnitude bar (relative to the busiest day shown) makes the trend
// readable at a glance instead of requiring a read of every number.
export default function ReportHistoryRail({ history = [] }) {
  const max = Math.max(1, ...history.map((h) => Number(h.clicks) || 0));

  return (
    <div>
      {history.length === 0 ? (
        <div className="text-sm text-faint py-10 text-center">No report history yet.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Day</th>
              <th aria-label="Clicks share" />
              <th className="num">Clicks</th>
              <th className="num">Change</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h, i) => {
              const clicks = Number(h.clicks) || 0;
              const share = Math.max((clicks / max) * 100, 4);
              const { weekday, day } = friendlyDate(h.label);
              const isLatest = i === 0;
              return (
                <tr key={h.label}>
                  <td className="whitespace-nowrap">
                    <div className="text-xs text-faint leading-4">{weekday}</div>
                    <div className={isLatest ? 'font-medium' : ''}>{day}</div>
                  </td>
                  <td className="w-full min-w-[60px]">
                    <div className="h-1.5 rounded-full bg-[#efeeec] overflow-hidden">
                      <div className={`h-full rounded-full ${isLatest ? 'bg-primary' : ''}`}
                        style={{ width: `${share}%`, background: isLatest ? undefined : '#d4d4d4' }} />
                    </div>
                  </td>
                  <td className="num">{fmtInt(clicks)}</td>
                  <td className="num whitespace-nowrap">
                    {h.deltaPct == null ? '—' : (
                      <span style={{ color: h.deltaPct >= 0 ? STATUS.good.text : STATUS.critical.text }}>
                        {h.deltaPct >= 0 ? '+' : '\u2212'}{Math.abs(h.deltaPct)}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
