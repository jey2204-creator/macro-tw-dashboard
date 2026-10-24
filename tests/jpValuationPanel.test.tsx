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

const { JpValuationPanel } = await import('../src/components/JpValuationPanel');

function series(id: string, bars: Bar[]): SeriesFile {
  return {
    id,
    source: { provider: 'nikkei', symbol: id, url: '' },
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
// 2004-10-01 起每天一根（含週末，測試不在意交易日曆），約 22 年
const N = 8060;
const T0 = Date.UTC(2004, 9, 1);
const day = (i: number) => new Date(T0 + i * 86_400_000).toISOString().slice(0, 10);
const nikkei: Bar[] = [];
const pe: Bar[] = [];
const peW: Bar[] = [];
const pb: Bar[] = [];
for (let i = 0; i < N; i++) {
  const d = day(i);
  nikkei.push(flat(d, 10000 + i * 6.5));
  // 本益比在 14～24 之間循環；加重平均低 4 倍；5/15 當天 PER 跳 −5%（換年度）
  const base = 14 + ((i / 300) % 1) * 10;
  const isMay15 = d.slice(5) === '05-15';
  pe.push(flat(d, isMay15 ? base * 0.95 : base));
  peW.push(flat(d, base - 4));
  pb.push(flat(d, 1.0 + ((i / 400) % 1) * 1.6));
}
const LAST = day(N - 1); // 2026-10-25 左右
// 最後 30 天固定在最新值（避免假資料的循環在最後一天製造 EPS 跳動）
for (let i = N - 30; i < N; i++) {
  pe[i] = flat(day(i), 20.76);
  peW[i] = flat(day(i), 16.65);
  pb[i] = flat(day(i), 2.4);
}
nikkei[N - 1] = flat(LAST, 62693.16);
const prevMonth = `${LAST.slice(0, 4)}-${String(Number(LAST.slice(5, 7)) - 1).padStart(2, '0')}-01`;
const FILES: Record<string, SeriesFile> = {
  nikkei: series('nikkei', nikkei),
  jp_fwd_pe: series('jp_fwd_pe', pe),
  jp_fwd_pe_w: series('jp_fwd_pe_w', peW),
  jp_pb: series('jp_pb', pb),
  jp_dy: series('jp_dy', [flat(LAST, 1.51)]),
  jp10y: series('jp10y', [flat(prevMonth, 1.7)]),
  us10y: series('us10y', [flat(LAST, 4.0)]),
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

describe('日股估值面板', () => {
  it('四行讀數：預估本益比與加重平均差距、河道、EPS 近 20 日、淨值比與股債利差', async () => {
    render(<JpValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelectorAll('.tv-state').length).toBe(4));
    const [l1, l2, l3, l4] = [...document.querySelectorAll('.tv-state')].map((e) => e.textContent ?? '');
    // EPS＝62693.16 ÷ 20.76 ＝ 3,020
    expect(l1).toMatch(/^預估本益比 20\.8倍（預估 EPS 3,020 點，年增 /);
    expect(l1).toMatch(/→ 偏高｜2010 起第 \d+ 百分位（中位數 \d+\.\d倍）｜加重平均 16\.6倍（中位數 \d+\.\d），差 4\.1倍＝權值股集中/);
    expect(l2).toMatch(/^河道：20～23倍之間，距 23倍線 -9\.7%、距 20倍線 \+3\.8%/);
    expect(l3).toMatch(/^預估 EPS 近 20 日 /);
    expect(l3).toMatch(/最近一次整批變動 20\d\d\/\d+\/\d+ [+-]\d+%/);
    expect(l4).toMatch(/^淨值比 2\.40倍→ 昂貴（2010 起第 \d+ 百分位，中位數 \d\.\d\d倍）｜預估殖利率 1\.51%/);
    // 盈餘殖利率 4.82% − 日債 1.70% ＝ +3.12pp；對美債 4.0% ＝ +0.82pp
    expect(l4).toMatch(/股債利差 \+3\.12pp（預估盈餘殖利率 4\.82% − 日債10Y 1\.70%，\d+月）→ 股票較划算｜對美債10Y \+0\.82pp/);
  });

  it('圖表：河流圖（指數＋6 條倍數線、對數軸、色帶）、本益比兩條線＋換年度標記、淨值比、利差四窗格', async () => {
    render(<JpValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.watermarks.length).toBe(4));
    expect(chartLog.watermarks[0]).toBe('河流圖｜預估 EPS × 11／14／17／20／23／26倍（對數軸）');
    expect(chartLog.watermarks[1]).toMatch(/^預估本益比｜點線 加重平均｜虛線 2010 起中位數 \d+\.\d$/);
    expect(chartLog.watermarks[3]).toBe('股債利差（pp）＝預估盈餘殖利率 − 日債10Y');
    expect(chartLog.series.map((s) => `${s.pane}:${s.type}`)).toEqual([
      '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '1:Line', '1:Line', '2:Line', '3:Baseline',
    ]);
    expect(chartLog.series.every((s) => !s.label)).toBe(true);
    expect(chartLog.primitives).toBe(1);
    expect(chartLog.scaleModes).toEqual([
      { pane: 0, mode: 1 },
      { pane: 1, mode: 0 },
      { pane: 2, mode: 0 },
      { pane: 3, mode: 0 },
    ]);
    // 每年 5/15 一個 ▲（PER −5% → EPS +5.3%）、5/16 一個 ▼（回到原值）→ 22 年約 44 個標記，不標字
    expect(chartLog.markers.length).toBeGreaterThanOrEqual(40);
    expect(chartLog.markers.every((m) => m.text === undefined)).toBe(true);
    expect(screen.getAllByRole('listitem').map((e) => e.textContent)).toEqual([
      '11–14倍 便宜', '14–17倍 偏低', '17–20倍 合理', '20–23倍 偏高', '23–26倍 昂貴', '▲▼ 單日預估 EPS 變動 ≥5%',
    ]);
    expect(screen.getByRole('button', { name: '10年' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '5年' }));
    expect(window.localStorage.getItem('jv-range')).toBe('5Y');
    const legend = document.querySelector('.cm-legend')!.textContent ?? '';
    expect(legend).toMatch(/日經 62,693 ｜ 預估本益比 20\.8倍 偏高（加重 16\.6） ｜ 淨值比 2\.40 ｜ 利差 \+3\.12pp/);
    expect(legend).toMatch(/預估 EPS 3,020｜河道 11倍 33,219｜14倍 42,279/);
  });

  it('回測表：預估本益比、淨值比、利差分組＋基準，目前所在區間標示', async () => {
    render(<JpValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelector('.tv-bt')).toBeTruthy());
    const rows = [...document.querySelectorAll('.tv-bt tbody tr')].map((tr) => tr.textContent ?? '');
    expect(rows[0]).toBe('預估本益比（倍，指數基準）');
    const firstCells = [...document.querySelectorAll('.tv-bt tbody tr')].map((tr) => tr.firstElementChild!.textContent);
    expect(firstCells.slice(1, 6)).toEqual(['<14', '14–17', '17–20', '20–23', '≥23']);
    expect(rows[6]).toBe('淨值比（倍）');
    expect(firstCells.slice(7, 11)).toEqual(['<1.2', '1.2–1.6', '1.6–2.0', '≥2.0']);
    expect(rows[11]).toBe('股債利差（pp）');
    expect(firstCells.slice(12, 15)).toEqual(['<4', '4–6', '≥6']);
    expect(rows.at(-1)).toMatch(/^全部（基準）\d+/);
    const hl = [...document.querySelectorAll('.tv-bt tr.hl')].map((tr) => tr.firstElementChild!.textContent);
    expect(hl).toEqual(['20–23', '≥2.0', '<4']);
    expect(document.querySelector('.tv-bt caption')!.textContent).toMatch(/2004-10～20\d\d-\d\d 月底，不含股息；前段／後段以 2013 年分/);
  });
});
