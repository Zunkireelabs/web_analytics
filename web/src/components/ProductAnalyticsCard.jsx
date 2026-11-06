// What people DID, from the client's own PostHog — the question Google Analytics structurally cannot answer.
//
// Renders nothing at all when the project has no PostHog. Most projects will not, and an empty panel reading
// "no data" implies something is broken rather than simply not connected.
//
// `summary` is store/project-posthog.js getPosthogSummary's shape:
//   { days, measured_days, events, pageviews, sessions, peak_daily_people, topDropOffs: [{event, sessions_ending_here}] }

export default function ProductAnalyticsCard({ summary, className = '' }) {
  if (!summary || !summary.days) return null;

  const partial = summary.measured_days > 0 && summary.measured_days < summary.days;

  return (
    <div className={`rounded-card border border-line bg-white px-4 py-4 ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-medium">What visitors did</h3>
        {/* No vendor badge: the heading already says what this is, and naming the tool here tells the client nothing
            they need. The connect screen is the one place the vendor matters, because that is where they paste from. */}
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Events" value={summary.events} />
        <Stat label="Pageviews" value={summary.pageviews} />
        <Stat label="Sessions" value={summary.sessions} />
        {/* Labelled "busiest day", never a period total: the same person returning on two days is one person, so
            summing daily uniques would overstate reach. The store deliberately provides no summed figure. */}
        <Stat label="People, busiest day" value={summary.peak_daily_people} />
      </div>

      {summary.topDropOffs?.length > 0 && (
        <div className="mt-4">
          <div className="text-[13px] font-medium">Where people stopped</div>
          <p className="mt-1 text-xs text-faint">
            The last thing people did before their visit ended. A high count is where to look first.
          </p>
          <ul className="mt-2 space-y-1">
            {summary.topDropOffs.slice(0, 5).map((d) => (
              <li key={d.event} className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="truncate font-mono text-[12px]">{d.event}</span>
                <span className="shrink-0 tabular-nums">{fmt(d.sessions_ending_here)} {d.sessions_ending_here === 1 ? 'visit' : 'visits'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {partial && (
        <p className="mt-3 text-xs text-faint">
          Covers {summary.measured_days} of {summary.days} days in this period; PostHog returned nothing for the rest.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-xs text-faint">{label}</div>
      {/* A metric PostHog did not return shows as a dash, never as 0: "we could not measure this" and "none
          happened" are different facts and must not look alike. */}
      <div className="text-[18px] font-medium tabular-nums">{value == null ? '—' : fmt(value)}</div>
    </div>
  );
}

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}
