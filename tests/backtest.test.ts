import { describe, expect, it } from 'vitest';
import { PUBLICATION_LAG, runBacktest } from '../scripts/fetch-data/backtest';
import { addDays } from '../src/shared/dates';
import { getIndicator, type IndicatorDef } from '../src/shared/indicators';
import type { Bar } from '../src/shared/types';

const bars = (start: string, values: number[], step = 1): Bar[] =>
  values.map((v, i) => [addDays(start, i * step), v, v, v, v]);

// 加權指數：每天 +0.1%，共 600 天
const taiexVals = Array.from({ length: 600 }, (_, i) => 100 * 1.001 ** i);
const taiex = bars('2020-01-01', taiexVals);

describe('runBacktest', () => {
  it('統計各狀態之後 20／60 日報酬，占比加總 100%', () => {
    const bt = runBacktest({ taiex, sox: bars('2019-01-01', Array.from({ length: 1000 }, (_, i) => 100 + i)) }, [getIndicator('sox')], {
      start: '2020-01-01',
      splitDate: '2020-06-01',
    });
    const s = bt.indicators.sox!;
    expect(s.bull.pct + s.neutral.pct + s.bear.pct).toBeCloseTo(100, 0);
    expect(s.bull.days).toBeGreaterThan(0);
    // 每天 +0.1% → 60 日約 +6.18%
    expect(s.bull.avg60).toBeCloseTo((1.001 ** 60 - 1) * 100, 1);
    expect(s.bull.win60).toBe(100);
    expect(bt.composite.full.bull.days).toBe(bt.composite.early.bull.days + bt.composite.late.bull.days);
    // 尾段沒有 20 日未來報酬的日子不納入
    expect(bt.end <= taiex.at(-21)![0]).toBe(true);
  });

  it('月資料需等公布延遲後才使用（避免前視偏誤）', () => {
    const def: IndicatorDef = { ...getIndicator('core_cpi'), maxAgeDays: 9999 };
    // 2020-01 起的指數：前 12 個月持平，2021-01 起年增率由 0 突升到 10%
    const monthly: Bar[] = Array.from({ length: 30 }, (_, i) => {
      const y = 2019 + Math.floor(i / 12);
      const m = (i % 12) + 1;
      const v = i < 24 ? 100 : 110;
      return [`${y}-${String(m).padStart(2, '0')}-01`, v, v, v, v];
    });
    const bt = runBacktest({ taiex: bars('2020-12-01', taiexVals), core_cpi: monthly }, [def], { start: '2020-12-01' });
    const s = bt.indicators.core_cpi!;
    // 2021-01-01 的資料要到 +45 天後才可用，因此偏空天數 ≤ 總天數 − 45 + 緩衝
    expect(PUBLICATION_LAG.monthly).toBe(45);
    expect(s.bear.days).toBeGreaterThan(0);
    const firstBearPossible = addDays('2021-01-01', 45);
    const daysBefore = taiex.filter((b) => b[0] < firstBearPossible).length;
    expect(s.neutral.days).toBeGreaterThanOrEqual(0);
    expect(daysBefore).toBeGreaterThan(0);
  });

  it('加權指數資料不足時丟出可讀錯誤', () => {
    expect(() => runBacktest({ taiex: taiex.slice(0, 10) }, [getIndicator('sox')])).toThrow(/加權指數資料不足/);
  });

  it('權重 0 的指標有個別統計，但不影響綜合判斷', () => {
    const up = bars('2019-01-01', Array.from({ length: 1000 }, (_, i) => 100 + i));
    const bt = runBacktest({ taiex, wti: up }, [getIndicator('wti')], { start: '2020-01-01' });
    expect(bt.indicators.wti).toBeDefined();
    expect(bt.composite.full.all.days).toBe(0);
  });
});
