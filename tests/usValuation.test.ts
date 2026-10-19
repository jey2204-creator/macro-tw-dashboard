import { describe, expect, it } from 'vitest';
import { INDICATOR_MAP } from '../src/shared/indicators';
import type { Point } from '../src/shared/timeseries';
import {
  bandPosition,
  epsSeries,
  lowestSince,
  median,
  monthlySpread,
  peStats,
  percentile,
  riverRows,
  spreadText,
  summarize,
  yoyOfLast,
} from '../src/shared/usValuation';
import { dailySeries, monthlySeries } from './helpers';

const ZONES = INDICATOR_MAP['spx_pe']!.zones;

describe('美股估值：EPS 推算與河道', () => {
  it('EPS＝月均價 ÷ 本益比，依月份配對；當月「今天」列的日期保留', () => {
    const pe: Point[] = [['2026-08-01', 25], ['2026-09-01', 26], ['2026-10-16', 26.12]];
    const price: Point[] = [['2026-08-01', 7500], ['2026-09-01', 7670], ['2026-10-16', 7715.79]];
    const eps = epsSeries(pe, price);
    expect(eps.map((p) => p[0])).toEqual(['2026-08-01', '2026-09-01', '2026-10-16']);
    expect(eps[0]![1]).toBeCloseTo(300, 6);
    expect(eps[2]![1]).toBeCloseTo(295.4, 1);
    // 沒有對應月份的價格就略過
    expect(epsSeries([['2026-11-01', 20]], price)).toEqual([]);
  });

  it('每個交易日取 ≤ 該日的最後一筆 EPS；10Y 落後 1–2 天仍可用、太舊不用', () => {
    const spx: Point[] = [['2026-09-29', 7600], ['2026-09-30', 7650], ['2026-10-01', 7700], ['2026-10-02', 7800]];
    const eps: Point[] = [['2026-09-01', 290], ['2026-10-01', 300]];
    const us10y: Point[] = [['2026-09-28', 5.0], ['2026-10-01', 5.3]];
    const rows = riverRows(spx, eps, us10y);
    expect(rows.map((r) => r.eps)).toEqual([290, 290, 300, 300]);
    expect(rows[0]!.pe).toBeCloseTo(7600 / 290, 6);
    // 9/30：EPS 290 ÷ 7650 ＝ 3.79%，10Y 取 9/28 的 5.0 → −1.21pp
    expect(rows[1]!.spread).toBeCloseTo((290 / 7650) * 100 - 5.0, 6);
    expect(rows[3]!.spread).toBeCloseTo((300 / 7800) * 100 - 5.3, 6);
    // EPS 開始前的日子略過；10Y 太舊（超過 10 天）為 null
    expect(riverRows([['2026-08-01', 7000], ...spx], eps, us10y).length).toBe(4);
    expect(riverRows([['2026-10-20', 7900]], eps, [['2026-10-12', 5.3]])[0]!.spread).toBeCloseTo((300 / 7900) * 100 - 5.3, 6);
    expect(riverRows([['2026-10-20', 7900]], eps, [['2026-09-01', 5.3]])[0]!.spread).toBeNull();
  });

  it('百分位、中位數、基期統計', () => {
    expect(percentile([1, 2, 3, 4], 3)).toBe(62.5); // 2 個低於 + 1 個同值算半
    expect(percentile([1, 2, 3, 4], 10)).toBe(100);
    expect(percentile([], 1)).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const pe = monthlySeries(2009, [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 20, 22, 24, 26]);
    const st = peStats(pe, 25, '2010-01-01')!;
    expect(st.n).toBe(4); // 2009 年的 12 筆不算
    expect(st.median).toBe(23);
    expect(st.pct).toBe(75);
  });

  it('河道位置：落在哪兩條倍數線之間與距離', () => {
    const p = bandPosition(7716, 295.4);
    expect(p.below).toBe(23);
    expect(p.above).toBe(27);
    expect(p.distAbove).toBeCloseTo((7716 / (295.4 * 27) - 1) * 100, 6);
    expect(p.distBelow).toBeCloseTo((7716 / (295.4 * 23) - 1) * 100, 6);
    expect(bandPosition(10000, 295.4).above).toBeNull();
    expect(bandPosition(4000, 295.4).below).toBeNull();
  });

  it('月利差與「哪個月以來最低」', () => {
    const eps = monthlySeries(2024, [300, 300, 300]);
    const priceM = monthlySeries(2024, [6000, 7500, 6000]);
    const y10 = dailySeries('2024-01-01', Array.from({ length: 100 }, () => 4));
    const ms = monthlySpread(eps, priceM, y10);
    expect(ms.map((p) => p[0])).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
    expect(ms[0]![1]).toBeCloseTo(1, 6); // 5% − 4%
    expect(ms[1]![1]).toBeCloseTo(0, 6);
    // 最新值 −0.5：往回最後一個更低的月份不存在 → 資料起點
    expect(lowestSince(ms, -0.5, '2024-04-01')).toBe('2024-01');
    // 最新值 0.5：2024-02（0）比它低 → 2024-03 以來最低
    expect(lowestSince(ms, 0.5, '2024-04-01')).toBe('2024-03');
    // 最新值比所有歷史都高 → 2024-03 的下一個月＝自己的月份
    expect(lowestSince(ms, 2, '2024-04-01')).toBe('2024-04');
    expect(lowestSince([], 1, '2024-04-01')).toBeNull();
  });

  it('年增率與利差判讀', () => {
    const eps = monthlySeries(2025, Array.from({ length: 13 }, (_, i) => 200 + i * 10));
    expect(yoyOfLast(eps)).toBeCloseTo(60, 6); // 320 vs 200
    expect(yoyOfLast(eps.slice(-3))).toBeNull();
    expect(spreadText(1.2)).toBe('股票較划算');
    expect(spreadText(0.3)).toBe('接近打平');
    expect(spreadText(-1.5)).toBe('債券較划算');
    expect(spreadText(null)).toBe('—');
  });

  it('摘要：最新讀數、區間、基期百分位、CAPE', () => {
    // 2008-01 起 36 個月的本益比（15～30），最新 26.12
    const peM = monthlySeries(2008, Array.from({ length: 36 }, (_, i) => 15 + (i % 16)));
    const priceM = monthlySeries(2008, Array.from({ length: 36 }, (_, i) => 1000 + i * 10));
    const eps = epsSeries(peM, priceM);
    const last = eps.at(-1)!; // 2010-12-01
    const spx: Point[] = [['2010-12-30', last[1] * 26.12], ['2010-12-31', last[1] * 26.12]];
    const y10 = dailySeries('2010-12-01', Array.from({ length: 31 }, () => 5.33));
    const cape = monthlySeries(2008, Array.from({ length: 36 }, (_, i) => 20 + i)); // 最新 55 ＝ 歷史最高
    const s = summarize(riverRows(spx, eps, y10), peM, eps, priceM, y10, cape, ZONES)!;
    expect(s.date).toBe('2010-12-31');
    expect(s.pe).toBeCloseTo(26.12, 6);
    expect(s.zone).toBe('偏高');
    expect(s.peStats!.n).toBe(12); // 2010 年起
    expect(s.position.below).toBe(23);
    expect(s.position.above).toBe(27);
    expect(s.earningsYield).toBeCloseTo(100 / 26.12, 6);
    expect(s.y10).toBeCloseTo(5.33, 6);
    expect(s.spread).toBeCloseTo(100 / 26.12 - 5.33, 6);
    expect(s.cape).toBe(55);
    expect(s.capePct).toBeCloseTo((35 + 0.5) / 36 * 100, 6);
    expect(summarize([], peM, eps, priceM, y10, cape, ZONES)).toBeNull();
  });
});
