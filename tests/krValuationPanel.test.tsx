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
  markers: [] as { time: string; text?: string }[],
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
    createSeriesMarkers: (_s: unknown, markers: { time: string; text?: string }[]) => {
      chartLog.markers.push(...markers);
      return { setMarkers: () => {} };
    },
    LineSeries: 'Line',
    BaselineSeries: 'Baseline',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2, Dotted: 1 },
    PriceScaleMode: { Normal: 0, Logarithmic: 1 },
  };
});

const { KrValuationPanel } = await import('../src/components/KrValuationPanel');

function series(id: string, bars: Bar[]): SeriesFile {
  return {
    id,
    source: { provider: 'yahoo', symbol: id, url: '' },
    status: 'ok',
    fetchedAt: '2026-10-24T00:00:00Z',
    lastSuccessAt: '2026-10-24T00:00:00Z',
    lastDate: bars.at(-1)?.[0] ?? null,
    closeOnly: true,
    partial: false,
    errors: [],
    data: bars,
  };
}
const flat = (d: string, c: number): Bar => [d, c, c, c, c];
// KOSPI：2004-01-01 起每天一根（含週末）；月底比率 2004-01 起每月一筆
const T0 = Date.UTC(2004, 0, 1);
const LAST = '2026-10-23';
const N = Math.round((Date.parse(LAST) - T0) / 86_400_000) + 1;
const day = (i: number) => new Date(T0 + i * 86_400_000).toISOString().slice(0, 10);
const kospi: Bar[] = [];
for (let i = 0; i < N; i++) kospi.push(flat(day(i), 800 + i * 0.8));
kospi[N - 1] = flat(LAST, 7500);
const pb: Bar[] = [];
const pe: Bar[] = [];
const dy: Bar[] = [];
const y10: Bar[] = [];
for (let i = 0; ; i++) {
  const y = 2004 + Math.floor(i / 12);
  const m = String((i % 12) + 1).padStart(2, '0');
  const d = `${y}-${m}-01`;
  if (d > '2026-09-01') break;
  const lastMonth = d === '2026-09-01';
  // 淨值比 0.9～1.5 循環、本益比 10～18 循環；最後一期 1.70／11.4（半年報併入：EPS 跳 +60%）
  pb.push(flat(d, lastMonth ? 1.7 : 0.9 + (i % 12) * 0.05));
  pe.push(flat(d, lastMonth ? 11.4 : 10 + (i % 16) * 0.5));
  dy.push(flat(d, 0.93));
  y10.push(flat(d, 4.3));
}
const FILES: Record<string, SeriesFile> = {
  kospi: series('kospi', kospi),
  kr_pb: series('kr_pb', pb),
  kr_pe: series('kr_pe', pe),
  kr_dy: series('kr_dy', dy),
  kr10y: series('kr10y', y10),
  us10y: series('us10y', [flat(LAST, 4.0)]),
  kr_fwd_pe: series('kr_fwd_pe', [flat('2026-07-31', 6.2), flat('2026-08-29', 5.5), flat('2026-09-30', 4.95)]),
  kr_msci_pe: series('kr_msci_pe', [flat('2026-09-30', 10.25)]),
  kr_msci_pb: series('kr_msci_pb', [flat('2026-08-29', 2.4), flat('2026-09-30', 2.29)]),
};

beforeEach(() => {
  chartLog.series = [];
  chartLog.watermarks = [];
  chartLog.priceLines = [];
  chartLog.primitives = 0;
  chartLog.markers = [];
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

// 2026-09-30 收盤＝800 + 0.8 × 天數
const SEP30 = 800 + 0.8 * Math.round((Date.parse('2026-09-30') - T0) / 86_400_000);
const BV = SEP30 / 1.7;
const EPS = SEP30 / 11.4;

describe('韓股估值面板', () => {
  it('四行讀數：淨值比（主角）、河道、本益比與利差、MSCI 預估本益比', async () => {
    render(<KrValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelectorAll('.tv-state').length).toBe(4));
    const [l1, l2, l3, l4] = [...document.querySelectorAll('.tv-state')].map((e) => e.textContent ?? '');
    const pbNow = 7500 / BV;
    expect(l1).toMatch(new RegExp(`^淨值比 ${pbNow.toFixed(2)}倍（每股淨值 ${Math.round(BV).toLocaleString('en-US')} 點，年增 `));
    expect(l1).toMatch(/→ 昂貴｜2004 起第 \d+ 百分位（中位數 \d\.\d\d倍）/);
    expect(l2).toMatch(/^河道：1\.6～2倍之間，距 2倍線 -\d+\.\d%、距 1\.6倍線 \+\d+\.\d%｜回到近 5 年均 \d\.\d\d倍：淨值需再 \+\d+%，或指數 -\d+%/);
    const peNow = 7500 / EPS;
    expect(l3).toMatch(new RegExp(`^本益比 ${peNow.toFixed(1)}倍（最近年度 EPS ${Math.round(EPS).toLocaleString('en-US')} 點，年增 `));
    expect(l3).toMatch(/→ 偏低（2004 起第 \d+ 百分位，中位數 \d+\.\d倍）｜最近換財報 2026\/9 EPS \+\d+%｜殖利率 0\.93%｜股債利差 /);
    expect(l3).toMatch(/盈餘殖利率 \d\.\d\d% − 韓債10Y 4\.30%，9月）→ /);
    expect(l4).toMatch(/^預估本益比 4\.95倍→ 便宜（MSCI 韓國 2026\/9 底；近 12 月 10\.25倍 → 隱含未來 12 月 EPS 成長 \+107%）｜比 2026\/8 底 5\.50倍 -10%｜MSCI 淨值比 2\.29倍（KRX 全市場 \d\.\d\d）｜3 期：最低 4\.95（2026\/9）、中位數 5\.50、最高 6\.20（2026\/7）$/);
  });

  it('圖表：淨值比河流圖、淨值比＋MSCI 點、本益比（鎖軸）＋預估本益比點＋換財報標記、利差', async () => {
    render(<KrValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.watermarks.length).toBe(4));
    expect(chartLog.watermarks[0]).toBe('淨值比河流圖｜每股淨值 × 0.7／0.9／1.1／1.3／1.6／2倍（對數軸）');
    expect(chartLog.watermarks[1]).toMatch(/^淨值比（倍）｜虛線 2004 起中位數 \d\.\d\d｜藍點 MSCI 韓國$/);
    expect(chartLog.watermarks[2]).toMatch(/^本益比（倍，最近年度實績）｜虛線中位數 \d+\.\d｜藍點 MSCI 預估本益比｜軸 5～35 倍$/);
    expect(chartLog.watermarks[3]).toBe('股債利差（pp）＝盈餘殖利率 − 韓債10Y');
    expect(chartLog.series.map((s) => `${s.pane}:${s.type}`)).toEqual([
      '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '1:Line', '1:Line', '2:Line', '2:Line', '3:Baseline',
    ]);
    expect(chartLog.series.every((s) => !s.label)).toBe(true);
    expect(chartLog.primitives).toBe(1);
    expect(chartLog.scaleModes).toEqual([
      { pane: 0, mode: 1 },
      { pane: 1, mode: 0 },
      { pane: 2, mode: 0 },
      { pane: 3, mode: 0 },
    ]);
    // 假資料本益比 10～18 循環：每 16 個月回到 10（EPS +80%）→ 標記 ≥ 15 個；最後一期半年報 +60%
    expect(chartLog.markers.length).toBeGreaterThanOrEqual(15);
    expect(chartLog.markers.every((m) => m.text === undefined)).toBe(true);
    expect(screen.getAllByRole('listitem').map((e) => e.textContent)).toEqual([
      '0.7–0.9倍 便宜', '0.9–1.1倍 偏低', '1.1–1.3倍 合理', '1.3–1.6倍 偏高', '1.6–2倍 昂貴', 'MSCI 韓國（月）', '▲▼ 換財報：單月 EPS 變動 ≥8%',
    ]);
    expect(screen.getByRole('button', { name: '10年' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '5年' }));
    expect(window.localStorage.getItem('kv-range')).toBe('5Y');
    const legend = document.querySelector('.cm-legend')!.textContent ?? '';
    expect(legend).toMatch(new RegExp(`KOSPI 7,500 ｜ 淨值比 ${(7500 / BV).toFixed(2)}倍 昂貴 ｜ 本益比 ${(7500 / EPS).toFixed(1)}倍 偏低 ｜ 利差 `));
    expect(legend).toMatch(new RegExp(`每股淨值 ${Math.round(BV).toLocaleString('en-US')}｜河道 0.7倍 ${Math.round(BV * 0.7).toLocaleString('en-US')}｜0.9倍 `));
  });

  it('回測表：淨值比在前、本益比、利差分組＋基準，目前所在區間標示', async () => {
    render(<KrValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelector('.tv-bt')).toBeTruthy());
    const rows = [...document.querySelectorAll('.tv-bt tbody tr')].map((tr) => tr.textContent ?? '');
    expect(rows[0]).toBe('淨值比（倍）');
    const firstCells = [...document.querySelectorAll('.tv-bt tbody tr')].map((tr) => tr.firstElementChild!.textContent);
    expect(firstCells.slice(1, 6)).toEqual(['<0.9', '0.9–1.1', '1.1–1.3', '1.3–1.6', '≥1.6']);
    expect(rows[6]).toBe('本益比（倍，最近年度實績）');
    expect(firstCells.slice(7, 12)).toEqual(['<9', '9–12', '12–15', '15–18', '≥18']);
    expect(rows[12]).toBe('股債利差（pp）');
    expect(firstCells.slice(13, 16)).toEqual(['<3', '3–6', '≥6']);
    expect(rows.at(-1)).toMatch(/^全部（基準）\d+/);
    const hl = [...document.querySelectorAll('.tv-bt tr.hl')].map((tr) => tr.firstElementChild!.textContent);
    expect(hl).toEqual(['≥1.6', '9–12', '3–6']);
    expect(document.querySelector('.tv-bt caption')!.textContent).toMatch(/2004-01～2026-09 月底，公布後起算、不含股息；前段／後段以 2013 年分/);
  });
});
