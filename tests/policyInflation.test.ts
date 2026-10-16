import { describe, expect, it } from 'vitest';
import {
  lastSignFlip,
  monthEnd,
  realRateSeries,
  realRateState,
  splicePolicyRate,
  summarize,
  valueAtOrBefore,
  yoyPoints,
} from '../src/shared/policyInflation';
import type { Bar } from '../src/shared/types';

const flat = (d: string, v: number): Bar => [d, v, v, v, v];

describe('政策利率 vs 通膨', () => {
  it('拼接 Fed：舊單一目標只取區間上緣第一天之前', () => {
    const legacy = [flat('2008-12-01', 1), flat('2008-12-15', 1), flat('2008-12-16', 1)];
    const upper = [flat('2008-12-16', 0.25), flat('2008-12-17', 0.25)];
    expect(splicePolicyRate(upper, legacy)).toEqual([
      ['2008-12-01', 1],
      ['2008-12-15', 1],
      ['2008-12-16', 0.25],
      ['2008-12-17', 0.25],
    ]);
    expect(splicePolicyRate(upper)).toHaveLength(2);
  });

  it('月底與 ≤ 日期取值', () => {
    expect(monthEnd('2026-02-01')).toBe('2026-02-28');
    expect(monthEnd('2026-12-15')).toBe('2026-12-31');
    const pts: [string, number][] = [['2026-01-05', 1], ['2026-01-20', 2]];
    expect(valueAtOrBefore(pts, '2026-01-04')).toBeNull();
    expect(valueAtOrBefore(pts, '2026-01-20')).toBe(2);
    expect(valueAtOrBefore(pts, '2026-01-10')).toBe(1);
  });

  it('實質利率＝該月月底的 Fed 減該月年增；Fed 尚無資料的月份略過', () => {
    const idx: Bar[] = [];
    for (let m = 1; m <= 12; m++) idx.push(flat(`2025-${String(m).padStart(2, '0')}-01`, 100));
    idx.push(flat('2026-01-01', 103), flat('2026-02-01', 104));
    const yoy = yoyPoints(idx);
    expect(yoy.map(([d]) => d)).toEqual(['2026-01-01', '2026-02-01']);
    const fed: [string, number][] = [['2026-01-28', 4.0], ['2026-02-10', 3.75]];
    const rows = realRateSeries(fed, yoy);
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe('2026-01-01');
    expect(rows[0]![1]).toBe(4.0);
    expect(rows[0]![3]).toBeCloseTo(1.0, 6);
    expect(rows[1]![1]).toBe(3.75);
    expect(rows[1]![3]).toBeCloseTo(-0.25, 6);
    // Fed 2026-01-28 之前無資料 → 2025 年若有年增也會略過
    expect(realRateSeries([['2026-03-01', 4]], yoy)).toHaveLength(0);
  });

  it('狀態分類與目前讀數', () => {
    expect(realRateState(-0.1)).toBe('loose');
    expect(realRateState(0)).toBe('mid');
    expect(realRateState(1)).toBe('tight');
    const s = summarize([['2026-10-15', 4.0]], [['2026-09-01', 3.1]]);
    expect(s?.real).toBeCloseTo(0.9, 6);
    expect(s?.state).toBe('mid');
    expect(s?.gapToTarget).toBeCloseTo(1.1, 6);
    expect(summarize([], [['2026-09-01', 3.1]])).toBeNull();
  });

  it('最近一次正負翻轉', () => {
    expect(lastSignFlip([['2026-01-01', 4, 5, -1], ['2026-02-01', 4, 3.9, 0.1], ['2026-03-01', 4, 3.5, 0.5]])).toEqual({ date: '2026-02-01', to: 'positive' });
    expect(lastSignFlip([['2026-01-01', 4, 3, 1], ['2026-02-01', 4, 4.5, -0.5]])).toEqual({ date: '2026-02-01', to: 'negative' });
    expect(lastSignFlip([['2026-01-01', 4, 3, 1]])).toBeNull();
  });
});
