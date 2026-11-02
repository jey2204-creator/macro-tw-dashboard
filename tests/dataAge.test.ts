import { describe, it, expect } from 'vitest';
import { weekdayHoursBetween } from '../src/lib/dataAge';

const tpe = (s: string) => Date.parse(`${s}+08:00`);

describe('weekdayHoursBetween', () => {
  it('週六早上到週一晚上只算週一的時數', () => {
    expect(weekdayHoursBetween(tpe('2026-10-31T09:00:00'), tpe('2026-11-02T19:43:00'))).toBeCloseTo(19 + 43 / 60, 5);
  });
  it('平日連續時數照算', () => {
    expect(weekdayHoursBetween(tpe('2026-10-27T09:00:00'), tpe('2026-10-29T09:00:00'))).toBeCloseTo(48, 5);
  });
  it('週五晚到週二早只算週五剩下＋週一＋週二', () => {
    expect(weekdayHoursBetween(tpe('2026-10-30T22:00:00'), tpe('2026-11-03T06:00:00'))).toBeCloseTo(2 + 24 + 6, 5);
  });
  it('反向或相同時間為 0', () => {
    expect(weekdayHoursBetween(tpe('2026-11-02T10:00:00'), tpe('2026-11-02T10:00:00'))).toBe(0);
  });
});
