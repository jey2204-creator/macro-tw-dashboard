import { describe, expect, it } from 'vitest';
import { INDICATOR_MAP } from '../src/shared/indicators';
import {
  KR_PB_MULTIPLES,
  epsJumps,
  kr10yBefore,
  krMsciSummary,
  krRiverRows,
  krValuationBacktest,
  perShareSeries,
  summarizeKr,
} from '../src/shared/krValuation';
import type { Point } from '../src/shared/timeseries';

const PB_ZONES = INDICATOR_MAP['kr_pb']!.zones;
const PE_ZONES = INDICATOR_MAP['kr_pe']!.zones;

describe('韓股估值：KRX 月底比率 → 每日淨值比／本益比', () => {
  const kospi: Point[] = [
    ['2026-08-28', 6500],
    ['2026-08-31', 6600],
    ['2026-09-01', 6835.8],
    ['2026-09-29', 7000],
    ['2026-09-30', 7100],
    ['2026-10-23', 7500],
  ];
  const pbM: Point[] = [
    ['2026-08-01', 1.95],
    ['2026-09-01', 1.7],
  ];
  const peM: Point[] = [
    ['2026-08-01', 18.64],
    ['2026-09-01', 11.4],
  ];
  const kr10y: Point[] = [
    ['2026-08-01', 4.2],
    ['2026-09-01', 4.3],
  ];

  it('每股淨值＝月底收盤 ÷ 淨值比；之後每天淨值比＝收盤 ÷ 最近一期每股淨值', () => {
    const bv = perShareSeries(pbM, kospi);
    expect(bv).toEqual([
      ['2026-08-31', 6600 / 1.95],
      ['2026-09-30', 7100 / 1.7],
    ]);
    const eps = perShareSeries(peM, kospi);
    const rows = krRiverRows(kospi, bv, eps, kr10y);
    expect(rows.map((r) => r.date)).toEqual(['2026-08-31', '2026-09-01', '2026-09-29', '2026-09-30', '2026-10-23']);
    expect(rows[0]!.pb).toBeCloseTo(1.95, 6);
    expect(rows[1]!.pb).toBeCloseTo(6835.8 / (6600 / 1.95), 6);
    expect(rows[4]!.pb).toBeCloseTo(7500 / (7100 / 1.7), 6);
    expect(rows[4]!.pe).toBeCloseTo(7500 / (7100 / 11.4), 6);
    // 10 月的利差用 9 月平均韓債
    expect(rows[4]!.spread).toBeCloseTo(((7100 / 11.4) / 7500) * 100 - 4.3, 6);
    // 9 月 1 日用 8 月平均
    expect(rows[1]!.spread).toBeCloseTo(((6600 / 18.64) / 6835.8) * 100 - 4.2, 6);
  });

  it('韓債 10Y：取 date 所在月之前最近一筆，超過 100 天不用', () => {
    expect(kr10yBefore(kr10y, '2026-10-23')?.[0]).toBe('2026-09-01');
    expect(kr10yBefore(kr10y, '2026-09-15')?.[0]).toBe('2026-08-01');
    expect(kr10yBefore(kr10y, '2027-01-20')).toBeNull();
  });

  it('換財報：每股純益單月變動 ≥8% 的月份', () => {
    const eps: Point[] = [
      ['2026-06-30', 300],
      ['2026-07-31', 305],
      ['2026-08-31', 310],
      ['2026-09-30', 500], // 半年報併入
    ];
    expect(epsJumps(eps)).toEqual([{ date: '2026-09-30', pct: (500 / 310 - 1) * 100 }]);
  });

  it('摘要：區間、百分位、河道位置、換財報、殖利率與利差', () => {
    // 2004 起每月淨值比 1.0～1.3 循環，最後一期 1.7（昂貴）
    const pb: Point[] = [];
    const pe: Point[] = [];
    const dy: Point[] = [];
    const idx: Point[] = [];
    const y10: Point[] = [];
    for (let i = 0; i < 273; i++) {
      const y = 2004 + Math.floor(i / 12);
      const m = String((i % 12) + 1).padStart(2, '0');
      const d = `${y}-${m}-01`;
      const last = `${y}-${m}-28`;
      pb.push([d, i === 272 ? 1.7 : 1.0 + (i % 10) * 0.03]);
      pe.push([d, i === 272 ? 11.4 : 12 + (i % 10) * 0.5]);
      dy.push([d, 0.93]);
      y10.push([d, 4.3]);
      idx.push([last, 1000 + i * 20]);
    }
    const bv = perShareSeries(pb, idx);
    const eps = perShareSeries(pe, idx);
    const rows = krRiverRows(idx, bv, eps, y10);
    const s = summarizeKr(rows, pb, pe, dy, bv, eps, y10, [['2026-09-28', 4.0]], PB_ZONES, PE_ZONES)!;
    expect(s.date).toBe('2026-09-28');
    expect(s.pb).toBeCloseTo(1.7, 6);
    expect(s.pbZone).toBe('昂貴');
    expect(s.pbStats!.pct).toBeGreaterThan(99);
    expect(s.position.below).toBe(1.6);
    expect(s.position.above).toBe(2.0);
    expect(s.pe).toBeCloseTo(11.4, 6);
    expect(s.peZone).toBe('偏低');
    expect(s.lastJump?.date).toBe('2026-09-28');
    expect(s.dy).toBe(0.93);
    expect(s.earningsYield).toBeCloseTo(100 / 11.4, 6);
    expect(s.y10).toBe(4.3);
    expect(s.spread).toBeCloseTo(100 / 11.4 - 4.3, 6);
    expect(s.usSpread).toBeCloseTo(100 / 11.4 - 4.0, 6);
    expect(s.dataMonth).toBe('2026-09');
    expect(KR_PB_MULTIPLES.at(-1)).toBe(2);
  });

  it('MSCI 韓國：預估本益比、隱含成長、與上一期比', () => {
    const fwd: Point[] = [
      ['2026-07-31', 6.2],
      ['2026-08-29', 5.5],
      ['2026-09-30', 4.95],
    ];
    const pe: Point[] = [['2026-09-30', 10.25]];
    const pbv: Point[] = [['2026-09-30', 2.29]];
    const m = krMsciSummary(fwd, pe, pbv, '2026-10-23')!;
    expect(m.fwdPe).toBe(4.95);
    expect(m.pe).toBe(10.25);
    expect(m.pbv).toBe(2.29);
    expect(m.impliedGrowth).toBeCloseTo((10.25 / 4.95 - 1) * 100, 6);
    expect(m.prevAsOf).toBe('2026-08-29');
    expect(m.min[0]).toBe('2026-09-30');
    expect(m.max[0]).toBe('2026-07-31');
    expect(m.median).toBe(5.5);
    expect(m.stale).toBe(false);
    expect(krMsciSummary(fwd, pe, pbv, '2027-01-15')!.stale).toBe(true);
    expect(krMsciSummary([], pe, pbv, '2026-10-23')).toBeNull();
  });

  it('回測：月底值、公布後 5 天起算；資料不足 24 個月回 null', () => {
    const pb: Point[] = [];
    const pe: Point[] = [];
    const idx: Point[] = [];
    const y10: Point[] = [];
    const t0 = Date.UTC(2004, 0, 1);
    for (let i = 0; i < 365 * 6; i++) {
      const d = new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
      idx.push([d, 1000 + i]);
    }
    for (let i = 0; i < 72; i++) {
      const d = `${2004 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
      pb.push([d, 1.1]);
      pe.push([d, 13]);
      y10.push([d, 4]);
    }
    const bt = krValuationBacktest(pe, pb, idx, y10)!;
    expect(bt.start).toBe('2004-01');
    expect(bt.pb.map((b) => b.label)).toEqual(['<0.9', '0.9–1.1', '1.1–1.3', '1.3–1.6', '≥1.6']);
    expect(bt.pb[2]!.months).toBeGreaterThan(60);
    expect(bt.spread.length).toBe(3);
    expect(krValuationBacktest(pe.slice(0, 12), pb.slice(0, 12), idx, y10)).toBeNull();
  });
});
