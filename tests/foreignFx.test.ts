import { describe, expect, it } from 'vitest';
import type { ForeignRow } from '../src/shared/foreignChips';
import { analyzeForeignFx, flowState, fxChanges, fxMove, fxOnRows } from '../src/shared/foreignFx';
import type { Point } from '../src/shared/timeseries';

const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
const row = (i: number, taiex: number): ForeignRow => [day(i), taiex, 0, 0, 0, null, null, null, null];

describe('外資買賣超 × 台幣', () => {
  it('匯率對到每個交易日：取當日或之前最近一筆，序列開始前為 null', () => {
    const rows = [row(0, 100), row(1, 100), row(2, 100), row(3, 100)];
    const pts: Point[] = [
      [day(1), 30],
      [day(3), 31],
    ];
    expect(fxOnRows(rows, pts)).toEqual([null, 30, 30, 31]);
  });

  it('20 日變化：正＝台幣貶；不足 20 天或缺值為 null', () => {
    const fx = Array.from({ length: 25 }, (_, i) => (i === 2 ? null : 30 + i * 0.1));
    const chg = fxChanges(fx);
    expect(chg[19]).toBeNull();
    expect(chg[20]).toBeCloseTo(((32 / 30 - 1) * 100), 2);
    expect(chg[22]).toBeNull(); // 20 天前那筆缺值
  });

  it('分組門檻：買賣超第 20／80 百分位、台幣 ±1%', () => {
    expect([flowState(0.2), flowState(0.21), flowState(0.8), flowState(null)]).toEqual(['sell', 'mid', 'buy', null]);
    expect([fxMove(1), fxMove(0.99), fxMove(-1), fxMove(null)]).toEqual(['weak', 'flat', 'strong', null]);
  });

  it('統計：每格天數、獨立段數（相隔超過 20 個交易日才算新的一段）、跌逾 10% 比例與最新讀數', () => {
    // 200 天：台幣每天貶 0.1%（20 日約 +2%）；第 30～34、100～104 天賣超偏重，其餘一般
    const rows = Array.from({ length: 200 }, (_, i) => row(i, i >= 101 && i <= 140 ? 80 : 100));
    const pctl = rows.map((_, i) => ((i >= 30 && i <= 34) || (i >= 100 && i <= 104) ? 0.1 : 0.5));
    const pts: Point[] = rows.map((r, i) => [r[0], 30 * 1.001 ** i]);
    const out = analyzeForeignFx(rows, pctl, pts);
    const sellWeak = out.cells.find((c) => c.flow === 'sell' && c.move === 'weak')!;
    expect(sellWeak.n).toBe(10);
    expect(sellWeak.runs).toBe(2);
    // 第 100 天之後 60 日內跌到 80（−20%）；第 101～104 天本身已是 80 → 10 天裡只有第 100 天算大跌
    expect(sellWeak.crash60).toBe(10);
    expect(out.cells.find((c) => c.flow === 'sell' && c.move === 'flat')!.n).toBe(0);
    expect(out.fx).toHaveLength(200);
    expect(out.fx[10]![1]).toBeNull();
    expect(out.latest).toMatchObject({ date: day(199), flow: 'mid', move: 'weak' });
    expect(out.latest!.chg20).toBeCloseTo(2.02, 1);
  });
});
