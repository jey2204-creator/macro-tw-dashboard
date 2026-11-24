import { describe, expect, it } from 'vitest';
import { curveText, gdpNowcast, gdpYoy, nextQuarter, quarterLabel } from '../src/shared/gdpGrowth';
import type { Point } from '../src/shared/timeseries';

describe('gdpGrowth', () => {
  it('季度標籤與下一季', () => {
    expect(quarterLabel('2026-07-01')).toBe('26Q3');
    expect(quarterLabel('2026-01-01')).toBe('26Q1');
    expect(nextQuarter('2026-10-01')).toBe('2027-01-01');
    expect(nextQuarter('2026-04-01')).toBe('2026-07-01');
  });

  it('年化季增連乘四季換算年增；每季 2% 年化＝年增 2%', () => {
    const pts: Point[] = ['2025-01-01', '2025-04-01', '2025-07-01', '2025-10-01', '2026-01-01'].map((d) => [d, 2]);
    expect(gdpYoy(pts)).toEqual([
      ['2025-10-01', 2],
      ['2026-01-01', 2],
    ]);
  });

  it('2020 年單季 −28%／+35% 換算年增落在個位數到十幾 %', () => {
    const pts: Point[] = [
      ['2019-07-01', 2.6],
      ['2019-10-01', 2.4],
      ['2020-01-01', -5.5],
      ['2020-04-01', -28],
      ['2020-07-01', 35.2],
    ];
    const y = gdpYoy(pts);
    expect(y[0]![0]).toBe('2020-04-01');
    expect(y[0]![1]).toBeGreaterThan(-9);
    expect(y[0]![1]).toBeLessThan(-6);
  });

  it('中間缺季就不算', () => {
    const pts: Point[] = [
      ['2025-01-01', 2],
      ['2025-04-01', 2],
      ['2025-10-01', 2],
      ['2026-01-01', 2],
    ];
    expect(gdpYoy(pts)).toEqual([]);
  });

  it('GDPNow：只在估的季度還沒有實際值時回傳，配前三季算推估年增', () => {
    const act: Point[] = ['2026-01-01', '2026-04-01', '2026-07-01'].map((d) => [d, 2]);
    expect(gdpNowcast(act, [['2026-10-01', 2]])).toEqual({ date: '2026-10-01', saar: 2, yoy: 2 });
    expect(gdpNowcast(act, [['2026-07-01', 3]])).toBeNull();
    expect(gdpNowcast(act.slice(1), [['2026-10-01', 2]])?.yoy).toBeNull();
  });

  it('殖利率曲線判讀', () => {
    expect(curveText(-0.1)).toBe('倒掛');
    expect(curveText(0.29)).toBe('偏平');
    expect(curveText(1.2)).toBe('正斜率');
  });
});
