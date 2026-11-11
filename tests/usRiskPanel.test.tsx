// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SeriesFile } from '../src/shared/types';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄序列配置
const chartLog = { series: [] as { pane: number; type: string }[], watermarks: [] as string[], priceLines: [] as number[], markers: 0 };
vi.mock('lightweight-charts', () => {
  const makeChart = () => {
    const panes = new Map<number, { setStretchFactor: () => void }>();
    return {
      addSeries: (type: string, _opts: unknown, paneIndex = 0) => {
        chartLog.series.push({ pane: paneIndex, type });
        if (!panes.has(paneIndex)) panes.set(paneIndex, { setStretchFactor: () => {} });
        return { setData: () => {}, createPriceLine: (o: { price: number }) => chartLog.priceLines.push(o.price), priceScale: () => ({ applyOptions: () => {} }) };
      },
      panes: () => [...panes.keys()].sort((a, b) => a - b).map((k) => panes.get(k)!),
      priceScale: () => ({ applyOptions: () => {} }),
      timeScale: () => ({ fitContent: () => {}, setVisibleRange: () => {}, applyOptions: () => {}, subscribeVisibleLogicalRangeChange: () => {}, getVisibleRange: () => null, timeToCoordinate: () => null }),
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
    createSeriesMarkers: (_s: unknown, markers: unknown[]) => {
      chartLog.markers += markers.length;
      return { setMarkers: () => {} };
    },
    LineSeries: 'Line',
    BaselineSeries: 'Baseline',
    HistogramSeries: 'Histogram',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2, Dotted: 1 },
  };
});

const { UsRiskPanel } = await import('../src/components/UsRiskPanel');

function series(id: string, bars: Bar[]): SeriesFile {
  return {
    id,
    source: { provider: 'yahoo', symbol: id, url: '' },
    status: 'ok',
    fetchedAt: '2026-11-06T00:00:00Z',
    lastSuccessAt: '2026-11-06T00:00:00Z',
    lastDate: bars.at(-1)?.[0] ?? null,
    closeOnly: true,
    partial: false,
    errors: [],
    data: bars,
  };
}
const flat = (d: string, c: number): Bar => [d, c, c, c, c];
const T0 = Date.UTC(2024, 0, 1);
const N = 600;
const day = (i: number) => new Date(T0 + i * 86_400_000).toISOString().slice(0, 10);
const days = (f: (i: number) => number): Bar[] => Array.from({ length: N }, (_, i) => flat(day(i), f(i)));
const weeks = (f: (k: number) => number): Bar[] => Array.from({ length: Math.floor(N / 7) }, (_, k) => flat(day(k * 7), f(k)));

// 最後一天：VIX 30 ÷ VIX3M 25＝1.20（逆價差）、高收益債利差 5.4%（警戒）→ 2 項亮燈
const FILES: Record<string, SeriesFile> = {
  spx: series('spx', days((i) => 5000 + i)),
  vix: series('vix', days((i) => (i === N - 1 ? 30 : 15))),
  vix3m: series('vix3m', days((i) => (i === N - 1 ? 25 : 18))),
  rsp: series('rsp', days(() => 180)),
  spy: series('spy', days(() => 600)),
  baa10y: series('baa10y', days(() => 1.6)),
  hy_oas: series('hy_oas', days((i) => (i >= N - 5 ? 5.4 : 3.1))),
  fed_assets: series('fed_assets', weeks(() => 6_600_000)),
  tga: series('tga', weeks(() => 900_000)),
  rrp: series('rrp', days(() => 100)),
  taiex: series('taiex', days((i) => 20000 + i * 10)),
};

beforeEach(() => {
  chartLog.series = [];
  chartLog.watermarks = [];
  chartLog.priceLines = [];
  chartLog.markers = 0;
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const stub = (files: Record<string, SeriesFile>) =>
  vi.stubGlobal('fetch', (url: string) => {
    const id = /series\/([a-z0-9_]+)\.json/.exec(url)?.[1] ?? '';
    const f = files[id];
    return Promise.resolve(f ? new Response(JSON.stringify(f), { status: 200 }) : new Response('not found', { status: 404 }));
  });

describe('美股風險溫度面板', () => {
  it('四個燈＋總結；兩項亮燈＝警戒', async () => {
    stub(FILES);
    render(<UsRiskPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(screen.getByLabelText('風險燈號').querySelectorAll('li').length).toBe(4));
    const items = [...screen.getByLabelText('風險燈號').querySelectorAll('li')].map((e) => e.textContent ?? '');
    expect(items[0]).toContain('高收益債利差 5.40%');
    expect(items[0]).toContain('≥ 5% 警戒');
    expect(items[1]).toContain('VIX ÷ VIX3M 1.20');
    expect(items[1]).toContain('逆價差');
    expect(items[2]).toContain('RSP ÷ SPY 30.0');
    expect(items[3]).toContain('5.60 兆美元');
    expect(document.querySelector('.cr-verdict')!.textContent).toContain('警戒');
    expect(document.querySelector('.cr-verdict')!.textContent).toContain('2／4 項亮燈');
  });

  it('下方窗格可切換並記住；信用畫兩條線與 5%、8% 兩條門檻線', async () => {
    stub(FILES);
    render(<UsRiskPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.watermarks.length).toBe(2));
    expect(chartLog.series).toEqual([
      { pane: 0, type: 'Line' },
      { pane: 1, type: 'Line' },
      { pane: 1, type: 'Line' },
    ]);
    expect(chartLog.priceLines).toEqual([5, 8]);
    chartLog.series = [];
    chartLog.priceLines = [];
    fireEvent.click(screen.getByRole('button', { name: '波動' }));
    await waitFor(() => expect(chartLog.series.some((s) => s.type === 'Baseline')).toBe(true));
    expect(chartLog.priceLines).toEqual([1, 0.85]);
    expect(window.localStorage.getItem('ur-mode')).toBe('vol');
    chartLog.series = [];
    fireEvent.click(screen.getByRole('button', { name: '流動性' }));
    await waitFor(() => expect(chartLog.series.some((s) => s.type === 'Histogram')).toBe(true));
  });

  it('缺資料的燈顯示資料不足，其他照常', async () => {
    const { vix3m: _v, rsp: _r, ...rest } = FILES;
    stub(rest);
    // 換一個版本：序列快取以 id@version 為鍵，沿用 v1 會拿到前面測試載過的資料
    render(<UsRiskPanel version="v2" themeKey="auto-false-tw" />);
    await waitFor(() => expect(screen.getByLabelText('風險燈號').querySelectorAll('li').length).toBe(4));
    const items = [...screen.getByLabelText('風險燈號').querySelectorAll('li')].map((e) => e.textContent ?? '');
    expect(items[1]).toContain('資料不足');
    expect(items[2]).toContain('資料不足');
    expect(items[0]).toContain('高收益債利差');
    expect(screen.getByText(/載入失敗：vix3m、rsp/)).toBeTruthy();
    expect(document.querySelector('.cr-verdict')!.textContent).toContain('1／2 項亮燈');
  });
});
