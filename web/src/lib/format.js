// Date and delta formatting for page copy. YYYY-MM-DD strings are parsed as UTC
// so the day never shifts with the viewer's timezone.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(ymd) {
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`);
  return { day: d.getUTCDate(), month: d.getUTCMonth(), year: d.getUTCFullYear() };
}

// "18 Oct". Accepts YYYY-MM-DD (or a longer ISO string) and MM-DD (the growth-target
// projection rows use MM-DD); anything unparseable is returned unchanged.
export function fmtDay(ymd) {
  if (!ymd) return '';
  const str = String(ymd);
  const m = /^(?:\d{4}-)?(\d{2})-(\d{2})/.exec(str);
  if (!m || +m[1] < 1 || +m[1] > 12) return str;
  return `${+m[2]} ${MONTHS[+m[1] - 1]}`;
}

// "18–21 Oct" within a month, "28 Sep – 3 Oct" across months
export function fmtRange(startYmd, endYmd) {
  if (!startYmd || !endYmd) return '';
  const a = parts(startYmd);
  const b = parts(endYmd);
  if (a.month === b.month && a.year === b.year) {
    return a.day === b.day ? fmtDay(endYmd) : `${a.day}–${b.day} ${MONTHS[b.month]}`;
  }
  return `${fmtDay(startYmd)} – ${fmtDay(endYmd)}`;
}

// "+83%" / "−82.3%" (U+2212 minus); null when there is no delta
export function fmtSignedPct(d) {
  if (d == null) return null;
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}%`;
}
