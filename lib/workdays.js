// Working-day (Mon–Fri) arithmetic for sprint timing.
//
// A raw calendar-day countdown to a sprint's end date is technically
// accurate but not what "days left" means to a team that doesn't work
// weekends. Excluding weekends is the one thing every team agrees on
// regardless of local holiday calendars, so that's all this does — no
// public-holiday calendar.
//
// Weekday boundaries are computed in a configurable team timezone (not the
// server's own TZ, which on Vercel is UTC) because Jira's sprint start/end
// timestamps often land at a UTC time that crosses midnight in the team's
// local timezone (e.g. 18:30 UTC = the next day in IST). Defaults to
// Asia/Kolkata; set TEAM_TIMEZONE to override.
const TEAM_TZ = process.env.TEAM_TIMEZONE || 'Asia/Kolkata';

// Local calendar date (midnight, as a UTC-stamped Date so plain subtraction
// works) that `date` falls on in `tz`.
function localDateOnly(date, tz) {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date); // "YYYY-MM-DD"
  return new Date(`${ymd}T00:00:00Z`);
}

function isWeekend(dateOnly, tz) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(dateOnly);
  return weekday === 'Sat' || weekday === 'Sun';
}

// Counts weekdays in the half-open interval [from, to) — `to`'s own day is
// never counted, matching how "N working days left" is normally meant.
function countWeekdaysBetween(from, to, tz = TEAM_TZ) {
  let cursor = localDateOnly(from, tz);
  const end = localDateOnly(to, tz);
  let count = 0;
  while (cursor < end) {
    if (!isWeekend(cursor, tz)) count++;
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return count;
}

// Sprint working-day progress: working days left from `now` through the end
// date, and percent elapsed measured in working days.
function sprintWorkingDayProgress(startDate, endDate, now, tz = TEAM_TZ) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const totalWorkingDays = Math.max(1, countWeekdaysBetween(start, end, tz));
  const daysLeft = Math.max(0, countWeekdaysBetween(now, end, tz));
  const workedSoFar = Math.max(0, totalWorkingDays - daysLeft);
  const pctElapsed = Math.min(100, Math.max(0, Math.round((workedSoFar / totalWorkingDays) * 100)));
  return { daysLeft, pctElapsed, totalWorkingDays };
}

module.exports = { TEAM_TZ, countWeekdaysBetween, sprintWorkingDayProgress };
