import { describe, expect, it } from 'vitest';
import {
  analyzeUsFutures,
  backtest,
  buildRows,
  bucketOf,
  latestReading,
  localHour,
  mergeHourBars,
  partialCorr,
  taipeiTs,
  verdictOf,
  warningsOf,
  type HourBar,
  type UsfHourlyFile,
} from '../src/shared/usFutures';
import type { Bar } from '../src/shared/types';

/** 把 ET 當地時間（冬令，UTC−5）轉 UNIX 秒 */
const etWinter = (d: string, h: number) => Date.parse(`${d}T00:00:00Z`) / 1000 + (h + 5) * 3600;

/** 做一串連續小時 K：從 fromTs 起每小時一根，價格由 fn(ts) 給 */
function hours(fromTs: number, n: number, fn: (ts: number, i: number) => number): HourBar[] {
  const out: HourBar[] = [];
  for (let i = 0; i < n; i++) out.push([fromTs + i * 3600, fn(fromTs + i * 3600, i)]);
  return out;
}

describe('時間工具', () => {
  it('台北 07:00 起點 K 棒＝前一日 23:00 UTC；冬令對應 18:00 ET', () => {
    const ts = taipeiTs('2026-01-15', 7);
    expect(new Date(ts * 1000).toISOString()).toBe('2026-01-14T23:00:00.000Z');
    expect(localHour(ts, 'America/New_York')).toBe(18);
    expect(localHour(ts, 'Asia/Taipei')).toBe(7);
  });
  it('夏令時台北 07:00 ＝ 19:00 ET', () => {
    expect(localHour(taipeiTs('2026-07-15', 7), 'America/New_York')).toBe(19);
  });
  it('mergeHourBars 同時間戳以新為準、排序、丟掉 0 與 NaN', () => {
    expect(mergeHourBars([[100, 1], [200, 2]], [[200, 2.5], [50, 0.5], [300, 0], [400, NaN]])).toEqual([
      [50, 0.5],
      [100, 1],
      [200, 2.5],
    ]);
  });
});

describe('判定', () => {
  it('門檻', () => {
    expect(verdictOf(0.4)).toBe('bull');
    expect(verdictOf(0.39)).toBe('neutral');
    expect(verdictOf(-0.4)).toBe('bear');
    expect(bucketOf(-1)).toBe('b1');
    expect(bucketOf(-0.99)).toBe('b2');
    expect(bucketOf(0)).toBe('b3');
    expect(bucketOf(1)).toBe('b4');
    expect(bucketOf(1.01)).toBe('b5');
  });
  it('警訊：美債跌、美元升、NQ ES 反向', () => {
    expect(warningsOf({ nq: 0.5, es: 0.4, zn: -0.1, dx: 0.1 })).toEqual([]);
    const w = warningsOf({ nq: 0.6, es: -0.2, zn: -0.3, dx: 0.4 });
    expect(w).toHaveLength(3);
    expect(w[0]).toContain('殖利率');
    expect(w[1]).toContain('美元指數');
  });
  it('偏相關：z 完全解釋 x 與 y 時趨近 0', () => {
    const z = [1, 2, 3, 4, 5, 6];
    expect(partialCorr(z, z, z)).toBeNull();
    const x = [1, 2, 3, 4, 5, 6.5];
    const y = [2, 4, 6, 8, 10, 12.4];
    const r = partialCorr(x, y, z);
    expect(r).not.toBeNull();
    expect(Math.abs(r!)).toBeLessThan(1);
  });
});

describe('buildRows 與 latestReading（冬令，2026-01）', () => {
  // 2026-01-13（二）～01-15（四）：美股 01-12、01-13、01-14 收盤
  // 小時 K 從 01-12 00:00 ET 起連續 4 天；NQ 價格：基準 20000，每日 15:00 ET 收盤為 20000+day*100，
  // 隔夜 18:00 ET（台北 07:00）那根 +0.8%，再到 23:00 ET（台北 12:00）那根約 +0.5%
  const start = etWinter('2026-01-12', 0);
  const nq = hours(start, 24 * 4, (ts) => {
    const h = localHour(ts, 'America/New_York');
    const dayIdx = Math.floor((ts - start) / 86_400);
    const base = 20000 + dayIdx * 100;
    if (h === 15) return base;
    if (h >= 18 && h < 23) return base * 1.008;
    if (h === 23) return base * 1.013;
    return base * 0.999;
  });
  const flat = hours(start, 24 * 4, () => 100);
  const hourly: UsfHourlyFile['bars'] = { nq, es: flat, zn: flat };
  const taiex: Bar[] = [
    ['2026-01-12', 23000, 23100, 22900, 23000],
    ['2026-01-13', 23230, 23300, 23200, 23300], // gap +1%、day +1.30%
    ['2026-01-14', 23400, 23500, 23300, 23400],
    ['2026-01-15', 23200, 23300, 23100, 23250],
  ];
  const sox: Bar[] = [
    ['2026-01-09', 5000, 5000, 5000, 5000],
    ['2026-01-12', 5050, 5050, 5050, 5050],
    ['2026-01-13', 5000, 5000, 5000, 5000],
    ['2026-01-14', 5100, 5100, 5100, 5100],
  ];

  it('每個台股日配對到前一個美股 15:00 ET 收盤，隔夜 +0.8%、盤中 +0.5%', () => {
    const rows = buildRows(hourly, taiex, sox);
    expect(rows.map((r) => r.date)).toEqual(['2026-01-13', '2026-01-14', '2026-01-15']);
    const r = rows[0]!;
    expect(r.usDate).toBe('2026-01-12');
    expect(r.on.nq).toBeCloseTo(0.8, 6);
    expect(r.ss.nq).toBeCloseTo(0.496, 2); // 1.013/1.008 − 1
    expect(r.on.es).toBeCloseTo(0, 6);
    expect(r.gap).toBeCloseTo(1, 6);
    expect(r.day).toBeCloseTo(1.3043, 3);
    expect(r.sox).toBeCloseTo(1, 6); // 5000→5050
    expect(r.calDays).toBe(1);
  });
  it('回測：NQ 隔夜 +0.8% 三天都對應加權開盤 → 落在 +0.4～+1% 分組', () => {
    const bt = backtest(buildRows(hourly, taiex, sox));
    expect(bt.n).toBe(3);
    const b4 = bt.buckets.find((b) => b.key === 'b4')!;
    expect(b4.n).toBe(3);
    expect(b4.hit).toBe(67); // 01-15 加權開低
    expect(bt.usable).toBe(false); // 樣本不足
    expect(bt.corr.find((c) => c.id === 'nq')!.n).toBe(3);
    expect(bt.yearly).toEqual([{ year: '2026', n: 3, gap: null, hit: 67 }]);
  });
  it('latestReading：今天 01-16 台北 10:30，用 01-16 07:00 那根；盤中進行中到 10:00', () => {
    // 01-16 台北 10:30 ＝ 01-15 21:30 ET
    const now = new Date(etWinter('2026-01-15', 21.5) * 1000);
    const rows = buildRows(hourly, taiex, sox);
    const l = latestReading(hourly, rows, backtest(rows), now)!;
    expect(l.date).toBe('2026-01-16');
    expect(l.usDate).toBe('2026-01-15');
    expect(l.on.nq).toBeCloseTo(0.8, 6);
    expect(l.verdict).toBe('bull');
    expect(l.ssPartial).toBe(true);
    expect(l.ssToHour).toBe(10);
    expect(l.gap).toBeNull(); // 加權還沒有 01-16
    expect(l.bucket?.key).toBe('b4');
  });
  it('latestReading：台北 08:30 時 07:00 那根已收盤但還沒有盤中資料', () => {
    // 01-16 台北 08:30 ＝ 01-15 19:30 ET；小時資料只到 01-15 23:00 ET 起點那根 → 仍可用（資料存在）
    const now = new Date(etWinter('2026-01-15', 19.5) * 1000);
    const rows = buildRows(hourly, taiex, sox);
    const l = latestReading(hourly, rows, backtest(rows), now)!;
    expect(l.date).toBe('2026-01-16');
    expect(l.ss.nq).toBeUndefined();
    expect(l.ssToHour).toBeNull();
  });
  it('analyzeUsFutures 輸出檔格式', () => {
    const f = analyzeUsFutures(hourly, taiex, sox, new Date(etWinter('2026-01-15', 21) * 1000));
    expect(f.schemaVersion).toBe(1);
    expect(f.rows).toHaveLength(3);
    expect(f.latest?.date).toBe('2026-01-16');
  });
  it('沒有 NQ 資料回傳空列與 null', () => {
    expect(buildRows({ es: flat }, taiex, sox)).toEqual([]);
    expect(latestReading({}, [], backtest([]), new Date())).toBeNull();
  });
});

describe('parseIntraday', () => {
  it('最後一根的時間戳取整到小時起點、同小時以後者為準', async () => {
    const { parseIntraday } = await import('../scripts/fetch-data/writeUsFutures');
    const bars = parseIntraday({
      chart: {
        result: [{ timestamp: [3600, 7200, 7200 + 3599], indicators: { quote: [{ close: [1, 2, 2.5] }] } }],
        error: null,
      },
    });
    expect(bars).toEqual([
      [3600, 1],
      [7200, 2.5],
    ]);
  });
});
