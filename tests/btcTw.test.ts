import { describe, expect, it } from 'vitest';
import { buildDayRows, buildGapRows, crashRows, lastIndexAtOrBefore, olsBeta, partialCorr, verdictOf, type CorrStat, type GapStat } from '../src/shared/btcTw';
import type { Bar } from '../src/shared/types';

const bar = (d: string, c: number, o = c): Bar => [d, o, Math.max(o, c), Math.min(o, c), c];

describe('btcTw', () => {
  it('lastIndexAtOrBefore 二分搜尋', () => {
    const bars = [bar('2024-01-01', 1), bar('2024-01-03', 2), bar('2024-01-05', 3)];
    expect(lastIndexAtOrBefore(bars, '2023-12-31')).toBe(-1);
    expect(lastIndexAtOrBefore(bars, '2024-01-03')).toBe(1);
    expect(lastIndexAtOrBefore(bars, '2024-01-04')).toBe(1);
    expect(lastIndexAtOrBefore(bars, '2025-01-01')).toBe(2);
  });

  it('olsBeta 與偏相關：y 完全由 z 解釋時，x 的偏相關接近 0', () => {
    const z = [1, -2, 3, -1, 2, 0, -3, 1];
    const y = z.map((v) => 2 * v);
    expect(olsBeta(z, y)).toBeCloseTo(2);
    const x = [0.3, 0.1, -0.2, 0.5, -0.4, 0.2, 0.1, -0.3];
    const r = partialCorr(x, y, z);
    expect(r === null || Math.abs(r) < 1e-6).toBe(true);
  });

  // 2024-01-05 週五、01-08 週一
  const tw = [bar('2024-01-04', 100), bar('2024-01-05', 101), bar('2024-01-08', 98, 99), bar('2024-01-09', 99)];
  const btc = [
    bar('2024-01-03', 1000),
    bar('2024-01-04', 1010),
    bar('2024-01-05', 1000), // 收盤＝週六 08:00 台北
    bar('2024-01-06', 950),
    bar('2024-01-07', 900), // 收盤＝週一 08:00 台北
    bar('2024-01-08', 910),
  ];
  const sox = [bar('2024-01-03', 50), bar('2024-01-04', 51), bar('2024-01-05', 50), bar('2024-01-08', 51)];

  it('週一配對：比特幣週末三根合併；費半是週五那根', () => {
    const days = buildDayRows(tw, btc, sox);
    const mon = days.find((d) => d.date === '2024-01-08')!;
    // 週五 08:00（01-04 收盤 1010）→ 週一 08:00（01-07 收盤 900）
    expect(mon.btc).toBeCloseTo((900 / 1010 - 1) * 100);
    expect(mon.sox).toBeCloseTo((50 / 51 - 1) * 100);
    expect(mon.tw).toBeCloseTo((98 / 101 - 1) * 100);
  });

  it('休市期間只算週五美股收盤後到週一開盤前', () => {
    const days = buildDayRows(tw, btc, sox);
    const gaps = buildGapRows(tw, btc, days);
    expect(gaps).toHaveLength(1);
    const g = gaps[0]!;
    expect(g.date).toBe('2024-01-08');
    expect(g.days).toBe(3);
    expect(g.btcGap).toBeCloseTo(-10); // 1000 → 900
    expect(g.open).toBeCloseTo((99 / 101 - 1) * 100);
    expect(g.close).toBeCloseTo((98 / 101 - 1) * 100);
  });

  it('大跌事件：≤ −7% 才算', () => {
    const days = buildDayRows(tw, btc, sox).map((d) => ({ ...d, date: d.date.replace('2024', '2020') }));
    const tw2 = tw.map((b) => [b[0].replace('2024', '2020'), ...b.slice(1)] as Bar);
    const c = crashRows(tw2, days);
    expect(c.map((x) => x.date)).toEqual(['2020-01-08']);
  });

  it('判定：取 2020 起日資料與週末兩個偏相關絕對值較大者', () => {
    const corr = [{ period: { key: 'late' }, btcExSox: 0.05 }] as unknown as CorrStat[];
    const gap = [{ period: { key: 'late' }, corrResid: 0.15 }] as unknown as GapStat[];
    expect(verdictOf(corr, gap)).toEqual({ verdict: 'weak', score: 0.15 });
    const gap2 = [{ period: { key: 'late' }, corrResid: 0.25 }] as unknown as GapStat[];
    expect(verdictOf(corr, gap2).verdict).toBe('useful');
  });
});
