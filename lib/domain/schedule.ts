export type Cadence = 'daily' | 'weekdays' | 'weekly';

export interface Schedule {
  cadence: Cadence;
  /** 0 = Sunday ... 6 = Saturday; required for weekly. */
  weekday?: number;
  /** 24-hour local wall time, "HH:MM". */
  time: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

export function isValidSchedule(schedule: Schedule): boolean {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return false;
  if (schedule.cadence === 'weekly') return Number.isInteger(schedule.weekday) && schedule.weekday! >= 0 && schedule.weekday! <= 6;
  return schedule.cadence === 'daily' || schedule.cadence === 'weekdays';
}

export function describeSchedule(schedule: Schedule): string {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const clock = `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  if (schedule.cadence === 'daily') return `every day at ${clock}`;
  if (schedule.cadence === 'weekdays') return `every weekday at ${clock}`;
  return `every ${WEEKDAYS[schedule.weekday ?? 1]} at ${clock}`;
}

function wallClock(date: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** Minutes the zone is ahead of UTC at this instant. */
function offsetMinutes(date: Date, timeZone: string): number {
  const wall = wallClock(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant a local wall time occurs in a zone. Around a daylight-saving change there are two
 * candidate offsets: when both give the wall time (the repeated hour in autumn) the earlier wins; when
 * neither does (the skipped hour in spring) the later one wins, so a task never runs before its time.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  const second = guess - offsetMinutes(new Date(first), timeZone) * 60_000;
  const matches = (instant: number) => {
    const wall = wallClock(new Date(instant), timeZone);
    return wall.year === year && wall.month === month && wall.day === day && wall.hour === hour && wall.minute === minute;
  };
  const valid = [first, second].filter(matches);
  return new Date(valid.length ? Math.min(...valid) : Math.max(first, second));
}

/** The first run strictly after `after`, in the user's time zone. */
export function nextRun(schedule: Schedule, timeZone: string, after: Date): Date {
  if (!isValidSchedule(schedule) || !isValidTimeZone(timeZone)) throw new Error('Invalid schedule or time zone');
  const [hour, minute] = schedule.time.split(':').map(Number);
  const today = wallClock(after, timeZone);
  for (let offset = 0; offset < 9; offset++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = day.getUTCDay();
    if (schedule.cadence === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (schedule.cadence === 'weekly' && weekday !== schedule.weekday) continue;
    const candidate = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error('No next run within nine days');
}
