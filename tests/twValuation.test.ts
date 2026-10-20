import { describe, expect, it } from 'vitest';
import { INDICATOR_MAP } from '../src/shared/indicators';
import type { Point } from '../src/shared/timeseries';
import {
  perShareSeries,
  summarizeTw,
  twRiverRows,
  valuationBacktest,
  y10Before,
} from '../src/shared/twValuation';

const PE_ZONES = INDICATOR_MAP['tw_pe']!.zones;
const PB_ZONES = INDICATOR_MAP['tw_pb']!.zones;

describe('台股估值：EPS、淨值以月底收盤推算', () => {
  it('每月比率對到該月最後一個交易日；沒有交易日的月份略過', () => {
    const daily: Point[] = [
      ['2026-08-28', 46000],
      ['2026-08-31', 46128],
      ['2026-09-29', 47631],
      ['2026-09-30', 47940],
      ['2026-10-19', 46822],
    ];
    const pe: Point[] = [
      ['2026-07-01', 29.15], // 沒有 7 月交易日 → 略過
      ['2026-08-01', 25.62],
      ['2026-09-01', 26.68],
    ];
    const eps = perShareSeries(pe, daily);
    expect(eps.map((p) => p[0])).toEqual(['2026-08-31', '2026-09-30']);
    expect(eps[1]![1]).toBeCloseTo(47940 / 26.68, 6);
  });

  it('每日本益比＝收盤 ÷ 最近一期 EPS；利差用前一個月以前的台債 10Y', () => {
    const daily: Point[] = [
      ['2026-08-31', 46128],
      ['2026-09-15', 47000],
      ['2026-09-30', 47940],
      ['2026-10-19', 46822],
    ];
    const eps: Point[] = [
      ['2026-08-31', 1800],
      ['2026-09-30', 1797],
    ];
    const bv: Point[] = [
      ['2026-08-31', 11446],
      ['2026-09-30', 11387],
    ];
    const tw10y: Point[] = [
      ['2026-07-01', 1.9],
      ['2026-08-01', 1.955],
      ['2026-09-01', 2.0], // 9 月平均：10 月才用得到
    ];
    const rows = twRiverRows(daily, eps, bv, tw10y);
    expect(rows.map((r) => [r.date, r.eps])).toEqual([
      ['2026-08-31', 1800],
      ['2026-09-15', 1800],
      ['2026-09-30', 1797],
      ['2026-10-19', 1797],
    ]);
    expect(rows[3]!.pe).toBeCloseTo(46822 / 1797, 6);
    expect(rows[3]!.pb).toBeCloseTo(46822 / 11387, 6);
    // 9/15 用 8 月（9 月平均尚未產生）、10/19 用 9 月
    expect(rows[1]!.spread).toBeCloseTo((1800 / 47000) * 100 - 1.955, 6);
    expect(rows[3]!.spread).toBeCloseTo((1797 / 46822) * 100 - 2.0, 6);
    // 太久沒更新（超過 100 天）就不算
    expect(y10Before(tw10y, '2027-02-01')).toBeNull();
    expect(y10Before(tw10y, '2026-10-19')).toEqual(['2026-09-01', 2.0]);
  });
});

describe('台股估值：讀數', () => {
  // 2021-10 起 60 個月：本益比 15～24 循環（平均 19.5）、淨值比 1.6～2.5；最後一期 2026-09 本益比 26.68、淨值比 4.21
  const months = Array.from({ length: 60 }, (_, i) => {
    const k = 2021 * 12 + 9 + i;
    return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}-01`;
  });
  const pe: Point[] = months.map((m, i) => [m, 15 + (i % 10)]);
  const pb: Point[] = months.map((m, i) => [m, 1.6 + (i % 10) * 0.1]);
  pe[59] = ['2026-09-01', 26.68];
  pb[59] = ['2026-09-01', 4.21];
  const dy: Point[] = [['2026-09-01', 1.58]];
  const eps: Point[] = [
    ['2025-09-30', 1208],
    ['2026-09-30', 1797],
  ];
  const tw10y: Point[] = [['2026-08-01', 1.955]];
  const us10y: Point[] = [['2026-10-16', 5.09]];
  const rows = twRiverRows([['2026-10-19', 46822]], eps, [['2026-09-30', 11387]], tw10y);

  it('本益比、區間、5 年平均回推、河道、淨值比、股債利差（台債與美債）', () => {
    const s = summarizeTw(rows, pe, pb, dy, eps, tw10y, us10y, PE_ZONES, PB_ZONES)!;
    expect(s.pe).toBeCloseTo(26.06, 2);
    expect(s.zone).toBe('昂貴');
    expect(s.epsMonth).toBe('2026-09');
    expect(s.epsYoy).toBeCloseTo((1797 / 1208 - 1) * 100, 6);
    // 前 59 個月 15～24 循環（平均 19.42），加上最後 26.68
    const avg = (pe.slice(0, 59).reduce((a, p) => a + p[1], 0) + 26.68) / 60;
    expect(s.avg5).toBeCloseTo(avg, 6);
    expect(s.needGrowth).toBeCloseTo((s.pe / avg - 1) * 100, 6);
    expect(s.needDrop).toBeCloseTo((avg / s.pe - 1) * 100, 6);
    expect(s.position).toMatchObject({ below: 23, above: 27 });
    expect(s.pb).toBeCloseTo(46822 / 11387, 6);
    expect(s.pbZone).toBe('昂貴');
    // 今天 4.11 倍：60 個月中只有 9 月底的 4.21 比它高
    expect(s.pbStats!.pct).toBeCloseTo((59 / 60) * 100, 6);
    expect(s.dy).toBe(1.58);
    expect(s.y10).toBe(1.955);
    expect(s.y10Month).toBe('2026-08');
    expect(s.spread).toBeCloseTo((1797 / 46822) * 100 - 1.955, 6);
    expect(s.usSpread).toBeCloseTo((1797 / 46822) * 100 - 5.09, 6);
  });

  it('不到 60 個月時不算 5 年平均', () => {
    const s = summarizeTw(rows, pe.slice(-20), pb.slice(-20), dy, eps, tw10y, us10y, PE_ZONES, PB_ZONES)!;
    expect(s.avg5).toBeNull();
    expect(s.needGrowth).toBeNull();
  });
});

describe('台股估值：回測（估值區間 vs 之後加權報酬）', () => {
  // 每個交易日都有收盤（連續日，含週末，測試用）：指數每天 +0.04%
  const start = Date.parse('2000-01-01');
  const taiex: Point[] = Array.from({ length: 2400 }, (_, i) => [new Date(start + i * 86_400_000).toISOString().slice(0, 10), 100 * 1.0004 ** i]);
  // 2000-01～2005-12：本益比 12、20、30 輪流；淨值比 1.4、2.2、2.8 輪流
  const pe: Point[] = [];
  const pb: Point[] = [];
  for (let i = 0; i < 72; i++) {
    const m = `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
    pe.push([m, [12, 20, 30][i % 3]!]);
    pb.push([m, [1.4, 2.2, 2.8][i % 3]!]);
  }

  it('分組、月數、1 年與 3 年報酬（月底後 10 天起算）', () => {
    const bt = valuationBacktest(pe, pb, taiex)!;
    expect(bt.start).toBe('2000-01');
    expect(bt.end).toBe('2005-12');
    expect(bt.pe.map((b) => [b.label, b.months])).toEqual([
      ['<15', 24],
      ['15–19', 0],
      ['19–23', 24],
      ['≥23', 24],
    ]);
    expect(bt.pb.map((b) => [b.label, b.months])).toEqual([
      ['<1.5', 24],
      ['1.5–2.0', 0],
      ['2.0–2.5', 24],
      ['≥2.5', 24],
    ]);
    // 每天 +0.04% → 250 個交易日 ≈ +10.5%、750 個交易日年化同樣 ≈ +10.5%
    const r1 = (1.0004 ** 250 - 1) * 100;
    expect(bt.base.avg1).toBeCloseTo(r1, 6);
    expect(bt.base.win1).toBe(100);
    expect(bt.base.avg3).toBeCloseTo(r1, 6);
    // 資料只到第 2400 天：1 年報酬要 250 天、3 年要 750 天，後面的月份沒有完整報酬
    expect(bt.base.n1).toBeLessThan(72);
    expect(bt.base.n3).toBeLessThan(bt.base.n1);
    // 全部在 2013 年前 → 只有前段
    expect(bt.base.early1).toBeCloseTo(r1, 6);
    expect(bt.base.late1).toBeNull();
    expect(bt.pe[1]!.avg1).toBeNull();
  });

  it('股債利差分組：月底盈餘殖利率 − 當月台債 10Y；沒有台債資料就不分組', () => {
    // 本益比 12／20／30 → 盈餘殖利率 8.33／5／3.33；台債 10Y 固定 4% → 利差 +4.33／+1／−0.67
    const tw10y: Point[] = pe.map((p) => [p[0], 4]);
    const bt = valuationBacktest(pe, pb, taiex, tw10y)!;
    expect(bt.spread.map((b) => [b.label, b.months])).toEqual([
      ['<0', 24],
      ['0–3', 24],
      ['≥3', 24],
    ]);
    expect(valuationBacktest(pe, pb, taiex)!.spread).toEqual([]);
  });

  it('樣本少於 24 個月不回測', () => {
    expect(valuationBacktest(pe.slice(0, 10), pb.slice(0, 10), taiex)).toBeNull();
  });
});
