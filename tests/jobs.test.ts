import { describe, expect, it } from 'vitest';
import { avg3, jobsReading, monthLabel, nextMonth, payrollChanges } from '../src/shared/jobs';
import type { Point } from '../src/shared/timeseries';

describe('jobs', () => {
  const levels: Point[] = [
    ['2026-06-01', 158000],
    ['2026-07-01', 158100],
    ['2026-08-01', 158068],
    ['2026-09-01', 158128],
    ['2026-10-01', 158293],
  ];
  it('就業人數（千人）→ 月增（萬人）；缺月不硬算', () => {
    expect(payrollChanges(levels)).toEqual([
      ['2026-07-01', 10],
      ['2026-08-01', -3.2],
      ['2026-09-01', 6],
      ['2026-10-01', 16.5],
    ]);
    // 中間缺 8 月：7→9 月不相減
    expect(payrollChanges([levels[0]!, levels[1]!, levels[3]!, levels[4]!]).map((p) => p[0])).toEqual(['2026-07-01', '2026-10-01']);
  });
  it('近 3 筆平均與讀數：當月或之前最後一個月；失業率月份可能落後', () => {
    const chg = payrollChanges(levels);
    expect(avg3(chg)).toEqual([
      ['2026-09-01', 4.3],
      ['2026-10-01', 6.4],
    ]);
    const unrate: Point[] = [['2026-08-01', 4.1], ['2026-09-01', 4.2]];
    expect(jobsReading(chg, unrate, '2026-11-26')).toEqual({ date: '2026-10-01', change: 16.5, avg: 6.4, unrate: 4.2, unrateDate: '2026-09-01' });
    expect(jobsReading(chg, unrate, '2026-08-15')).toEqual({ date: '2026-08-01', change: -3.2, avg: null, unrate: 4.1, unrateDate: '2026-08-01' });
    expect(jobsReading(chg, [], '2026-07-31')!.unrate).toBeNull();
    expect(jobsReading(chg, unrate, '2026-06-30')).toBeNull();
  });
  it('月份標籤與下個月', () => {
    expect(monthLabel('2026-10-01')).toBe('10月');
    expect(nextMonth('2026-12-01')).toBe('2027-01-01');
  });
});
