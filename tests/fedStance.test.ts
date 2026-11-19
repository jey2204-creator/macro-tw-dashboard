import { describe, expect, it } from 'vitest';
import { marketBet, realLean, stanceAt, stanceBaseline, stanceHeadline, stanceSamples, stanceStats, taylorLean, taylorRate } from '../src/shared/fedStance';
import type { Point } from '../src/shared/timeseries';
import type { Bar } from '../src/shared/types';

const monthly = (from: number, to: number, v: (y: number, m: number) => number): Point[] => {
  const out: Point[] = [];
  for (let y = from; y <= to; y++) for (let m = 1; m <= 12; m++) out.push([`${y}-${String(m).padStart(2, '0')}-01`, v(y, m)]);
  return out;
};

describe('fedStance', () => {
  it('泰勒法則：通膨 2%、失業率＝自然失業率 → 法則利率 4%', () => {
    expect(taylorRate(2, 4.4, 4.4)).toBeCloseTo(4);
    // 通膨 3% → 2 + 3 + 0.5 = 5.5；失業率低於自然 0.5pp → 再 +0.5
    expect(taylorRate(3, 4.4, 4.4)).toBeCloseTo(5.5);
    expect(taylorRate(3, 3.9, 4.4)).toBeCloseTo(6);
  });

  it('門檻分組', () => {
    expect([realLean(-0.1), realLean(0.5), realLean(1)]).toEqual(['loose', 'mid', 'tight']);
    expect([taylorLean(1), taylorLean(0.99), taylorLean(-1)]).toEqual(['loose', 'mid', 'tight']);
    expect([marketBet(-0.25), marketBet(0.1), marketBet(0.25)]).toEqual(['cut', 'hold', 'hike']);
  });

  const inp = {
    fed: [['2019-01-01', 2], ['2020-07-01', 4], ['2021-12-31', 4]] as Point[],
    coreCpi: monthly(2019, 2021, () => 2.5),
    corePce: monthly(2019, 2021, () => 3),
    unrate: monthly(2019, 2021, () => 4),
    nrou: [['2019-01-01', 4.5]] as Point[],
    us2y: [['2019-01-01', 3], ['2020-07-01', 3.5]] as Point[],
  };

  it('目前讀數與一句話', () => {
    const s = stanceAt(inp, '2021-12-31')!;
    expect(s.real).toBeCloseTo(1.5);
    expect(s.taylor).toBeCloseTo(6); // 2 + 3 + 0.5 + 0.5*2*0.5
    expect(s.taylorGap).toBeCloseTo(2);
    expect(s.spread).toBeCloseTo(-0.5);
    expect(stanceHeadline(s)).toBe('實質利率偏緊、比泰勒法則鬆、市場押降息');
  });

  it('沒有自然失業率 → 泰勒那格為 null，其餘照算', () => {
    const s = stanceAt({ ...inp, nrou: [] }, '2021-12-31')!;
    expect(s.taylor).toBeNull();
    expect(s.taylorLean).toBeNull();
    expect(s.realLean).toBe('tight');
    expect(stanceHeadline(s)).toBe('實質利率偏緊、市場押降息');
  });

  it('回測用公布落後：月初日期 + 45 天之後才看得到', () => {
    const late = { ...inp, corePce: [['2019-01-01', 3], ['2019-06-01', 9]] as Point[] };
    expect(stanceAt(late, '2019-06-30', 45)!.corePce).toBe(3);
    expect(stanceAt(late, '2019-07-31', 45)!.corePce).toBe(9);
  });

  it('樣本與分組：之後 12 個月 Fed 變動、指數報酬', () => {
    const bars: Bar[] = [['2019-01-02', 100, 100, 100, 100], ['2020-06-30', 110, 110, 110, 110], ['2021-12-31', 121, 121, 121, 121]];
    const samples = stanceSamples(inp, { spx: bars }, '2019-06-01');
    const first = samples[0]!;
    expect(first.date).toBe('2019-06-30');
    expect(first.fedChg).toBeCloseTo(0); // 2020-06-29 仍是 2%
    expect(samples.find((x) => x.date === '2019-07-31')!.fedChg).toBeCloseTo(2);
    expect(samples.at(-1)!.fedChg).toBeNull(); // 未滿 12 個月
    const stats = stanceStats(samples, ['spx']);
    expect(stats).toHaveLength(9);
    const hike = stats.find((x) => x.key === 'spread' && x.group === 'hike')!;
    expect(hike.n).toBeGreaterThan(0);
    expect(hike.hikePct).toBeGreaterThan(50);
    const base = stanceBaseline(samples, ['spx']);
    expect(base.n).toBe(samples.filter((x) => x.fedChg !== null).length);
  });
});
