import { describe, expect, it } from 'vitest';
import { addDays } from '../src/shared/dates';
import { fibRetracement } from '../src/shared/fibonacci';
import type { Bar } from '../src/shared/types';

/** 依收盤序列造 K 棒（高＝收＋1、低＝收−1），日期連續 */
const bars = (start: string, closes: number[]): Bar[] => closes.map((c, i) => [addDays(start, i), c, c + 1, c - 1, c]);

describe('fibRetracement', () => {
  it('2026 年波段：低 29,008（1/2）→ 高 49,969（10/6）→ 今 43,400，多頭回撤，0.382 ≈ 41,962', () => {
    const closes = [...Array.from({ length: 40 }, (_, i) => 29008 + 1 + i * 500), 49969 - 1, ...Array.from({ length: 30 }, () => 43400)];
    const f = fibRetracement(bars('2026-01-02', closes), null)!;
    expect(f.direction).toBe('up');
    expect(f.lo).toBe(29008);
    expect(f.hi).toBe(49969);
    expect(f.levels.find((l) => l.ratio === 0.382)!.price).toBeCloseTo(41961.8, 0);
    expect(f.levels.find((l) => l.ratio === 0.618)!.price).toBeCloseTo(37015.1, 0);
    expect(f.current).toBeCloseTo((49969 - 43400) / (49969 - 29008), 4);
    expect(f.between).toEqual([0.236, 0.382]);
  });
  it('低點在高點之後＝空頭反彈：由低點往上畫壓力', () => {
    const closes = [...Array.from({ length: 30 }, (_, i) => 200 - i * 3), ...Array.from({ length: 25 }, () => 130)];
    const f = fibRetracement(bars('2025-01-01', closes), null)!;
    expect(f.direction).toBe('down');
    expect(f.hi).toBe(201);
    expect(f.lo).toBe(112);
    expect(f.levels[0]!.price).toBeCloseTo(112 + 89 * 0.236, 6);
    expect(f.current).toBeCloseTo((130 - 112) / 89, 6);
  });
  it('只看 startDate 之後的 K 棒；高低點太近（< 20 根）不算波段', () => {
    const closes = [...Array.from({ length: 60 }, (_, i) => 100 + i), ...Array.from({ length: 10 }, (_, i) => 160 - i * 5)];
    const all = fibRetracement(bars('2025-01-01', closes), null)!;
    expect(all.direction).toBe('up');
    expect(all.lo).toBe(99);
    // 最後 15 根：高點在第 0 根、低點在第 14 根，相隔 14 < 20
    expect(fibRetracement(bars('2025-01-01', closes), addDays('2025-01-01', 55))).toBeNull();
    expect(fibRetracement(bars('2025-01-01', closes), addDays('2025-01-01', 55), 5)!.direction).toBe('down');
  });
  it('資料不足或沒有波幅回 null', () => {
    expect(fibRetracement([], null)).toBeNull();
    expect(fibRetracement(bars('2025-01-01', Array.from({ length: 30 }, () => 100)), null)).toBeNull();
  });
});

import { fibSkipText } from '../src/shared/fibonacci';
describe('fibSkipText', () => {
  const bar = (d: string, p: number): Bar => [d, p, p + 1, p - 1, p];
  it('最低點是最新一根 → 創新低說明；否則相隔太近', () => {
    const down = Array.from({ length: 10 }, (_, i) => bar(`2026-01-${String(i + 1).padStart(2, '0')}`, 100 - i));
    expect(fibSkipText(down, null, '3個月')).toContain('創3個月新低');
    const up = Array.from({ length: 10 }, (_, i) => bar(`2026-01-${String(i + 1).padStart(2, '0')}`, 100 + i));
    expect(fibSkipText(up, null, '1年')).toContain('創1年新高');
    const mid = [bar('2026-01-01', 100), bar('2026-01-02', 90), bar('2026-01-03', 110), bar('2026-01-04', 100)];
    expect(fibSkipText(mid, null, '1年')).toContain('不到 20 根');
  });
});
