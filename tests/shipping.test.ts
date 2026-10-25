import { describe, expect, it } from 'vitest';
import { revenueToBars } from '../scripts/fetch-data/sources/finmindRevenue';
import { mergeScfi, parseSseCurrent } from '../scripts/fetch-data/sources/sse';
import { adjustYahooChart } from '../scripts/fetch-data/sources/yahoo';
import { addDays, addMonths } from '../src/shared/dates';
import {
  cycles,
  monthObs,
  revenueKnownDate,
  revRows,
  revState,
  scfiState,
  signals,
  stockState,
  verdictOf,
  yoyBuckets,
} from '../src/shared/shipping';
import type { Bar } from '../src/shared/types';

const bar = (d: string, c: number): Bar => [d, c, c, c, c];

/** 每週五一期 */
function weekly(start: string, values: number[]): Bar[] {
  return values.map((v, i) => bar(addDays(start, 7 * i), v));
}
function monthly(start: string, values: number[]): Bar[] {
  return values.map((v, i) => bar(addMonths(start, i), v));
}
/** 連續交易日（含週末，測試用） */
function daily(start: string, values: number[]): Bar[] {
  return values.map((v, i) => bar(addDays(start, i), v));
}

describe('SCFI 來源', () => {
  it('parseSseCurrent 取綜合指數的本期與上期', () => {
    const pts = parseSseCurrent({
      data: {
        currentDate: '2026-10-23',
        lastDate: '2026-10-16',
        lineDataList: [
          { properties: { lineName_EN: 'Europe 20ft (Base port)' }, currentContent: null, lastContent: null },
          { properties: { lineName_EN: 'Comprehensive Index' }, currentContent: 3681.3369, lastContent: 3679.579 },
        ],
      },
    });
    expect(pts).toEqual([
      ['2026-10-16', 3679.579],
      ['2026-10-23', 3681.3369],
    ]);
  });

  it('mergeScfi：種子 → 快取 → 最新，後者覆蓋前者並排序', () => {
    const out = mergeScfi(
      [
        ['2026-10-09', 3664.11],
        ['2026-10-16', 1],
      ],
      [bar('2026-10-02', 3662.3), bar('2026-10-16', 2)],
      [['2026-10-16', 3679.579]],
    );
    expect(out.map((b) => [b[0], b[4]])).toEqual([
      ['2026-10-02', 3662.3],
      ['2026-10-09', 3664.11],
      ['2026-10-16', 3679.58],
    ]);
  });
});

describe('月營收與還原股價來源', () => {
  it('revenueToBars 用營收所屬月份、換成億元', () => {
    const bars = revenueToBars([
      { date: '2026-10-01', stock_id: '2603', revenue: 49711309000, revenue_year: 2026, revenue_month: 9 },
      { date: '2026-09-01', stock_id: '2603', revenue: 48985697000, revenue_year: 2026, revenue_month: 8 },
    ]);
    expect(bars.map((b) => [b[0], b[4]])).toEqual([
      ['2026-08-01', 489.86],
      ['2026-09-01', 497.11],
    ]);
  });

  it('adjustYahooChart：開高低收乘上 adjclose ÷ close', () => {
    const j = adjustYahooChart({
      chart: {
        error: null,
        result: [
          {
            meta: { regularMarketPrice: 155 },
            timestamp: [1, 2],
            indicators: { quote: [{ open: [150, 90], high: [160, 95], low: [140, 85], close: [155, 93.5] }], adjclose: [{ adjclose: [77.5, 93.5] }] },
          },
        ],
      },
    });
    const q = j.chart.result![0]!.indicators.quote[0]!;
    expect(q.close).toEqual([77.5, 93.5]);
    expect(q.open![0]).toBeCloseTo(75);
    expect(j.chart.result![0]!.meta.regularMarketPrice).toBeUndefined();
  });
});

describe('目前狀態與轉空訊號', () => {
  it('scfiState：連跌週數、距 26 週高點、4 週變化；稀疏間隔不算連續', () => {
    const s = scfiState([bar('2026-01-02', 1000), ...weekly('2026-08-28', [3500, 3600, 3700, 3650, 3400])])!;
    expect(s.downStreak).toBe(2);
    expect(s.wow).toBeCloseTo(((3400 - 3650) / 3650) * 100);
    expect(s.high).toBe(3700);
    expect(s.ddFromHigh).toBeCloseTo(((3400 - 3700) / 3700) * 100);
    expect(s.chg4w).toBeCloseTo(((3400 - 3500) / 3500) * 100);
    const sparse = scfiState([bar('2026-01-02', 2000), bar('2026-03-06', 1800)])!;
    expect(sparse.downStreak).toBe(0);
    expect(sparse.wow).toBeNull();
  });

  it('revRows／revState：年增、3 個月合計年增、24 個月高點', () => {
    const vals = [...Array(12).fill(100), ...Array(11).fill(150), 120];
    const rows = revRows(monthly('2024-01-01', vals));
    const st = revState(rows)!;
    expect(st.month).toBe('2025-12');
    expect(st.mom).toBeCloseTo(-20);
    expect(st.yoy).toBeCloseTo(20);
    expect(st.yoy3).toBeCloseTo(((150 + 150 + 120) / 300 - 1) * 100);
    expect(st.atHigh24).toBe(false);
  });

  it('signals：兩項亮燈＝減碼；資料不足為 null 不計入', () => {
    const s = scfiState(weekly('2026-08-28', [3700, 3600, 3300]))!;
    const r = revState(revRows(monthly('2026-01-01', [100, 120])))!;
    const px = daily('2026-01-01', [...Array(80).fill(200), ...Array(30).fill(150)]);
    const k = stockState(px)!;
    const sig = signals(s, r, k);
    expect(sig.find((x) => x.key === 'scfiDown')!.on).toBe(true);
    expect(sig.find((x) => x.key === 'scfiDd')!.on).toBe(true);
    expect(sig.find((x) => x.key === 'revMom')!.on).toBe(false);
    expect(sig.find((x) => x.key === 'belowMa60')!.on).toBe(true);
    expect(verdictOf(sig).verdict).toBe('reduce');
    expect(verdictOf(signals(null, null, null))).toEqual({ verdict: 'calm', on: 0, known: 0 });
  });
});

describe('回測', () => {
  it('revenueKnownDate：營收月份的下個月 11 日', () => {
    expect(revenueKnownDate('2026-09-01')).toBe('2026-10-11');
    expect(revenueKnownDate('2026-12-01')).toBe('2027-01-11');
  });

  it('monthObs 在公布後才進場；yoyBuckets 依 3 個月年增分組', () => {
    const rev = monthly('2004-01-01', [...Array(12).fill(100), ...Array(12).fill(200), ...Array(12).fill(200)]);
    const px = daily('2004-01-01', Array.from({ length: 1500 }, (_, i) => 100 + i));
    const obs = monthObs(revRows(rev), px);
    const first = obs[0]!;
    // 3 個月合計年增要有前一年同期 3 個月：2005-03 起
    expect(first.month).toBe('2005-03');
    expect(first.entry).toBe('2005-04-11');
    expect(first.yoy).toBeCloseTo(100);
    expect(first.fwd.m3).toBeGreaterThan(0);
    const b = yoyBuckets(obs);
    // 2005-03～12 ＋ 2006-01（600／400＝+50%）
    expect(b.rows.find((r) => r.key === 'boom')!.h.m3.n).toBe(11);
    expect(b.rows.find((r) => r.key === 'flat')!.h.m3.n).toBeGreaterThan(0);
    expect(b.base.h.m3.n).toBe(obs.length);
  });

  it('cycles：股價先見頂時 leadMonths 為正，ddAtKnown 為負', () => {
    // 營收 2008 一路升到 2010-06 高點再回落；股價 2009-12 見頂
    const revVals: number[] = [];
    for (let i = 0; i < 72; i++) {
      const m = i - 54; // 2010-07 為 0
      revVals.push(m <= 0 ? 100 + Math.max(0, 30 + m) * 10 : 400 - m * 15);
    }
    const rev = monthly('2006-01-01', revVals);
    const days = 6 * 365;
    const peakDay = Math.round(4 * 365);
    const px = daily(
      '2006-01-01',
      Array.from({ length: days }, (_, i) => (i <= peakDay ? 50 + i * 0.1 : 50 + peakDay * 0.1 - (i - peakDay) * 0.08)),
    );
    const cs = cycles(revRows(rev), px);
    expect(cs.length).toBe(1);
    const c = cs[0]!;
    expect(c.revPeak >= '2010-06').toBe(true);
    expect(c.stockPeak.slice(0, 7)).toBe('2009-12');
    expect(c.leadMonths).toBeGreaterThan(0);
    expect(c.ddAtKnown).toBeLessThan(0);
  });
});
