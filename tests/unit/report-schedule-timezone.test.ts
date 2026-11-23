import { describe, expect, it } from 'vitest';
import { nextScheduleInstant } from '@scaleinsyght/reports';

describe('tenant-local report schedule conversion', () => {
  it('stores the next daily Asia/Kolkata occurrence as a UTC instant', () => {
    expect(nextScheduleInstant({ after: new Date('2026-11-23T00:00:00.000Z'), cadence: 'daily', timeZone: 'Asia/Kolkata', localTime: '06:00' }).toISOString())
      .toBe('2026-11-23T00:30:00.000Z');
  });

  it('finds the requested ISO weekday in tenant-local calendar time', () => {
    expect(nextScheduleInstant({ after: new Date('2026-11-22T12:00:00.000Z'), cadence: 'weekly', weekday: 1, timeZone: 'Asia/Kolkata', localTime: '09:15' }).toISOString())
      .toBe('2026-11-23T03:45:00.000Z');
  });

  it('skips a daily wall time that falls inside the spring-forward gap', () => {
    expect(nextScheduleInstant({ after: new Date('2026-03-08T05:00:00.000Z'), cadence: 'daily', timeZone: 'America/New_York', localTime: '02:30' }).toISOString())
      .toBe('2026-03-09T06:30:00.000Z');
  });

  it('chooses the earlier UTC instant for an ambiguous fall-back wall time', () => {
    expect(nextScheduleInstant({ after: new Date('2026-11-01T04:00:00.000Z'), cadence: 'daily', timeZone: 'America/New_York', localTime: '01:30' }).toISOString())
      .toBe('2026-11-01T05:30:00.000Z');
  });
});
