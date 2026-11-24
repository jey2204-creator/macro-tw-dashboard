import { describe, expect, it } from 'vitest';
import { oilReading } from '../src/shared/oil';
import type { Point } from '../src/shared/timeseries';

describe('oilReading', () => {
  const pts: Point[] = [['2025-01-02', 50]];
  for (let i = 0; i < 25; i++) pts.push([`2026-01-${String(i + 2).padStart(2, '0')}`, 60 + i]);
  it('價格、年增（一年前同日或之前）、20 個交易日漲跌', () => {
    const r = oilReading(pts, '2026-01-26')!;
    expect(r.price).toBe(84);
    expect(r.yoy).toBeCloseTo(68, 5); // 84 / 50
    expect(r.d20).toBeCloseTo((84 / 64 - 1) * 100, 5);
  });
  it('一年前沒資料、不到 20 筆時給 null；日期早於資料給 null', () => {
    expect(oilReading(pts.slice(1), '2026-01-26')!.yoy).toBeNull();
    expect(oilReading(pts, '2026-01-05')!.d20).toBeNull();
    expect(oilReading(pts, '2024-12-31')).toBeNull();
  });
});
