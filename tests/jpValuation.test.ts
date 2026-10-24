import { describe, expect, it } from 'vitest';
import { INDICATOR_MAP } from '../src/shared/indicators';
import {
  epsJumps,
  jp10yBefore,
  jpRiverRows,
  jpValuationBacktest,
  monthEndRows,
  summarizeJp,
} from '../src/shared/jpValuation';
import type { Point } from '../src/shared/timeseries';

const PE_ZONES = INDICATOR_MAP['jp_fwd_pe']!.zones;
const PB_ZONES = INDICATOR_MAP['jp_pb']!.zones;

describe('日股估值：日經收盤與當日 PER 配對', () => {
  const nikkei: Point[] = [
    ['2026-10-21', 64621.24],
    ['2026-10-22', 62907.84],
    ['2026-10-23', 62693.16],
    ['2026-10-26', 63000], // 當天 PER 還沒公布 → 略過
  ];
  const pe: Point[] = [
    ['2026-10-21', 21.4],
    ['2026-10-22', 20.83],
    ['2026-10-23', 20.76],
  ];
  const peW: Point[] = [
    ['2026-10-21', 17.0],
    ['2026-10-23', 16.65],
  ];
  const pb: Point[] = [['2026-10-23', 2.4]];
  const jp10y: Point[] = [
    ['2026-08-01', 1.6],
    ['2026-09-01', 1.7], // 9 月平均：10 月才用得到
  ];

  it('預估 EPS＝收盤 ÷ PER；加重平均、淨值比缺的日子為 null；利差用上個月以前的日債', () => {
    const rows = jpRiverRows(nikkei, pe, peW, pb, jp10y);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    expect(rows[2]!.eps).toBeCloseTo(62693.16 / 20.76, 6);
    expect(rows[1]!.peW).toBeNull();
    expect(rows[2]!.peW).toBe(16.65);
    expect(rows[0]!.pb).toBeNull();
    expect(rows[2]!.pb).toBe(2.4);
    expect(rows[2]!.spread).toBeCloseTo((1 / 20.76) * 100 - 1.7, 6);
  });

  it('日債 10Y：取 date 所在月之前最近一筆，超過 100 天不用', () => {
    expect(jp10yBefore(jp10y, '2026-10-23')?.[0]).toBe('2026-09-01');
    expect(jp10yBefore(jp10y, '2026-09-15')?.[0]).toBe('2026-08-01');
    expect(jp10yBefore(jp10y, '2027-01-20')).toBeNull();
  });

  it('月底列＝每月最後一個交易日', () => {
    const rows = jpRiverRows(
      [
        ['2026-09-29', 100],
        ['2026-09-30', 101],
        ['2026-10-01', 102],
        ['2026-10-23', 103],
      ],
      [
        ['2026-09-29', 20],
        ['2026-09-30', 20],
        ['2026-10-01', 20],
        ['2026-10-23', 20],
      ],
      [],
      [],
      [],
    );
    expect(monthEndRows(rows).map((r) => r.date)).toEqual(['2026-09-30', '2026-10-23']);
  });
});

describe('日股估值：換年度標記與摘要', () => {
  it('單日 EPS 變動 ≥3% 標記，連續幾天只標第一天', () => {
    const dates = ['05-11', '05-12', '05-13', '05-14', '05-15', '05-18'].map((d) => `2026-${d}`);
    const price = dates.map(() => 40000);
    // PER 從 20 → 19.2（EPS +4.2%）→ 18.5（+3.8%）→ 18.4（+0.5%）→ 18.4 → 19.0（−3.2%）
    const per = [20, 19.2, 18.5, 18.4, 18.4, 19.0];
    const rows = jpRiverRows(
      dates.map((d, i) => [d, price[i]!]),
      dates.map((d, i) => [d, per[i]!]),
      [],
      [],
      [],
    );
    const jumps = epsJumps(rows);
    expect(jumps.map((j) => j.date)).toEqual(['2026-05-12', '2026-05-18']);
    expect(jumps[0]!.pct).toBeGreaterThan(3);
    expect(jumps[1]!.pct).toBeLessThan(-3);
  });

  it('摘要：區間、河道位置、加重平均差距、近 20 日 EPS 變動', () => {
    const n = 300;
    const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
    const nikkei: Point[] = dates.map((d, i) => [d, 40000 + i * 50]);
    // PER 固定 20.76 → EPS 隨指數上升；最後 20 天 PER 跳到 22（EPS 下修約 5.6%）
    const pe: Point[] = dates.map((d, i) => [d, i >= n - 20 ? 22 : 20.76]);
    const peW: Point[] = dates.map((d) => [d, 16.65]);
    const pb: Point[] = dates.map((d) => [d, 2.4]);
    const rows = jpRiverRows(nikkei, pe, peW, pb, []);
    const s = summarizeJp(rows, [[dates.at(-1)!, 1.5]], [], [], PE_ZONES, PB_ZONES)!;
    expect(s.pe).toBe(22);
    expect(s.zone).toBe('偏高');
    expect(s.position.below).toBe(20);
    expect(s.position.above).toBe(23);
    expect(s.peGap).toBeCloseTo(22 - 16.65, 6);
    expect(s.pbZone).toBe('昂貴');
    expect(s.dy).toBe(1.5);
    expect(s.epsChg20).toBeLessThan(-3);
    expect(s.lastJump?.date).toBe(dates[n - 20]);
    expect(s.spread).toBeNull();
  });
});

describe('日股估值：回測用月底值、不等公布延遲', () => {
  it('每個月底一個樣本，之後一年報酬從月底當天起算', () => {
    // 2004-09 起 60 個月、每月 2 個交易日，指數每月 +1%
    const nikkei: Point[] = [];
    const pe: Point[] = [];
    let p = 10000;
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(2004, 8 + i, 1));
      const ym = d.toISOString().slice(0, 7);
      nikkei.push([`${ym}-10`, p], [`${ym}-20`, p * 1.005]);
      pe.push([`${ym}-10`, i < 30 ? 15 : 22], [`${ym}-20`, i < 30 ? 15 : 22]);
      p *= 1.01;
    }
    const rows = jpRiverRows(nikkei, pe, [], [], []);
    const bt = jpValuationBacktest(rows, nikkei, [])!;
    expect(bt).not.toBeNull();
    expect(bt.start).toBe('2004-09');
    expect(bt.split).toBe('2013-01');
    expect(bt.pe.map((b) => b.months)).toEqual([0, 30, 0, 30, 0]);
    // 1 年＝250 個交易日，這裡每月只有 2 天 → 沒有完整一年的樣本不算
    expect(bt.base.months).toBe(60);
  });
});
