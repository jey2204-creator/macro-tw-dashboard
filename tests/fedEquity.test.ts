import { describe, expect, it } from 'vitest';
import { cycleEvents, eventStats, fedMoves, phaseAt, phaseRows, phaseSegments, phaseStats, sahmSeries } from '../src/shared/fedEquity';
import type { Point } from '../src/shared/timeseries';
import type { Bar } from '../src/shared/types';

const flat = (d: string, c: number): Bar => [d, c, c, c, c];
// 每月 1 日一根（近似）
const monthly = (from: string, n: number, f: (i: number) => number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const [y0, m0] = from.split('-').map(Number) as [number, number];
    const t = m0 - 1 + i;
    return flat(`${y0 + Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`, f(i));
  });

describe('fedMoves：循環反轉需反向累計一碼', () => {
  it('±6bp 的反向微調不算反轉，累計到 25bp 時回頭標第一筆為循環起點', () => {
    const fed: Point[] = [
      ['2000-01-01', 5],
      ['2000-02-01', 5.25], // 升息（第一筆＝起點）
      ['2000-03-01', 5.19], // −6bp 雜訊
      ['2000-04-01', 5.44], // 升息 → 雜訊清除
      ['2000-05-01', 5.31], // −13
      ['2000-06-01', 5.19], // −12 → 累計 −25，反轉；起點為 2000-05-01
      ['2000-07-01', 4.69],
    ];
    const m = fedMoves(fed);
    expect(m.map((x) => [x.date, x.bp, x.trend, x.first])).toEqual([
      ['2000-02-01', 25, true, true],
      ['2000-03-01', -6, false, false],
      ['2000-04-01', 25, true, false],
      ['2000-05-01', -13, true, true],
      ['2000-06-01', -12, true, false],
      ['2000-07-01', -50, true, false],
    ]);
  });
});

describe('phaseSegments：升息／高原／降息／谷底', () => {
  const fed: Point[] = [
    ['2020-01-01', 1],
    ['2020-02-01', 1.25], // 升息期
    ['2021-01-01', 1.25], // 2020-08-02 起超過 183 天 → 高原
    ['2021-03-01', 1.0], // 降息期
    ['2022-06-01', 1.0], // 2021-09-01 起谷底
  ];
  const spx = monthly('2020-01', 30, (i) => 100 + i);
  const segs = phaseSegments(fed, spx.map((b) => b[0]));
  it('依最後一次動作與 183 天切段；第一次動作前沒有階段', () => {
    expect(segs.map((s) => [s.phase, s.from, s.to])).toEqual([
      ['hike', '2020-02-01', '2020-08-01'],
      ['plateau', '2020-09-01', '2021-02-01'],
      ['cut', '2021-03-01', '2021-08-01'],
      ['trough', '2021-09-01', '2022-06-01'],
    ]);
    expect(phaseAt(segs, '2020-01-01')).toBeNull();
    expect(phaseAt(segs, '2020-08-01')).toBe('hike');
    expect(phaseAt(segs, '2020-09-01')).toBe('plateau');
  });
  it('各段漲跌＝段末 ÷ 段前一日 − 1；不足 3 個月不算年化', () => {
    const rows = phaseRows(segs, spx);
    expect(rows[0]!.phase).toBe('trough');
    // hike：2020-02-01（index 1）～2020-08-01（index 7）：107 / 100 − 1
    const hike = rows.find((r) => r.phase === 'hike')!;
    expect(hike.change).toBeCloseTo(7, 5);
    expect(hike.annualized).not.toBeNull();
    const stats = phaseStats(rows);
    expect(stats.map((s) => s.segments)).toEqual([1, 1, 1, 1]);
    expect(stats[0]!.upShare).toBe(100);
  });
});

describe('Sahm 與循環起點', () => {
  it('Sahm＝3 月均值 − 前 12 個月最低 3 月均值', () => {
    const un: Point[] = Array.from({ length: 20 }, (_, i) => [`2023-${String((i % 12) + 1).padStart(2, '0')}-01`, i < 15 ? 4 : 5]);
    const s = sahmSeries(un);
    expect(s[0]![1]).toBe(0);
    expect(s.at(-1)![1]).toBeCloseTo(1, 5);
  });
  it('首次降息後 12 個月內 Sahm ≥ 0.5 標衰退式；資料未滿 12 個月為 null', () => {
    const fed: Point[] = [
      ['2019-01-01', 2.5],
      ['2019-07-01', 2.25],
      ['2019-09-01', 2.0],
    ];
    const spx = monthly('2019-01', 20, (i) => 100 * (1 + i * 0.01));
    const unrate: Point[] = monthly('2017-01', 36, (i) => (i >= 32 ? 5 : 4)).map((b) => [b[0], b[4]]);
    const ev = cycleEvents(fed, spx, unrate);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe('cut');
    expect(ev[0]!.date).toBe('2019-07-01');
    expect(ev[0]!.ret3m).toBeCloseTo(((1.09) / 1.06 - 1) * 100, 5);
    expect(ev[0]!.recession).toBe(true);
    const st = eventStats(ev);
    expect(st[0]!.n).toBe(1);
    expect(st[1]!.n).toBe(0);
  });
});
