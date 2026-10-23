import { describe, expect, it } from 'vitest';
import { assessCuts, creditLevel, hyLevel, readingsAt, sahmLevel, verdictOf, verdictStats } from '../src/shared/cutRegime';
import type { Point } from '../src/shared/timeseries';
import type { Bar } from '../src/shared/types';

const flat = (d: string, c: number): Bar => [d, c, c, c, c];
const monthStart = (from: string, i: number) => {
  const [y0, m0] = from.split('-').map(Number) as [number, number];
  const t = m0 - 1 + i;
  return `${y0 + Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
};
const monthly = (from: string, n: number, f: (i: number) => number): Point[] => Array.from({ length: n }, (_, i) => [monthStart(from, i), f(i)]);

describe('門檻分級與判定', () => {
  it('就業、信用三級', () => {
    expect(sahmLevel(null)).toBe('na');
    expect(sahmLevel(0.1)).toBe('normal');
    expect(sahmLevel(0.3)).toBe('watch');
    expect(sahmLevel(0.5)).toBe('recession');
    expect(creditLevel(2.49)).toBe('normal');
    expect(creditLevel(2.5)).toBe('watch');
    expect(creditLevel(3.5)).toBe('recession');
    expect(hyLevel(399)).toBe('normal');
    expect(hyLevel(600)).toBe('recession');
  });
  it('兩個都到衰退才是衰退式；一個到是衰退警訊；警戒；都正常；無資料不算', () => {
    expect(verdictOf('recession', 'recession')).toEqual({ verdict: 'recession', hits: 2 });
    expect(verdictOf('recession', 'normal')).toEqual({ verdict: 'alert', hits: 1 });
    expect(verdictOf('normal', 'recession')).toEqual({ verdict: 'alert', hits: 1 });
    expect(verdictOf('watch', 'normal')).toEqual({ verdict: 'watch', hits: 0 });
    expect(verdictOf('normal', 'na')).toEqual({ verdict: 'insurance', hits: 0 });
  });
});

describe('readingsAt：只用判定日看得到的資料', () => {
  // 失業率 2018-01 起 4.0，2020-01 起每月 +0.5 → Sahm 2020-02 起 ≥ 0.5（Sahm 需 15 個月資料，2019-03 起有值）
  const unrate = monthly('2018-01', 30, (i) => (i < 24 ? 4 : 4 + (i - 23) * 0.5));
  const credit: Point[] = [
    ['2020-03-01', 2.6],
    ['2020-03-10', 4.3],
  ];
  const hy: Point[] = [['2020-03-10', 10.0]];
  const coreCpi = monthly('2018-01', 30, () => 2.3);
  const fed: Point[] = [
    ['2019-12-01', 1.75],
    ['2020-03-03', 1.25],
    ['2020-03-16', 0.25],
  ];
  const inp = { fed, unrate, credit, hy, coreCpi };
  it('月資料加 45 天延遲：3/3 只看得到 1 月失業率（Sahm 尚未觸發）', () => {
    const r = readingsAt(inp, '2020-03-03');
    expect(r.sahmDate).toBe('2020-01-01');
    expect(r.sahmLevel).toBe('normal');
    expect(r.creditDate).toBe('2020-03-01');
    expect(r.credit).toBe(2.6);
    expect(r.hy).toBeNull();
    expect(r.verdict).toBe('watch');
    expect(r.paceBp).toBe(-50);
    expect(r.lastMoveBp).toBe(-50);
    expect(r.inflationHot).toBe(false);
  });
  it('3/16 第二次降息：Baa−10Y 4.3pp 到衰退門檻、2 月失業率要 3/17 才看得到 → 3/16 是衰退警訊；90 天累計 −150bp', () => {
    const r = readingsAt(inp, '2020-03-16');
    expect(r.credit).toBe(4.3);
    expect(r.creditLevel).toBe('recession');
    expect(r.hy).toBe(1000);
    expect(r.hyLevel).toBe('recession');
    expect(r.sahmLevel).toBe('normal');
    expect(r.verdict).toBe('alert');
    expect(r.paceBp).toBe(-150);
  });
  it('3/17 起看得到 2 月失業率（Sahm 0.5）→ 兩項都到＝衰退式', () => {
    const r = readingsAt(inp, '2020-03-17');
    expect(r.sahmDate).toBe('2020-02-01');
    expect(r.sahmLevel).toBe('recession');
    expect(r.verdict).toBe('recession');
  });
  it('核心 CPI 距目標超過 1pp 標通膨未解', () => {
    const r = readingsAt({ ...inp, coreCpi: monthly('2018-01', 30, () => 3.5) }, '2020-05-20');
    expect(r.inflationHot).toBe(true);
    expect(r.coreGap).toBeCloseTo(1.5);
  });
});

describe('assessCuts：當時判定 vs 事後，含「幾個月後轉更壞」', () => {
  const unrate = monthly('2018-01', 40, (i) => (i < 24 ? 4 : 4 + (i - 23) * 0.5));
  const credit = monthly('2018-01', 40, (i) => (i < 26 ? 2 : 4));
  const coreCpi = monthly('2018-01', 40, () => 2.2);
  const fed: Point[] = [
    ['2018-01-01', 2.5],
    ['2019-12-01', 2.25], // 第一次降息（當時一切正常）
    ['2020-03-16', 0.25],
  ];
  const spx = Array.from({ length: 1200 }, (_, i) => {
    const d = new Date(Date.UTC(2018, 0, 1 + i)).toISOString().slice(0, 10);
    return flat(d, 100 + i / 10);
  });
  const rows = assessCuts({ fed, unrate, credit, coreCpi }, spx, []);
  it('第一次降息當時判預防性，事後觸發 Sahm，規則在幾個月後轉衰退式', () => {
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.event.date).toBe('2019-12-01');
    expect(r.at.verdict).toBe('insurance');
    expect(r.recession).toBe(true);
    // Baa−10Y 2020-03 起 4pp（3/2 可見）、Sahm 2020-02 月資料 3/17 可見 → 4 月檢查點轉衰退式（3/1 檢查點兩者都還看不到）
    expect(r.worst).toEqual({ verdict: 'recession', date: '2020-04-01' });
    expect(r.event.ret12m).not.toBeNull();
    expect(r.taiex12m).toBeNull();
  });
  it('統計依當時判定分組', () => {
    const st = verdictStats(rows);
    expect(st.find((s) => s.verdict === 'insurance')).toMatchObject({ n: 1, recessions: 1, known: 1, taiexN: 0 });
    expect(st.find((s) => s.verdict === 'recession')!.n).toBe(0);
  });
});
