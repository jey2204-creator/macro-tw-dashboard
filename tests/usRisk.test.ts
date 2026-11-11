import { describe, expect, it } from 'vitest';
import { addDays } from '../src/shared/dates';
import type { Bar } from '../src/shared/types';
import {
  alignAsOf,
  backtestRisk,
  buildRiskRows,
  creditProxyLit,
  liquidityWeeks,
  riskSignals,
  riskVerdict,
  taiexForward,
  type RiskInputs,
  type RiskRow,
} from '../src/shared/usRisk';

const bar = (d: string, c: number): Bar => [d, c, c, c, c];
/** 連續日（含週末，測試用） */
const daily = (start: string, values: number[]): Bar[] => values.map((v, i) => bar(addDays(start, i), v));
const weekly = (start: string, values: number[]): Bar[] => values.map((v, i) => bar(addDays(start, 7 * i), v));
const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

const START = '2020-01-01';
function inputs(over: Partial<RiskInputs> = {}, n = 120): RiskInputs {
  return {
    spx: daily(START, flat(n, 100)),
    vix: daily(START, flat(n, 15)),
    vix3m: daily(START, flat(n, 18)),
    rsp: daily(START, flat(n, 50)),
    spy: daily(START, flat(n, 100)),
    baa: daily(START, flat(n, 1.8)),
    hy: daily(START, flat(n, 3)),
    walcl: weekly(START, flat(20, 7_000_000)),
    tga: weekly(START, flat(20, 800_000)),
    rrp: daily(START, flat(n, 200)),
    taiex: [],
    ...over,
  };
}

describe('alignAsOf', () => {
  it('取當天或之前最近一筆，太舊就給 null', () => {
    const bars = [bar('2020-01-01', 1), bar('2020-01-03', 3)];
    expect(alignAsOf(['2019-12-31', '2020-01-01', '2020-01-02', '2020-01-03', '2020-01-20'], bars, 5)).toEqual([null, 1, 1, 3, null]);
  });
});

describe('淨流動性', () => {
  it('Fed 總資產 − TGA（百萬）− RRP（十億）換成十億美元，4 週變化與 4 期前相減', () => {
    const w = liquidityWeeks(weekly(START, [7_000_000, 7_000_000, 7_000_000, 7_000_000, 6_850_000]), weekly(START, flat(5, 800_000)), daily(START, flat(40, 200)));
    expect(w[0]!.net).toBeCloseTo(7000 - 800 - 200);
    expect(w[3]!.chg4w).toBeNull();
    expect(w[4]!.chg4w).toBeCloseTo(-150);
  });
  it('沒有 RRP 資料當 0；沒有 TGA 的週不算', () => {
    const w = liquidityWeeks(weekly(START, [7_000_000, 7_000_000]), [bar(addDays(START, 7), 500_000)], []);
    expect(w).toHaveLength(1);
    expect(w[0]!.net).toBeCloseTo(6500);
  });
  it('週三資料延後 2 天才可用', () => {
    const rows = buildRiskRows(inputs());
    expect(rows[0]!.netLiq).toBeNull();
    expect(rows[1]!.netLiq).toBeNull();
    expect(rows[2]!.netLiq).toBeCloseTo(6000);
    expect(rows[2]!.liqDate).toBe(START);
  });
  it('4 週減少逾 1,000 億亮燈', () => {
    const walcl = weekly(START, [...flat(6, 7_000_000), ...flat(14, 6_880_000)]);
    const rows = buildRiskRows(inputs({ walcl }));
    const at = rows.find((r) => r.liqDate === addDays(START, 42))!;
    expect(at.liqChg4w).toBeCloseTo(-120);
    expect(at.lit.liq).toBe(true);
    expect(rows.at(-1)!.lit.liq).toBe(false);
  });
});

describe('燈號', () => {
  it('信用代理：水位或 20 日擴大', () => {
    expect(creditProxyLit(null, null)).toBeNull();
    expect(creditProxyLit(1.8, 0.1)).toBe(false);
    expect(creditProxyLit(2.5, 0)).toBe(true);
    expect(creditProxyLit(2.0, 0.3)).toBe(true);
  });
  it('信用燈用前一個交易日的值（利差隔天才公布）', () => {
    const baa = daily(START, [...flat(60, 1.8), ...flat(60, 2.6)]);
    const rows = buildRiskRows(inputs({ baa }));
    expect(rows[60]!.baa).toBe(2.6);
    expect(rows[60]!.lit.credit).toBe(false);
    expect(rows[61]!.lit.credit).toBe(true);
  });
  it('VIX ÷ VIX3M > 1 亮燈', () => {
    const vix = daily(START, [...flat(119, 15), 30]);
    const rows = buildRiskRows(inputs({ vix }));
    expect(rows.at(-2)!.lit.vol).toBe(false);
    expect(rows.at(-1)!.volRatio).toBeCloseTo(30 / 18);
    expect(rows.at(-1)!.lit.vol).toBe(true);
  });
  it('廣度背離：指數創 60 日高且 RSP÷SPY 創 60 日低', () => {
    const n = 120;
    const up = Array.from({ length: n }, (_, i) => 100 + i);
    // 指數一路創高、等權重不動 → 比值一路創低
    const rows = buildRiskRows(inputs({ spx: daily(START, up), spy: daily(START, up) }, n));
    expect(rows[58]!.lit.breadth).toBeNull();
    expect(rows.at(-1)!.spxHigh).toBe(true);
    expect(rows.at(-1)!.breadthLow).toBe(true);
    expect(rows.at(-1)!.lit.breadth).toBe(true);
    // 等權重同步漲 → 比值持平（最新一根並列最低）但要看指數：兩邊都創高時，比值不是「往下」
    const both = buildRiskRows(inputs({ spx: daily(START, up), spy: daily(START, up), rsp: daily(START, up.map((v) => v * 0.6)) }, n));
    expect(both.at(-1)!.breadth).toBeCloseTo(60);
  });
  it('目前讀數：有高收益債利差就用它，沒有才退回 Baa−10Y', () => {
    const rows = buildRiskRows(inputs({ hy: daily(START, [...flat(100, 3), ...flat(20, 5.2)]) }));
    const sig = riskSignals(rows.at(-1));
    expect(sig[0]!.lit).toBe(true);
    expect(sig[0]!.level).toBe('warn');
    expect(sig[0]!.detail).toContain('5.20%');
    const noHy = riskSignals(buildRiskRows(inputs({ hy: [] })).at(-1));
    expect(noHy[0]!.detail).toContain('Baa−10Y');
    expect(noHy[0]!.lit).toBe(false);
  });
  it('亮燈數 → 正常／留意／警戒；資料不足不算', () => {
    const sig = riskSignals(buildRiskRows(inputs({ vix3m: [] })).at(-1));
    expect(sig.find((s) => s.key === 'vol')!.lit).toBeNull();
    expect(riskVerdict(sig)).toEqual({ verdict: 'calm', on: 0, known: 3 });
    const mk = (lit: (boolean | null)[]) => lit.map((l, i) => ({ key: (['credit', 'vol', 'breadth', 'liq'] as const)[i]!, label: '', lit: l, level: null, detail: '' }));
    expect(riskVerdict(mk([true, false, false, false])).verdict).toBe('watch');
    expect(riskVerdict(mk([true, true, false, null])).verdict).toBe('alert');
  });
});

describe('回測', () => {
  const mkRow = (i: number, spx: number, vol: boolean): RiskRow => ({
    date: addDays('2017-01-01', i),
    spx,
    hy: null,
    hyChg20: null,
    baa: null,
    baaChg20: null,
    vix: null,
    vix3m: null,
    volRatio: null,
    breadth: null,
    spxHigh: false,
    breadthLow: false,
    netLiq: null,
    liqChg4w: null,
    liqDate: null,
    lit: { credit: false, vol, breadth: false, liq: false },
    count: vol ? 1 : 0,
  });

  it('亮燈日之後的報酬、波數（間隔 ≤ 20 日算同一波）', () => {
    // 前 300 天平盤 100，之後每天 +1；第 10～14、20～24（同一波）、200～204（第二波）亮燈
    const rows = Array.from({ length: 700 }, (_, i) => mkRow(i, i < 300 ? 100 : 100 + (i - 300), (i >= 10 && i < 15) || (i >= 20 && i < 25) || (i >= 200 && i < 205)));
    const bt = backtestRisk(rows)!;
    const vol = bt.signals.find((s) => s.key === 'vol')!;
    expect(vol.on.full.days).toBe(15);
    expect(vol.on.full.episodes).toBe(2);
    expect(vol.on.full.avg60).toBeCloseTo(0);
    expect(vol.on.full.win60).toBe(0);
    expect(bt.all.full.avg60).toBeGreaterThan(0);
    expect(vol.edge.full).toBeLessThan(0);
    // 只有 2 波 → 樣本太少，不下判定
    expect(vol.verdict).toBe('few');
    expect(bt.count.find((c) => c.key === 'c1')!.b.full.days).toBe(15);
    expect(bt.signals.find((s) => s.key === 'credit')!.on.full.days).toBe(0);
  });

  it('資料太短不回測', () => {
    expect(backtestRisk(Array.from({ length: 100 }, (_, i) => mkRow(i, 100, false)))).toBeNull();
  });

  it('加權：美股日期的下一個台股交易日進場', () => {
    const tw = daily('2020-01-01', Array.from({ length: 80 }, (_, i) => 100 + i));
    const out = taiexForward(['2020-01-01', '2020-03-01'], tw, 60);
    // 進場 01-02（101），60 日後 161
    expect(out[0]).toBeCloseTo((161 / 101 - 1) * 100);
    expect(out[1]).toBeNull();
  });
});
