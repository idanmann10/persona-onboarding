import { describe, expect, it } from 'vitest';
import { describeSchedule, isValidSchedule, isValidTimeZone, nextRun, zonedTimeToUtc } from '../../lib/domain/schedule';

describe('recurring schedule', () => {
  it('describes schedules the way a person says them', () => {
    expect(describeSchedule({ cadence: 'weekdays', time: '08:00' })).toBe('every weekday at 8:00 AM');
    expect(describeSchedule({ cadence: 'daily', time: '18:30' })).toBe('every day at 6:30 PM');
    expect(describeSchedule({ cadence: 'weekly', weekday: 1, time: '00:05' })).toBe('every Monday at 12:05 AM');
  });

  it('validates time zones and schedules', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidSchedule({ cadence: 'weekly', time: '08:00' })).toBe(false);
    expect(isValidSchedule({ cadence: 'daily', time: '24:00' })).toBe(false);
  });

  it('converts local wall time to UTC across daylight-saving changes', () => {
    expect(zonedTimeToUtc(2026, 9, 28, 8, 0, 'America/New_York').toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(zonedTimeToUtc(2026, 11, 2, 8, 0, 'America/New_York').toISOString()).toBe('2026-11-02T13:00:00.000Z');
    expect(zonedTimeToUtc(2026, 9, 28, 8, 0, 'Asia/Kolkata').toISOString()).toBe('2026-09-28T02:30:00.000Z');
  });

  it('finds the next weekday, weekly and daily run in the user\'s zone', () => {
    const saturdayNoon = new Date('2026-09-26T16:00:00Z');
    expect(nextRun({ cadence: 'weekdays', time: '08:00' }, 'America/New_York', saturdayNoon).toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(nextRun({ cadence: 'daily', time: '08:00' }, 'America/New_York', saturdayNoon).toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(nextRun({ cadence: 'weekly', weekday: 5, time: '17:00' }, 'Europe/London', saturdayNoon).toISOString()).toBe('2026-10-02T16:00:00.000Z');
    const justBefore = new Date('2026-09-28T11:59:00Z');
    expect(nextRun({ cadence: 'weekdays', time: '08:00' }, 'America/New_York', justBefore).toISOString()).toBe('2026-09-28T12:00:00.000Z');
    const exactly = new Date('2026-09-28T12:00:00Z');
    expect(nextRun({ cadence: 'weekdays', time: '08:00' }, 'America/New_York', exactly).toISOString()).toBe('2026-09-29T12:00:00.000Z');
  });
});
