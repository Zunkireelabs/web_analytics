// Is this a real IANA zone name the runtime knows? Kept in its own tiny module (no imports) so the database
// layer can use it without depending on util/dates.js.
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
}
