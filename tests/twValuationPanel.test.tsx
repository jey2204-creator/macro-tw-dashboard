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

const { TwValuationPanel } = await import('../src/components/TwValuationPanel');

function series(id: string, bars: Bar[]): SeriesFile {
  return {
    id,
    source: { provider: 'twse_val', symbol: id, url: '' },
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
const monthStr = (k: number) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
// 2004-10～2026-09 共 264 個月；每月 28 日一根加權 K 棒（月底收盤），指數由 6000 漸升到 47940
const N = 264;
const K0 = 2004 * 12 + 9;
const pe: Bar[] = [];
const pb: Bar[] = [];
const taiex: Bar[] = [];
for (let i = 0; i < N; i++) {
  const m = monthStr(K0 + i);
  pe.push(flat(`${m}-01`, 15 + (i % 10)));
  pb.push(flat(`${m}-01`, 1.5 + (i % 10) * 0.1));
  taiex.push(flat(`${m}-28`, 6000 + i * 150));
}
pe[N - 1] = flat('2026-09-01', 26.68);
pb[N - 1] = flat('2026-09-01', 4.21);
taiex[N - 1] = flat('2026-09-28', 47940);
taiex.push(flat('2026-10-19', 46822));
const FILES: Record<string, SeriesFile> = {
  taiex: series('taiex', taiex),
  tw_pe: series('tw_pe', pe),
  tw_pb: series('tw_pb', pb),
  tw_dy: series('tw_dy', [flat('2026-09-01', 1.58)]),
  tw10y: series('tw10y', [flat('2026-07-01', 1.9), flat('2026-08-01', 1.955)]),
  us10y: series('us10y', [flat('2026-10-16', 5.09)]),
  usdtwd: series('usdtwd', [flat('2026-05-29', 31.424), flat('2026-09-28', 31.85)]),
};

/** MSCI 台灣 factsheet 紀錄（第四個測試才提供；其餘回 404 → 面板沒有預估本益比列） */
let MSCI: object | null = null;
beforeEach(() => {
  MSCI = null;
  chartLog.series = [];
  chartLog.watermarks = [];
  chartLog.priceLines = [];
  chartLog.primitives = 0;
  chartLog.scaleModes = [];
  window.localStorage.clear();
  vi.stubGlobal('fetch', (url: string) => {
    if (/msci-tw\.json/.test(url)) {
      return Promise.resolve(MSCI ? new Response(JSON.stringify(MSCI), { status: 200 }) : new Response('not found', { status: 404 }));
    }
    const id = /series\/([a-z0-9_]+)\.json/.exec(url)?.[1] ?? '';
    const f = FILES[id];
    return Promise.resolve(f ? new Response(JSON.stringify(f), { status: 200 }) : new Response('not found', { status: 404 }));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('台股估值面板', () => {
  it('三行讀數：本益比與區間、河道與回推、淨值比與股債利差（含美債）', async () => {
    render(<TwValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelectorAll('.tv-state').length).toBe(3));
    const [l1, l2, l3] = [...document.querySelectorAll('.tv-state')].map((e) => e.textContent ?? '');
    // EPS＝9 月底收盤 47940 ÷ 26.68 ＝ 1,797；10/19 收 46822 → 26.1倍
    expect(l1).toMatch(/本益比 26\.1倍（近四季 EPS 1,797 點，年增 /);
    expect(l1).toMatch(/→ 昂貴｜2005 起第 \d+ 百分位（中位數 20\.0倍）/);
    expect(l2).toMatch(/河道：23～27倍之間，距 27倍線 -3\.5%、距 23倍線 \+13\.3%/);
    expect(l2).toMatch(/回到近 5 年均 \d+\.\d倍：EPS 需再 \+\d+%，或指數 -\d+%/);
    expect(l3).toMatch(/淨值比 4\.11倍→ 昂貴（2005 起第 \d+ 百分位，中位數 \d\.\d\d倍）｜殖利率 1\.58%/);
    // 盈餘殖利率 3.84% − 台債 10Y 1.96%（8 月）＝ +1.88pp；對美債 5.09% ＝ −1.25pp
    expect(l3).toMatch(/股債利差 \+1\.88pp（盈餘殖利率 3\.84% − 台債10Y 1\.96%，8月）→ 股票較划算｜對美債10Y -1\.25pp/);
  });

  it('圖表：河流圖（指數＋6 條倍數線、對數軸、色帶）、本益比、淨值比、利差四窗格；軸上不放標籤', async () => {
    render(<TwValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.watermarks.length).toBe(4));
    expect(chartLog.watermarks).toEqual([
      '河流圖｜近四季 EPS × 11／15／19／23／27／31倍（對數軸）',
      '本益比（倍）｜虛線 2005 起中位數 20.0',
      expect.stringMatching(/^淨值比（倍）｜虛線 2005 起中位數 \d\.\d\d$/),
      '股債利差（pp）＝盈餘殖利率 − 台債10Y',
    ]);
    expect(chartLog.series.map((s) => `${s.pane}:${s.type}`)).toEqual([
      '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '1:Line', '2:Line', '3:Baseline',
    ]);
    expect(chartLog.series.every((s) => !s.label)).toBe(true);
    // 倍數線不畫最新值水平線
    expect(chartLog.series.filter((s) => s.priceLine).length).toBe(4);
    expect(chartLog.primitives).toBe(1);
    expect(chartLog.scaleModes).toEqual([
      { pane: 0, mode: 1 },
      { pane: 1, mode: 0 },
      { pane: 2, mode: 0 },
      { pane: 3, mode: 0 },
    ]);
    expect(chartLog.priceLines.map((p) => p.axis)).toEqual([false, false, false]);
    expect(chartLog.priceLines[2]!.price).toBe(0);
    expect(screen.getAllByRole('listitem').map((e) => e.textContent)).toEqual([
      '11–15倍 偏低', '15–19倍 合理', '19–23倍 偏高', '23–27倍 昂貴', '27–31倍 昂貴',
    ]);
    expect(screen.getByRole('button', { name: '10年' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '5年' }));
    expect(window.localStorage.getItem('tv-range')).toBe('5Y');
    const legend = document.querySelector('.cm-legend')!.textContent ?? '';
    expect(legend).toMatch(/2026-10-19 加權 46,822 ｜ 本益比 26\.1倍 昂貴 ｜ 淨值比 4\.11 ｜ 利差 \+1\.88pp/);
    expect(legend).toMatch(/河道 11倍 19,765｜15倍 26,953｜19倍 34,140｜23倍 41,328｜27倍 48,515｜31倍 55,702/);
  });

  it('回測表：本益比、淨值比分組＋基準，目前所在區間標示', async () => {
    render(<TwValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelector('.tv-bt')).toBeTruthy());
    const rows = [...document.querySelectorAll('.tv-bt tbody tr')].map((tr) => tr.textContent ?? '');
    expect(rows[0]).toBe('本益比（倍）');
    expect(rows.slice(1, 5).map((r) => r.split(/\d/)[0])).toEqual(['<', '', '', '≥']);
    expect(rows[5]).toBe('淨值比（倍）');
    expect(rows[10]).toBe('股債利差（pp）');
    const firstCells = [...document.querySelectorAll('.tv-bt tbody tr')].map((tr) => tr.firstElementChild!.textContent);
    expect(firstCells.slice(11, 14)).toEqual(['<0', '0–3', '≥3']);
    expect(rows.at(-1)).toMatch(/^全部（基準）264/);
    // 最新本益比 26.1 → ≥23、淨值比 4.11 → ≥2.5、股債利差 +1.88 → 0–3，三列標示
    const hl = [...document.querySelectorAll('.tv-bt tr.hl')].map((tr) => tr.firstElementChild!.textContent);
    expect(hl).toEqual(['≥23', '≥2.5', '0–3']);
    expect(document.querySelector('.tv-bt caption')!.textContent).toMatch(/2004-10～2026-09 月底/);
  });

  it('有 MSCI 紀錄時：第四行讀數（預估本益比、隱含成長、對全球溢價、EPS 預估變化、歷史範圍）、本益比窗格多一條點狀序列', async () => {
    const r = (asOf: string, fwdPe: number, ytd: number, extra: object = {}) => ({
      asOf, fwdPe, pe: null, pbv: null, dy: 1.4, ret1m: null, ytd, acwiFwdPe: null, ...extra,
    });
    MSCI = {
      schemaVersion: 1,
      generatedAt: '2026-10-20T00:00:00Z',
      records: [
        r('2022-11-30', 12.19, -25.07),
        r('2026-05-29', 22.71, 60.54),
        r('2026-09-28', 18.65, 70.7, { pe: 29.51, acwiFwdPe: 16.2 }),
      ],
      annual: {},
    };
    render(<TwValuationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelector('.tv-fwd')).toBeTruthy());
    const l4 = document.querySelector('.tv-fwd')!.textContent ?? '';
    expect(l4).toMatch(/預估本益比 18\.65倍→ 合理（MSCI 台灣 2026\/9 底；近 12 月 29\.51倍 → 隱含 EPS 成長 \+58%）｜對全球 16\.20倍 \+15%/);
    // 5 月底 → 9 月底：含息報酬 1.707/1.6054 × 扣息 × 22.71/18.65 × 匯率 31.85/31.424 ≈ +30.7%
    expect(l4).toMatch(/｜未來 12 月 EPS 預估比 2026\/5 底 \+30\.\d%（4 個月）/);
    expect(l4).toMatch(/2021 起 3 期：最低 12\.19（2022\/11）、中位數 18\.65、最高 22\.71（2026\/5）/);
    expect(l4).not.toMatch(/⚠️/);
    await waitFor(() => expect(chartLog.series.length).toBe(11));
    expect(chartLog.series.map((x) => `${x.pane}:${x.type}`)).toEqual([
      '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '0:Line', '1:Line', '1:Line', '2:Line', '3:Baseline',
    ]);
    expect(screen.getAllByRole('listitem').map((e) => e.textContent).at(-1)).toBe('預估本益比（MSCI 月）');
  });
});
