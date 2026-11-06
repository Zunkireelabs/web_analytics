// Says what a period's analytics figures are actually worth, when they are worth less than exact.
//
// GA4 withholds rows for privacy on low-traffic days, collapses long tails into "(other)", and sometimes estimates
// from a sample. None of that is an error we can fix — but a dashboard that shows such a number with no word about it
// is the reason a client opens their own GA4, sees a different figure, and stops believing the rest of the page.
//
// Deliberately quiet: it renders NOTHING when the period is clean, and nothing when the period was never assessed
// (days ingested before this existed). An absent note must never be read as a guarantee, and a reassuring badge on a
// day we did not assess would be a claim we cannot support.
//
// `quality` is store/read.js getGa4DataQuality's shape:
//   { worst, days, unassessed, counts, affectedDays: [{date, confidence}], notes: [string] }

const COPY = {
  partial: {
    label: 'Some data withheld by Google',
    tone: 'warn',
    lead: 'The totals are Google Analytics’ own figures. Some breakdown rows are missing, so a list on this page may not be complete.',
  },
  estimated: {
    label: 'Estimated by Google',
    tone: 'estimate',
    lead: 'Google returned sampled data for part of this period, so these figures are close estimates rather than exact counts.',
  },
};

const TONE_CLASS = {
  warn: 'bg-[#fff8e6] text-[#7a4b00] border-[#f0d9a0]',
  estimate: 'bg-[#eef4ff] text-[#1f3d7a] border-[#c7d7f5]',
};

export default function DataQualityNote({ quality, className = '' }) {
  // Nothing to say: a clean period, an unassessed one, or no data at all.
  if (!quality?.worst || quality.worst === 'complete') return null;

  const copy = COPY[quality.worst];
  if (!copy) return null;

  const affected = quality.affectedDays?.length || 0;
  const dayWord = affected === 1 ? 'day' : 'days';

  return (
    <div className={`rounded-card border px-4 py-3 text-[13px] leading-relaxed ${TONE_CLASS[copy.tone]} ${className}`}>
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-[1px]">{copy.tone === 'estimate' ? '≈' : '!'}</span>
        <div>
          <div className="font-medium">
            {copy.label}
            {affected > 0 && quality.days > 0 && (
              <span className="font-normal"> · {affected} of {quality.days} {dayWord} in this period</span>
            )}
          </div>
          <p className="mt-1">{copy.lead}</p>

          {/* Google's own reasons, de-duplicated across the period, in its words not ours. */}
          {quality.notes?.length > 0 && (
            <ul className="mt-2 list-disc pl-5 space-y-1">
              {quality.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}

          {/* Named so a client can check the same days in their own GA4 rather than take this on trust. */}
          {affected > 0 && affected <= 8 && (
            <p className="mt-2 text-faint">
              Affected {dayWord}: {quality.affectedDays.map((d) => shortDate(d.date)).join(', ')}
            </p>
          )}

          {quality.unassessed > 0 && (
            <p className="mt-2 text-faint">
              {quality.unassessed} earlier {quality.unassessed === 1 ? 'day was' : 'days were'} collected before this
              check existed, so {quality.unassessed === 1 ? 'it has' : 'they have'} not been assessed either way.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function shortDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
