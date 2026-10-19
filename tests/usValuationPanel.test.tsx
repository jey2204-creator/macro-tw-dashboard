// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SeriesFile } from '../src/shared/types';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄序列配置
const chartLog = {
  series: [] as { pane: number; type: string; label: boolean; priceLine: boolean }[],
  watermarks: [] as string[],
  priceLines: [] as { price: number; axis: boolean }[],
  primitives: 0,
  scaleModes: [] as { pane: number; mode: number }[],
};
vi.mock('lightweight-charts', () => {
  const makeChart = () => {
    const panes = new Map<number, { setStretchFactor: () => void }>();
    return {
      addSeries: (type: string, opts: { lastValueVisible?: boolean; priceLineVisible?: boolean }, paneIndex = 0) => {
        chartLog.series.push({ pane: paneIndex, type, label: opts.lastValueVisible !== false, priceLine: opts.priceLineVisible !== false });
        if (!panes.has(paneIndex)) panes.set(paneIndex, { setStretchFactor: () => {} });
        return {
          setData: () => {},
          createPriceLine: (o: { price: number; axisLabelVisible?: boolean }) => chartLog.priceLines.push({ price: o.price, axis: o.axisLabelVisible !== false }),
          attachPrimitive: () => chartLog.primitives++,
        };
      },
      panes: () => [...panes.keys()].sort((a, b) => a - b).map((k) => panes.get(k)!),
      priceScale: (_side: string, pane = 0) => ({ applyOptions: (o: { mode?: number }) => { if (o.mode !== undefined) chartLog.scaleModes.push({ pane, mode: o.mode }); } }),
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
    PriceScaleMode: { Normal: 0, Logarithmic: 1 },
  };
});

const { UsValuationPanel } = await import('../src/components/UsValuationPanel');

function series(id: string, bars: Bar[]): SeriesFile {
  return {
    id,
    source: { provider: 'multpl', symbol: id, url: '' },
    status: 'ok',
    fetchedAt: '2026-10-19T00:00:00Z',
    lastSuccessAt: '2026-10-19T00:00:00Z',
    lastDate: bars.at(-1)?.[0] ?? null,
    closeOnly: true,
    partial: false,
    errors: [],
    data: bars,
  };
}
const flat = (d: string, c: number): Bar => [d, c, c, c, c];
const months = (fromYear: number, n: number, f: (i: number) => number): Bar[] =>
  Array.from({ length: n }, (_, i) => flat(`${fromYear + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`, f(i)));
// 2009-01 起 22 個月：本益比 20～30 循環、月均價 1000 起；最後一筆改成「今天」列 2010-10-16
const pe = months(2009, 22, (i) => 20 + (i % 11));
const priceM = months(2009, 22, (i) => 1000 + i * 50);
pe[21] = flat('2010-10-16', 26.12);
priceM[21] = flat('2010-10-16', 2050);
const epsLast = 2050 / 26.12;
const FILES: Record<string, SeriesFile> = {
  spx: series('spx', [flat('2010-10-14', 2000), flat('2010-10-15', 2020), flat('2010-10-16', 2050)]),
  spx_pe: series('spx_pe', pe),
  spx_price_m: series('spx_price_m', priceM),
  spx_cape: series('spx_cape', months(2009, 22, (i) => 20 + i)),
  us10y: series('us10y', [flat('2010-10-14', 5.3), flat('2010-10-15', 5.33)]),
};

beforeEach(() => {
  chartLog.series = [];
  chartLog.watermarks = [];
  chartLog.priceLines = [];
  chartLog.primitives = 0;
  chartLog.scaleModes = [];
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

describe('美股估值面板', () => {
  it('讀數：本益比、區間、基期百分位、河道位置、股債利差、CAPE', async () => {
    render(<UsValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelectorAll('.uv-state').length).toBe(2));
    const [l1, l2] = [...document.querySelectorAll('.uv-state')].map((e) => e.textContent ?? '');
    // 10/16 收 2050 ÷ EPS（2050÷26.12）＝ 26.1倍 → 偏高；2010 起 10 筆（21…29 與自己）→ 高於 6 筆、同值 1 筆算半 → 第 65 百分位
    expect(l1).toMatch(/本益比 26\.1倍（近12月 EPS \$78\.5，年增 /);
    expect(l1).toMatch(/→ 偏高｜2010 起第 65 百分位（中位數 25\.5倍）/);
    expect(l1).toMatch(/CAPE 41\.0倍（1881 起第 98 百分位）/);
    expect(l2).toMatch(/河道位置：23～27倍之間，距 27倍線 -3\.3%、距 23倍線 \+13\.6%/);
    // 盈餘殖利率 3.83% − 10Y 5.33%（10/15 的值，落後一天可用）＝ −1.50pp
    expect(l2).toMatch(/股債利差 -1\.50pp（盈餘殖利率 3\.83% − 10Y 5\.33%）→ 債券較划算/);
    expect(epsLast).toBeCloseTo(78.48, 2);
  });

  it('圖表：上窗格指數＋5 條倍數線（對數軸、色帶）、中窗格本益比（虛線中位數）、下窗格利差（0 線）；軸上不放標籤', async () => {
    render(<UsValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.watermarks.length).toBe(3));
    expect(chartLog.watermarks).toEqual([
      '河流圖｜近12月 EPS × 15／19／23／27／31倍（對數軸）',
      '本益比（倍）｜虛線 2010 起中位數 25.5',
      '股債利差（pp）＝盈餘殖利率 − 10Y｜0 以下債券較划算',
    ]);
    expect(chartLog.series.map((s) => `${s.pane}:${s.type}`)).toEqual([
      '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '1:Line', '2:Baseline',
    ]);
    expect(chartLog.series.every((s) => !s.label)).toBe(true);
    // 倍數線不畫最新值水平線（只有指數、本益比、利差三條保留）
    expect(chartLog.series.filter((s) => s.priceLine).length).toBe(3);
    expect(chartLog.primitives).toBe(1);
    // 對數軸只有上窗格；中、下窗格明確設回一般軸（圖表層級預設會被前一個呼叫改掉）
    expect(chartLog.scaleModes).toEqual([{ pane: 0, mode: 1 }, { pane: 1, mode: 0 }, { pane: 2, mode: 0 }]);
    expect(chartLog.priceLines).toEqual([
      { price: 25.5, axis: false },
      { price: 0, axis: false },
    ]);
    // 區間預設 10 年；圖例列出五條河道線的點位
    expect(screen.getByRole('button', { name: '10年' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(window.localStorage.getItem('uv-range')).toBe('ALL');
    const legend = document.querySelector('.cm-legend')!.textContent ?? '';
    expect(legend).toMatch(/2010-10-16 S&P 2,050 ｜ 本益比 26\.1倍 偏高 ｜ EPS 78\.5 ｜ 利差 -1\.50pp/);
    expect(legend).toMatch(/河道 15倍 1,177｜19倍 1,491｜23倍 1,805｜27倍 2,119｜31倍 2,433/);
    expect(screen.getAllByRole('listitem').map((e) => e.textContent)).toEqual(['15–19倍 偏低', '19–23倍 合理', '23–27倍 偏高', '27–31倍 昂貴']);
  });
});
