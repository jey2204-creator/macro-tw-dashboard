import { describe, expect, it } from 'vitest';
import { getIndicator } from '../src/shared/indicators';
import { describeRule, evaluateSignal, isStale, recentDirection, sahmValue } from '../src/shared/signals';
import { transformPoints } from '../src/shared/timeseries';
import { dailySeries, linear, monthlySeries } from './helpers';

describe('trend（股價指數）', () => {
  const sox = getIndicator('sox');
  it('長期上漲 → 偏多，依據列出三項檢查', () => {
    const r = evaluateSignal(sox, dailySeries('2025-01-01', linear(300, 100, 1)));
    expect(r.signal).toBe('bull');
    expect(r.reason).toContain('收盤>MA60✓');
    expect(r.reason).toContain('MA60上揚✓');
    expect(r.reason).toContain('收盤>MA240✓');
  });
  it('長期下跌 → 偏空', () => {
    expect(evaluateSignal(sox, dailySeries('2025-01-01', linear(300, 400, -1))).signal).toBe('bear');
  });
  it('長多短空（跌破 MA60、但 MA60 上揚且在 MA240 上）→ 中性：三項需全部一致才判多空', () => {
    const v = [...linear(280, 100, 1), ...linear(20, 370, -3)];
    const r = evaluateSignal(sox, dailySeries('2025-01-01', v));
    expect(r.reason).toContain('收盤<MA60✗');
    expect(r.reason).toContain('MA60上揚✓');
    expect(r.signal).toBe('neutral');
  });
  it('資料少於 80 筆 → 資料不足', () => {
    expect(evaluateSignal(sox, dailySeries('2025-01-01', linear(50, 1, 1))).reason).toContain('資料不足');
  });
});

describe('risingIsBearish', () => {
  it('10Y 20 日上升 30bp → 偏空，以 bp 顯示', () => {
    const def = getIndicator('us10y');
    const r = evaluateSignal(def, dailySeries('2026-01-01', linear(30, 4.0, 0.015)));
    expect(r.signal).toBe('bear');
    expect(r.reason).toContain('+30bp');
  });
  it('10Y 20 日下降 25bp → 偏多', () => {
    const def = getIndicator('us10y');
    expect(evaluateSignal(def, dailySeries('2026-01-01', linear(30, 5.0, -0.0125))).signal).toBe('bull');
  });
  it('USD/TWD 20 日 +2%（台幣貶值）→ 偏空', () => {
    const def = getIndicator('usdtwd');
    const v = [...linear(10, 30, 0), ...linear(21, 30, 0.03)];
    expect(evaluateSignal(def, dailySeries('2026-01-01', v)).signal).toBe('bear');
  });
  it('油價大跌不判偏多（bullAt=null）', () => {
    const def = getIndicator('wti');
    expect(evaluateSignal(def, dailySeries('2026-01-01', linear(30, 100, -1.5))).signal).toBe('neutral');
  });
});

describe('其他規則', () => {
  it('利差倒掛 → 偏空', () => {
    const def = getIndicator('spread');
    expect(evaluateSignal(def, dailySeries('2026-01-01', [0.1, -0.05])).signal).toBe('bear');
    expect(evaluateSignal(def, dailySeries('2026-01-01', [0.1, 0.4])).signal).toBe('neutral');
  });
  it('Fed 120 天內降息 → 偏多；升息 → 偏空；不變 → 中性', () => {
    const def = getIndicator('fed');
    const cut = dailySeries('2026-01-01', [...Array(100).fill(4.25), ...Array(100).fill(4.0)]);
    expect(evaluateSignal(def, cut).signal).toBe('bull');
    expect(evaluateSignal(def, cut).reason).toContain('降息 25bp');
    const hike = dailySeries('2026-01-01', [...Array(100).fill(4.0), ...Array(100).fill(4.5)]);
    expect(evaluateSignal(def, hike).signal).toBe('bear');
    const flat = dailySeries('2026-01-01', Array(200).fill(4.0));
    expect(evaluateSignal(def, flat).signal).toBe('neutral');
  });
  it('核心 CPI 年增率 3 個月下降 ≥0.2pp → 偏多', () => {
    const def = getIndicator('core_cpi');
    // 前 12 個月指數 100，後續年增率由 3.5% 降至 3.0%
    const idx = [...Array(12).fill(100), 103.5, 103.4, 103.2, 103.0];
    const pts = transformPoints(def, monthlySeries(2025, idx));
    const r = evaluateSignal(def, pts);
    expect(r.signal).toBe('bull');
    expect(r.reason).toContain('-0.5pp');
  });
  it('Sahm 值計算', () => {
    const flat = monthlySeries(2025, Array(16).fill(4.0));
    expect(sahmValue(flat)).toBeCloseTo(0, 6);
    const rising = monthlySeries(2025, [...Array(13).fill(4.0), 4.6, 4.7, 4.8]);
    expect(sahmValue(rising)!).toBeCloseTo(0.7, 6);
    expect(evaluateSignal(getIndicator('unrate'), rising).signal).toBe('bear');
    // 失業率為落後指標：只判中性或偏空
    expect(evaluateSignal(getIndicator('unrate'), flat).signal).toBe('neutral');
  });
  it('非農 3 個月平均', () => {
    const def = getIndicator('nfp');
    const levels = monthlySeries(2026, [1000, 1150, 1300, 1450]);
    const pts = transformPoints(def, levels);
    const r = evaluateSignal(def, pts);
    expect(r.signal).toBe('neutral'); // 非農不判偏多
    expect(r.reason).toContain('+150k');
    const weak = transformPoints(def, monthlySeries(2026, [1000, 990, 985, 980]));
    expect(evaluateSignal(def, weak).signal).toBe('bear');
  });
  it('GDP 成長率門檻與季度標籤', () => {
    const def = getIndicator('gdpnow');
    const r = evaluateSignal(def, [['2026-07-01', 3.68]]);
    expect(r.signal).toBe('bull');
    expect(r.reason).toContain('2026Q3');
    expect(evaluateSignal(def, [['2026-07-01', -0.5]]).signal).toBe('bear');
    expect(evaluateSignal(def, [['2026-07-01', 1.2]]).signal).toBe('neutral');
  });
  it('無資料 → 中性且標示資料不足', () => {
    const r = evaluateSignal(getIndicator('cpi'), []);
    expect(r.signal).toBe('neutral');
    expect(r.reason).toContain('資料不足');
  });
});

describe('輔助', () => {
  it('isStale', () => {
    expect(isStale({ maxAgeDays: 5 }, '2026-10-01', '2026-10-06')).toBe(false);
    expect(isStale({ maxAgeDays: 5 }, '2026-09-30', '2026-10-06')).toBe(true);
    expect(isStale({ maxAgeDays: 5 }, null, '2026-10-06')).toBe(true);
  });
  it('recentDirection', () => {
    const d = recentDirection(getIndicator('us10y'), dailySeries('2026-01-01', linear(30, 4, 0.01)));
    expect(d.dir).toBe('up');
    expect(d.text).toBe('20日 +20bp');
    const p = recentDirection(getIndicator('sox'), dailySeries('2026-01-01', linear(30, 100, 0)));
    expect(p.dir).toBe('flat');
  });
  it('規則參數可重新開啟偏多判斷（向後相容）', () => {
    const def = { ...getIndicator('nfp'), rule: { kind: 'payrolls' as const, bullAt: 100, bearAt: 0 } };
    const pts = transformPoints(def, monthlySeries(2026, [1000, 1150, 1300, 1450]));
    expect(evaluateSignal(def, pts).signal).toBe('bull');
    expect(describeRule(def.rule)).toContain('≥ 100k 偏多');
    expect(describeRule(getIndicator('nfp').rule)).not.toContain('偏多');
  });
  it('每條規則都有可讀說明', () => {
    for (const id of ['sox', 'us10y', 'spread', 'fed', 'cpi', 'unrate', 'nfp', 'gdp']) {
      const def = getIndicator(id);
      expect(describeRule(def.rule, def).length).toBeGreaterThan(5);
    }
  });
});
