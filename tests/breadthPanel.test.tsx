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
    timeScale: () => ({ setVisibleLogicalRange: () => {}, width: () => 0, applyOptions: () => {}, subscribeVisibleLogicalRangeChange: () => {}, unsubscribeVisibleLogicalRangeChange: () => {} }),
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

describe('BreadthPanel', () => {
  it('上市：標題列顯示漲停／跌停與漲／跌家數，中格預設畫漲跌停', () => {
    render(<BreadthPanel data={data} themeKey="light" />);
    expect(screen.getByText('漲跌停家數監測（上市股票，參考）')).toBeTruthy();
    expect(screen.getAllByText(/漲 300/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/跌 529/).length).toBeGreaterThan(0);
    const mid = chartLog.series.filter((s) => s.pane === 1);
    expect(mid).toHaveLength(2);
    expect(mid[0]!.values.at(-1)).toBe(4); // 漲停
    expect(mid[1]!.values.at(-1)).toBe(-39); // 跌停（0 以下）
    expect(mid.every((s) => !s.label)).toBe(true);
  });

  it('切到「漲跌家數」：中格改畫上漲／下跌家數並標右軸現值', () => {
    render(<BreadthPanel data={data} themeKey="light" />);
    chartLog.series = [];
    fireEvent.click(screen.getByRole('button', { name: '漲跌家數' }));
    const mid = chartLog.series.filter((s) => s.pane === 1);
    expect(mid[0]!.values.at(-1)).toBe(300);
    expect(mid[1]!.values.at(-1)).toBe(-529);
    expect(mid.every((s) => s.label)).toBe(true);
    expect(screen.getByText(/上漲家數（0 以上）/)).toBeTruthy();
  });

  it('上櫃：id、標題、指數名稱與說明換成櫃買', () => {
    const { container } = render(<BreadthPanel data={data} themeKey="light" market="tpex" />);
    expect(container.querySelector('#sec-bro')).toBeTruthy();
    expect(screen.getByText('上櫃漲跌停家數監測（上櫃股票，參考）')).toBeTruthy();
    expect(screen.getByText(/事件發生後櫃買指數表現/)).toBeTruthy();
    expect(screen.getByText(/上櫃沒有融資維持率可用/)).toBeTruthy();
    expect(screen.queryByText(/上市股票，參考/)).toBeNull();
  });

  it('沒有資料時不渲染', () => {
    const { container } = render(<BreadthPanel data={null} themeKey="light" market="tpex" />);
    expect(container.innerHTML).toBe('');
  });
});
