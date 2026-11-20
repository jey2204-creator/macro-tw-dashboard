// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeMarginStress, type StressRow } from '../src/shared/marginStress';

// lightweight-charts 需要 canvas，jsdom 沒有：記錄加權窗格的序列種類與事件文字的基準值
const chartLog = { series: [] as { pane: number; type: string }[], labelValues: [] as number[] };
vi.mock('lightweight-charts', () => {
  const makeChart = () => ({
    addSeries: (type: string, _opts: unknown, paneIndex = 0) => {
      chartLog.series.push({ pane: paneIndex, type });
      return {
        setData: () => {},
        createPriceLine: () => {},
        attachPrimitive: (p: { labels?: { value: number }[] }) => {
          if (paneIndex === 0 && Array.isArray(p.labels)) chartLog.labelValues.push(...p.labels.map((l) => l.value));
        },
        priceScale: () => ({ applyOptions: () => {} }),
      };
    },
    removeSeries: () => {},
    panes: () => [0, 1, 2, 3].map(() => ({ setStretchFactor: () => {}, priceScale: () => ({ applyOptions: () => {} }) })),
    priceScale: () => ({ applyOptions: () => {} }),
    timeScale: () => ({ setVisibleLogicalRange: () => {}, timeToIndex: () => null, width: () => 0, applyOptions: () => {}, subscribeVisibleLogicalRangeChange: () => {}, unsubscribeVisibleLogicalRangeChange: () => {} }),
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
    LineStyle: { Dashed: 2, Dotted: 1 },
    HistogramSeries: 'Histogram',
    LineSeries: 'Line',
    CandlestickSeries: 'Candlestick',
  };
});
vi.mock('../src/lib/chartInteraction', () => ({
  CHART_INTERACTION: {},
  TIME_AXIS: {},
  attachTimeAxis: () => {},
  resetPaneStretch: () => {},
  resetPriceScales: () => {},
}));

const { MarginStressPanel } = await import('../src/components/MarginStressPanel');

// 60 天：維持率一路掉到 150 以下 → 有「跌破 150」事件（標在 K 棒上方）
const rows: StressRow[] = Array.from({ length: 60 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);
  return [d, 20000 - i * 50, 175 - i * 0.6, 3000 - i * 5, -5];
});
const data = analyzeMarginStress(rows, rows[0]![0], new Date('2026-03-10T00:00:00Z'));
const ohl = rows.map((r) => [r[1] + 10, r[1] + 80, r[1] - 60] as [number, number, number]);

beforeEach(() => {
  chartLog.series = [];
  chartLog.labelValues = [];
  window.localStorage.removeItem('ms-style');
});
afterEach(cleanup);

describe('融資斷頭監測：K線開關', () => {
  it('有開高低時區間列多一顆「K線」：上格改畫 K 棒、讀數列多開高低、上方事件文字從最高價起算；5 年變灰', () => {
    expect(data.events.length).toBeGreaterThan(0);
    render(<MarginStressPanel data={{ ...data, ohl }} themeKey="light" />);
    expect(chartLog.series.find((s) => s.pane === 0)!.type).toBe('Line');
    chartLog.series = [];
    chartLog.labelValues = [];
    fireEvent.click(screen.getByRole('button', { name: 'K線' }));
    expect(chartLog.series.find((s) => s.pane === 0)!.type).toBe('Candlestick');
    const e = data.events.find((x) => x.type === 'below150')!;
    const k = rows.findIndex((r) => r[0] === e.date);
    expect(chartLog.labelValues).toContain(ohl[k]![1]); // 跌破 150 在上方 → 用最高價
    expect(document.querySelector('.legend')!.textContent).toContain('開 17,060 高 17,130 低 16,990');
    expect(window.localStorage.getItem('ms-style')).toBe('candle');
    fireEvent.click(screen.getByRole('button', { name: '5年' }));
    expect((screen.getByRole('button', { name: 'K線' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('沒有開高低時不顯示「K線」', () => {
    render(<MarginStressPanel data={data} themeKey="light" />);
    expect(screen.queryByRole('button', { name: 'K線' })).toBeNull();
    expect(screen.getByRole('button', { name: /重設/ }).textContent).toContain('重設');
  });
});
