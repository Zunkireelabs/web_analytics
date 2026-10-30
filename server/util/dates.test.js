
import { isValidTimezone, safeTimezone, todayInTz as todayTz } from './dates.js';
import { test as tzTest } from 'node:test';
import tzAssert from 'node:assert/strict';

tzTest('only real IANA zones are valid', () => {
  tzAssert.equal(isValidTimezone('Asia/Kolkata'), true);
  tzAssert.equal(isValidTimezone('Europe/London'), true);
  for (const bad of ['Mars/Olympus', '', '  ', null, undefined, 42, 'Asia/Kolkata; DROP']) tzAssert.equal(isValidTimezone(bad), false);
});
tzTest('a legacy invalid zone falls back instead of throwing inside per-site loops', () => {
  tzAssert.equal(safeTimezone('Mars/Olympus'), 'Asia/Kolkata');
  tzAssert.equal(safeTimezone('Europe/London'), 'Europe/London');
  tzAssert.match(todayTz('Mars/Olympus'), /^\d{4}-\d{2}-\d{2}$/);
});
