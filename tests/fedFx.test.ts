import { describe, expect, it } from 'vitest';
import { fxGroup, fxPctLine, fxSamples, fxStats, hikeCycles, spliceCloses, spliceUsdTwd } from '../src/shared/fedFx';
import type { Point } from '../src/shared/timeseries';
import type { Bar } from '../src/shared/types';

const flat = (d: string, c: number): Bar => [d, c, c, c, c];
/** 每月 15 日與月底各一根 */
function twiceMonthly(from: string, n: number, f: (i: number) => number): Bar[] {
  const [y0, m0] = from.split('-').map(Number) as [number, number];
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const t = m0 - 1 + i;
    const ym = `${y0 + Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
    out.push(flat(`${ym}-15`, f(i)), flat(`${ym}-28`, f(i)));
  }
  return out;
}

describe('fedFx：升息 × 美元／台幣', () => {
  it('fxGroup 門檻 ±2%；spliceCloses 舊資料只補在新資料之前', () => {
    expect([fxGroup(2), fxGroup(1.99), fxGroup(-2), fxGroup(0)]).toEqual(['weak', 'flat', 'strong', 'flat']);
    expect(spliceCloses([flat('2004-03-24', 32), flat('2004-03-25', 32.1)], [flat('2004-03-23', 33), flat('2004-03-24', 99)])).toEqual([
      ['2004-03-23', 33],
      ['2004-03-24', 32],
      ['2004-03-25', 32.1],
    ]);
  });

  it('spliceUsdTwd：FRED 為主，Yahoo 只接 FRED 最後一天之後；沒有 FRED 就全用 Yahoo', () => {
    const yahoo = [flat('2014-12-31', 3.67), flat('2026-11-06', 32.9), flat('2026-11-16', 32.95)];
    expect(spliceUsdTwd([flat('2014-12-31', 31.6), flat('2026-11-06', 32.85)], yahoo)).toEqual([
      ['2014-12-31', 31.6],
      ['2026-11-06', 32.85],
      ['2026-11-16', 32.95],
    ]);
    expect(spliceUsdTwd([], yahoo).length).toBe(3);
  });

  it('hikeCycles：第一次升息 → 最後一次升息後 183 天，期間美元、台幣、指數漲跌與自高點最大跌幅', () => {
    const fed: Point[] = [
      ['2020-01-01', 1],
      ['2020-03-15', 1.25], // 第一次升息
      ['2020-06-15', 1.5], // 最後一次升息 → 升息期到 2020-12-15
      ['2021-06-15', 1.25], // 下一個循環（降息）
    ];
    // 指數：100 → 120（5 月）→ 90（8 月）→ 110
    const idx = twiceMonthly('2020-01', 18, (i) => [100, 100, 100, 110, 120, 110, 100, 90, 100, 105, 110, 110, 110, 110, 110, 110, 110, 110][i]!);
    const twd: Point[] = [['2020-01-01', 30], ['2020-03-15', 30], ['2020-12-15', 31.5]];
    const dxy: Point[] = [['2020-06-01', 100]]; // 起點之後才有資料 → null
    const [c] = hikeCycles(fed, idx, dxy, twd);
    expect(c).toMatchObject({ from: '2020-03-15', to: '2020-12-15', ongoing: false, hikes: 2, bp: 50, dxy: null });
    expect(c!.twd).toBeCloseTo(5, 6);
    expect(c!.index).toBeCloseTo(10, 6);
    expect(c!.drawdown).toBeCloseTo(-25, 6);
  });

  it('fxSamples／fxStats：只取月底、依台幣 3 個月變化分組，升息期與其他時期分開', () => {
    const fed: Point[] = [['2020-01-01', 1], ['2020-06-10', 1.25]];
    const idx = twiceMonthly('2020-01', 24, (i) => 100 + i);
    // 台幣：2020-06 前持平，之後每月貶 1%
    const twd: Point[] = twiceMonthly('2019-09', 28, (i) => (i < 9 ? 30 : 30 * 1.01 ** (i - 9))).map((b) => [b[0], b[4]]);
    const ss = fxSamples(fed, idx, twd);
    expect(ss.every((s) => s.date.endsWith('-28'))).toBe(true);
    // 最新一個月還沒走完不取
    expect(ss.at(-1)!.date).toBe('2021-11-28');
    const aug = ss.find((s) => s.date === '2020-08-28')!;
    expect(aug.hike).toBe(true);
    expect(aug.group).toBe('weak');
    expect(aug.ret3m).toBeCloseTo((110 / 107 - 1) * 100, 6);
    // 升息後超過 183 天＝高原，不算升息期
    expect(ss.find((s) => s.date === '2021-01-28')!.hike).toBe(false);
    // 未滿 12 個月的樣本 ret12m 為 null
    expect(ss.at(-1)!.ret12m).toBeNull();
    const st = fxStats(ss);
    expect(st.hike.map((r) => r.group)).toEqual(['weak', 'flat', 'strong', 'all']);
    expect(st.hike[3]!.n).toBe(ss.filter((s) => s.hike).length);
    expect(st.hike[3]!.n + st.other[3]!.n).toBe(ss.length);
    expect(st.hike[0]!.crash3m).toBe(0);
  });

  it('fxPctLine：以區間起點為 0%，整段歷史都換算', () => {
    const pts: Point[] = [['2025-01-02', 30], ['2025-08-20', 32], ['2025-11-14', 33]];
    const l = fxPctLine(pts, '2025-11-14', '3M')!;
    expect(l.baseDate).toBe('2025-08-20');
    expect(l.points[0]![1]).toBeCloseTo(-6.25, 6);
    expect(l.last).toBeCloseTo(3.125, 6);
    expect(fxPctLine(pts, '2025-11-14', 'ALL')!.baseDate).toBe('2025-01-02');
  });
});
