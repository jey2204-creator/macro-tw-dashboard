// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeBreadth, type BreadthRow } from '../src/shared/breadthStress';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄中格序列的資料
const chartLog = { series: [] as { pane: number; label: boolean; values: number[] }[], baseLabels: [] as string[] };
vi.mock('lightweight-charts', () => {
  const makeChart = () => ({
    addSeries: (_type: string, opts: { lastValueVisible?: boolean }, paneIndex = 0) => {
      const s = { pane: paneIndex, label: opts.lastValueVisible !== false, values: [] as number[] };
      chartLog.series.push(s);
      return {
        setData: (d: { value: number }[]) => {
          s.values = d.map((x) => x.value);
        },
        createPriceLine: () => {},
        attachPrimitive: (p: { label?: { text: string } }) => {
          if (p.label) chartLog.baseLabels.push(p.label.text);
        },
        priceScale: () => ({ applyOptions: () => {} }),
      };
    },
    removeSeries: () => {},
    panes: () => [{ setStretchFactor: () => {} }, { setStretchFactor: () => {} }, { setStretchFactor: () => {} }],
    priceScale: () => ({ applyOptions: () => {} }),
    timeScale: () => ({ getVisibleRange: () => null, setVisibleLogicalRange: () => {}, width: () => 0, applyOptions: () => {}, subscribeVisibleLogicalRangeChange: () => {}, unsubscribeVisibleLogicalRangeChange: () => {}, subscribeVisibleTimeRangeChange: () => {}, unsubscribeVisibleTimeRangeChange: () => {} }),
    subscribeCrosshairMove: () => {},
    unsubscribeCrosshairMove: () => {},
    applyOptions: () => {},
    remove: () => {},
  });
  return {
    createChart: () => makeChart(),
    createSeriesMarkers: () => {},
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2 },
    HistogramSeries: 'Histogram',
    LineSeries: 'Line',
  };
});
vi.mock('../src/lib/chartInteraction', () => ({
  CHART_INTERACTION: {},
  TIME_AXIS: {},
  attachTimeAxis: () => {},
  resetPaneStretch: () => {},
  resetPriceScales: () => {},
}));

import { BreadthPanel } from '../src/components/BreadthPanel';
import { placeBaseLabel } from '../src/lib/baseLabel';
import { baseDateLabel, sharedPctRange, timeToDate } from '../src/lib/breadthPct';

const rows: BreadthRow[] = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 5 + i));
  return [d.toISOString().slice(0, 10), 20000 - i * 10, 3 + (i % 2), 10 + i, 300, 500 + i, null];
});
const data = analyzeBreadth(rows, new Date('2026-02-20T00:00:00Z'));

beforeEach(() => {
  chartLog.series = [];
  chartLog.baseLabels = [];
});
afterEach(cleanup);

describe('BreadthPanel（上市＋上櫃同一模組）', () => {
  it('上市：讀數列顯示漲停／跌停與漲／跌家數，中格預設畫漲跌停', () => {
    render(<BreadthPanel twse={data} themeKey="light" />);
    expect(screen.getByText('漲跌停家數監測（上市＋上櫃，參考）')).toBeTruthy();
    expect(screen.getAllByText(/漲 300/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/跌 529/).length).toBeGreaterThan(0);
    const mid = chartLog.series.filter((s) => s.pane === 1);
    expect(mid).toHaveLength(2);
    expect(mid[0]!.values.at(-1)).toBe(4); // 漲停
    expect(mid[1]!.values.at(-1)).toBe(-39); // 跌停（0 以下）
    expect(mid.every((s) => s.label)).toBe(true); // 漲停／跌停柱各標右軸現值（世杰 11/08 要求）
    // 只有上市資料：一張圖、一張回測表
    expect(screen.getAllByText(/事件發生後/)).toHaveLength(1);
  });

  it('兩市都有：兩張圖共用一組區間與切換鈕，切到「漲跌家數」兩張圖一起換', () => {
    render(<BreadthPanel twse={data} otc={data} themeKey="light" />);
    expect(screen.getAllByText(/事件發生後加權指數表現/)).toHaveLength(1);
    expect(screen.getAllByText(/事件發生後櫃買指數表現/)).toHaveLength(1);
    expect(screen.getAllByRole('group', { name: '時間區間' })).toHaveLength(1);
    expect(screen.getByText('上市')).toBeTruthy();
    expect(screen.getByText('上櫃')).toBeTruthy();
    chartLog.series = [];
    fireEvent.click(screen.getByRole('button', { name: '漲跌家數' }));
    const mid = chartLog.series.filter((s) => s.pane === 1);
    expect(mid).toHaveLength(4);
    expect(mid.map((s) => s.values.at(-1))).toEqual([300, -529, 300, -529]);
    expect(mid.every((s) => s.label)).toBe(true);
    // 圖例已收進 ⓘ 說明，兩張圖共用一段
    expect(screen.getAllByText(/上漲家數（0 以上）/)).toHaveLength(1);
  });

  it('兩市的歷次事件各自展開', () => {
    render(<BreadthPanel twse={data} otc={data} themeKey="light" />);
    fireEvent.click(screen.getByRole('button', { name: /展開上櫃歷次事件/ }));
    expect(screen.getByRole('button', { name: /收起上櫃歷次事件/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /展開上市歷次事件/ })).toBeTruthy();
  });

  it('沒有資料時不渲染', () => {
    const { container } = render(<BreadthPanel twse={null} otc={null} themeKey="light" />);
    expect(container.innerHTML).toBe('');
  });

  it('百分比 Y 軸：預設取區間起點到最新；往左拖曳時改取畫面內兩市高低點聯集（基準不變）', () => {
    // 上市：100 → 75 → 125（區間 ALL，基準＝第一根 100）；上櫃：100 → 50 → 150
    const mk = (closes: number[]) => ({ rows: closes.map((c, i) => [`2026-01-${String(i + 1).padStart(2, '0')}`, c]) }) as unknown as typeof data;
    const a = mk([100, 75, 125]);
    const b = mk([100, 50, 150]);
    expect(sharedPctRange([a], 'ALL')).toBeNull(); // 只有一個市場：照常自動縮放
    expect(sharedPctRange([a, b], 'ALL')).toEqual({ min: -50, max: 50 });
    // 畫面只剩前兩根：不再被第三根的 +50% 撐開
    expect(sharedPctRange([a, b], 'ALL', { from: '2026-01-01', to: '2026-01-02' })).toEqual({ min: -50, max: 0 });
    // 畫面只剩最後一根：兩市 +25%／+50%，0% 線可以在畫面外
    expect(sharedPctRange([a, b], 'ALL', { from: '2026-01-03', to: '2026-01-03' })).toEqual({ min: 25, max: 50 });
    // 畫面內沒有 K 棒：交還自動縮放
    expect(sharedPctRange([a, b], 'ALL', { from: '2025-01-01', to: '2025-01-02' })).toBeNull();
    // 幾乎水平：至少留 1 個百分點
    const flat = mk([100, 100, 100]);
    expect(sharedPctRange([flat, flat], 'ALL', { from: '2026-01-01', to: '2026-01-03' })).toEqual({ min: -0.5, max: 0.5 });
  });

  it('timeToDate：字串／BusinessDay／秒數都轉成 YYYY-MM-DD', () => {
    expect(timeToDate('2026-11-16')).toBe('2026-11-16');
    expect(timeToDate({ year: 2026, month: 3, day: 5 })).toBe('2026-03-05');
    expect(timeToDate(Date.UTC(2026, 10, 16) / 1000)).toBe('2026-11-16');
    expect(timeToDate(null)).toBeNull();
  });

  it('基準點：圖上標「基準 日期 點位」，圖例寫「自 M/D 起」', () => {
    render(<BreadthPanel twse={data} themeKey="light" />);
    // 預設 3 個月，資料只有 30 天 → 基準＝第一根 2026-01-05 收 20,000
    expect(chartLog.baseLabels).toContain('基準 1/5 20,000');
    expect(screen.getAllByText(/自 1\/5 起 -1\.4%/).length).toBeGreaterThan(0);
    expect(baseDateLabel('2025-11-17', '2026-11-16')).toBe('2025/11/17');
    expect(baseDateLabel('2026-08-17', '2026-11-16')).toBe('8/17');
  });

  it('基準點文字位置：貼著圓點放，折線擋住就換邊，放不下回傳 null', () => {
    const size = { width: 300, height: 200 };
    // 沒有折線障礙：放在圓點正上方
    expect(placeBaseLabel(150, 100, 80, 14, size, () => null)).toEqual({ cx: 150, cy: 100 - 5 - 4 - 7 });
    // 圓點貼左緣：文字往內收，不被切掉
    expect(placeBaseLabel(0, 100, 80, 14, size, () => null)!.cx).toBeGreaterThanOrEqual(40);
    // 折線在圓點上方一路衝高（lo 很小）：改放下方
    const up = placeBaseLabel(150, 100, 80, 14, size, () => ({ lo: 10, hi: 100 }))!;
    expect(up.cy).toBeGreaterThan(100);
    // 上下都放不下
    expect(placeBaseLabel(150, 100, 80, 14, size, () => ({ lo: 2, hi: 198 }))).toBeNull();
  });
});
