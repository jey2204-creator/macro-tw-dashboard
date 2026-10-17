// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SeriesFile } from '../src/shared/types';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄序列配置
const chartLog = { series: [] as { pane: number; title?: string }[], watermarks: [] as string[], priceLines: [] as string[] };
vi.mock('lightweight-charts', () => {
  const makeChart = () => {
    const panes = new Map<number, { setStretchFactor: () => void }>();
    return {
      addSeries: (_type: unknown, opts: { title?: string }, paneIndex = 0) => {
        chartLog.series.push({ pane: paneIndex, title: opts.title });
        if (!panes.has(paneIndex)) panes.set(paneIndex, { setStretchFactor: () => {} });
        return { setData: () => {}, createPriceLine: (o: { title: string }) => chartLog.priceLines.push(o.title) };
      },
      panes: () => [...panes.keys()].sort((a, b) => a - b).map((k) => panes.get(k)!),
      priceScale: () => ({ applyOptions: () => {} }),
      timeScale: () => ({ fitContent: () => {}, setVisibleRange: () => {}, setVisibleLogicalRange: () => {}, applyOptions: () => {}, subscribeVisibleLogicalRangeChange: () => {}, getVisibleRange: () => null, timeToCoordinate: () => null }),
      subscribeCrosshairMove: () => {},
      unsubscribeCrosshairMove: () => {},
      applyOptions: () => {},
      remove: () => {},
    };
  };
  return {
    createChart: () => makeChart(),
    createTextWatermark: (_pane: unknown, opts: { lines: { text: string }[] }) => {
      chartLog.watermarks.push(opts.lines[0]!.text);
      return { detach: () => {} };
    },
    LineSeries: 'Line',
    BaselineSeries: 'Baseline',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2 },
    LineType: { WithSteps: 1 },
  };
});

const { PolicyInflationPanel } = await import('../src/components/PolicyInflationPanel');

function series(id: string, bars: Bar[]): SeriesFile {
  return {
    id,
    source: { provider: 'fred', symbol: id, url: '' },
    status: 'ok',
    fetchedAt: '2026-10-16T00:00:00Z',
    lastSuccessAt: '2026-10-16T00:00:00Z',
    lastDate: bars.at(-1)?.[0] ?? null,
    closeOnly: true,
    partial: false,
    errors: [],
    data: bars,
  };
}
const flat = (d: string, c: number): Bar => [d, c, c, c, c];
const months = (from: number, n: number, f: (i: number) => number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const y = 2024 + Math.floor((from + i) / 12);
    const m = ((from + i) % 12) + 1;
    return flat(`${y}-${String(m).padStart(2, '0')}-01`, f(i));
  });
// 2024-01 起 21 個月指數：年增固定 3%（核心）、4%（整體）、2.8%（核心 PCE）
const FILES: Record<string, SeriesFile> = {
  fed: series('fed', [flat('2025-01-02', 4.5), flat('2025-09-18', 4.25), flat('2025-10-15', 4.1)]),
  fed_target_legacy: series('fed_target_legacy', [flat('2008-12-15', 1)]),
  core_cpi: series('core_cpi', months(0, 21, (i) => 100 * 1.03 ** (i / 12))),
  cpi: series('cpi', months(0, 21, (i) => 100 * 1.04 ** (i / 12))),
  core_pce: series('core_pce', months(0, 21, (i) => 100 * 1.028 ** (i / 12))),
};

beforeEach(() => {
  chartLog.series = [];
  chartLog.watermarks = [];
  chartLog.priceLines = [];
  window.localStorage.clear();
  vi.stubGlobal('fetch', (url: string) => {
    const id = /series\/([a-z0-9_]+)\.json/.exec(url)?.[1] ?? '';
    const f = FILES[id];
    return Promise.resolve(f ? new Response(JSON.stringify(f), { status: 200 }) : new Response('not found', { status: 404 }));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('政策利率 vs 通膨面板', () => {
  it('預設 Fed＋核心CPI＋整體CPI 在上窗格、實質利率在下窗格，讀數以最新 Fed 對最新核心 CPI', async () => {
    render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelector('.pi-state')).toBeTruthy());
    // 最新 Fed 4.10（2025-10-15）− 核心 CPI 3.0（2025-09）= +1.10pp → 緊縮
    const state = document.querySelector('.pi-state')!.textContent ?? '';
    expect(state).toMatch(/\+1\.10pp（Fed 4\.10% − 核心CPI 3\.0%）→ 緊縮（≥ \+1pp）/);
    expect(state).toMatch(/距 2% 目標 \+1\.00pp/);
    await waitFor(() => expect(chartLog.watermarks).toEqual(['Fed 利率 vs 通膨年增（%）', '實質政策利率＝Fed − 核心CPI（pp）']));
    expect(chartLog.series).toEqual([
      { pane: 0, title: 'Fed' },
      { pane: 0, title: '核心CPI' },
      { pane: 0, title: 'CPI' },
      { pane: 1, title: '實質' },
    ]);
    expect(chartLog.priceLines).toEqual(['Fed 目標 2%', '0 中性', '+1 緊縮']);
    expect(screen.getByRole('button', { name: '整體 CPI' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '核心 PCE' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('切換核心 PCE 會加序列並記住；區間預設 5 年', async () => {
    render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.series.length).toBe(4));
    fireEvent.click(screen.getByRole('button', { name: '核心 PCE' }));
    await waitFor(() => expect(chartLog.series.some((s) => s.title === '核心PCE')).toBe(true));
    expect(window.localStorage.getItem('pi-pce')).toBe('1');
    expect(screen.getByRole('button', { name: '5年' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(window.localStorage.getItem('pi-range')).toBe('ALL');
  });
});
