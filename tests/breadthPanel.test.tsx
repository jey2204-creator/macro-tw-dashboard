// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeBreadth, type BreadthRow } from '../src/shared/breadthStress';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄中格序列的資料
const chartLog = { series: [] as { pane: number; label: boolean; values: number[] }[] };
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
        priceScale: () => ({ applyOptions: () => {} }),
      };
    },
    removeSeries: () => {},
    panes: () => [{ setStretchFactor: () => {} }, { setStretchFactor: () => {} }, { setStretchFactor: () => {} }],
    priceScale: () => ({ applyOptions: () => {} }),
    timeScale: () => ({ setVisibleLogicalRange: () => {}, width: () => 0, applyOptions: () => {}, subscribeVisibleLogicalRangeChange: () => {}, unsubscribeVisibleLogicalRangeChange: () => {}, subscribeVisibleTimeRangeChange: () => {}, unsubscribeVisibleTimeRangeChange: () => {} }),
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

const rows: BreadthRow[] = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 5 + i));
  return [d.toISOString().slice(0, 10), 20000 - i * 10, 3 + (i % 2), 10 + i, 300, 500 + i, null];
});
const data = analyzeBreadth(rows, new Date('2026-02-20T00:00:00Z'));

beforeEach(() => {
  chartLog.series = [];
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
    expect(mid.every((s) => !s.label)).toBe(true);
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
});
