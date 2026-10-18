// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeForeignChips, type ForeignRow } from '../src/shared/foreignChips';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄序列配置
const chartLog = { series: [] as { pane: number; type: string; label: boolean; scale?: string }[], markers: [] as string[], stretch: [] as number[] };
vi.mock('lightweight-charts', () => {
  const makeChart = () => {
    const panes = new Map<number, { setStretchFactor: (f: number) => void }>();
    return {
      addSeries: (type: string, opts: { lastValueVisible?: boolean; priceScaleId?: string }, paneIndex = 0) => {
        chartLog.series.push({ pane: paneIndex, type, label: opts.lastValueVisible !== false, scale: opts.priceScaleId });
        if (!panes.has(paneIndex)) panes.set(paneIndex, { setStretchFactor: (f) => chartLog.stretch.push(f) });
        return { setData: () => {}, priceScale: () => ({ applyOptions: () => {} }) };
      },
      removeSeries: () => {},
      panes: () => [...panes.keys()].sort((a, b) => a - b).map((k) => panes.get(k)!),
      priceScale: () => ({ applyOptions: () => {} }),
      timeScale: () => ({ setVisibleLogicalRange: () => {}, applyOptions: () => {}, subscribeVisibleLogicalRangeChange: () => {}, getVisibleRange: () => null, timeToCoordinate: () => null }),
      subscribeCrosshairMove: () => {},
      unsubscribeCrosshairMove: () => {},
      applyOptions: () => {},
      remove: () => {},
    };
  };
  return {
    createChart: () => makeChart(),
    createSeriesMarkers: (_s: unknown, markers: { text?: string; size?: number }[]) => {
      chartLog.markers.push(...markers.map((m) => m.text ?? (m.size ? '(小點)' : '(點)')));
      return { setMarkers: () => {} };
    },
    LineSeries: 'Line',
    HistogramSeries: 'Histogram',
    BaselineSeries: 'Baseline',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2 },
  };
});

const { ForeignChipsPanel } = await import('../src/components/ForeignChipsPanel');

const day = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
// 200 天：外資期 OI 持續創低、散戶持續創高 → 最新為「外資期空單極端、散戶小台偏多極端」
const rows: ForeignRow[] = Array.from({ length: 200 }, (_, i) => [day(i), 20000 + i, -10, -50, -200, -50000 - i * 100, -100, 5000 + i * 10, 10]);
const data = analyzeForeignChips(rows, new Date('2026-10-17T00:00:00Z'));

beforeEach(() => {
  chartLog.series = [];
  chartLog.markers = [];
  chartLog.stretch = [];
});
afterEach(() => cleanup());

describe('外資籌碼對照面板', () => {
  it('四個窗格：加權／買賣超＋5日＋20日／外資期＋增減／散戶小台＋增減；每格只留一個最新值標籤、不畫序列標題', () => {
    render(<ForeignChipsPanel data={data} themeKey="auto-false-tw" />);
    expect(chartLog.series).toEqual([
      { pane: 0, type: 'Line', label: true, scale: undefined },
      { pane: 1, type: 'Histogram', label: false, scale: 'net' },
      { pane: 1, type: 'Line', label: false, scale: undefined },
      { pane: 1, type: 'Line', label: true, scale: undefined },
      { pane: 2, type: 'Baseline', label: true, scale: undefined },
      { pane: 2, type: 'Histogram', label: false, scale: 'chg-2' },
      { pane: 3, type: 'Baseline', label: true, scale: undefined },
      { pane: 3, type: 'Histogram', label: false, scale: 'chg-3' },
    ]);
    expect(chartLog.stretch.slice(0, 4)).toEqual([0.34, 0.22, 0.22, 0.22]);
    // 事件相鄰 ≤ 6 根只有第一個帶字；再創極端小點不帶字
    expect(chartLog.markers).toEqual(['OI空／散戶多', '(小點)']); // 同日事件合併一點；再創極端小點不帶字
    const verdict = document.querySelector('.fc .verdict')!.textContent;
    expect(verdict).toBe('極端 2');
    expect(document.querySelector('.fc .score')!.textContent).toContain('外資期空單極端、散戶小台偏多極端');
    const score = document.querySelector('.fc .score')!.textContent ?? '';
    expect(score).toContain('外資期淨OI -69,900 口（第 0 百分位）');
    expect(score).toContain('散戶小台 +6,990 口（第 100 百分位）');
    expect(screen.getByRole('button', { name: '3個月' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('展開歷次事件顯示口數與億元單位', () => {
    render(<ForeignChipsPanel data={data} themeKey="auto-false-tw" />);
    fireEvent.click(screen.getByRole('button', { name: /展開歷次事件/ }));
    const cells = [...document.querySelectorAll('.fc table')].at(-1)!.textContent ?? '';
    expect(cells).toContain('口');
    expect(cells).toContain('外資期空單極端');
  });

  it('沒有資料時不渲染', () => {
    const { container } = render(<ForeignChipsPanel data={null} themeKey="x" />);
    expect(container.innerHTML).toBe('');
  });
});
