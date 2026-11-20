// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SeriesFile } from '../src/shared/types';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄呼叫，驗證窗格與序列的配置
const chartLog = { seriesOpts: [] as { pane: number; opts: Record<string, unknown> }[], seriesPanes: [] as number[], watermarks: [] as string[], removed: 0, markers: [] as { time: string; text?: string }[], fibMarkers: [] as { time: string; text?: string }[], geoMarkers: [] as { time: string; text?: string; position?: string; shape?: string }[], geoLabels: [] as { time: string; value: number; text: string; above: boolean }[], markerPlugins: 0 };
const markerOwners = new WeakMap<object, number>();
let twMarkerSeries: object | null = null;
vi.mock('lightweight-charts', () => {
  const makeChart = () => {
    const panes = new Map<number, { setStretchFactor: () => void; getHeight: () => number; getHTMLElement: () => null }>();
    return {
      addSeries: (_type: unknown, opts: Record<string, unknown>, paneIndex = 0) => {
        chartLog.seriesPanes.push(paneIndex);
        chartLog.seriesOpts.push({ pane: paneIndex, opts });
        if (!panes.has(paneIndex)) panes.set(paneIndex, { setStretchFactor: () => {}, getHeight: () => 300, getHTMLElement: () => null });
        return { setData: () => {}, attachPrimitive: (p: { labels?: typeof chartLog.geoLabels }) => { chartLog.geoLabels = p.labels ?? []; }, detachPrimitive: () => { chartLog.geoLabels = []; }, createPriceLine: () => ({}), removePriceLine: () => {}, priceToCoordinate: () => 100, priceScale: () => ({ applyOptions: () => {} }), getPane: () => ({ paneIndex: () => paneIndex }) };
      },
      panes: () => [...panes.keys()].sort((a, b) => a - b).map((k) => panes.get(k)!),
      priceScale: () => ({ applyOptions: () => {}, width: () => 60 }),
      timeScale: () => ({ fitContent: () => {}, setVisibleRange: () => {}, setVisibleLogicalRange: () => {}, applyOptions: () => {}, subscribeVisibleLogicalRangeChange: () => {}, unsubscribeVisibleLogicalRangeChange: () => {}, getVisibleRange: () => null, getVisibleLogicalRange: () => null, timeToIndex: () => null, timeToCoordinate: () => null, width: () => 300 }),
      subscribeCrosshairMove: () => {},
      unsubscribeCrosshairMove: () => {},
      applyOptions: () => {},
      remove: () => {
        chartLog.removed++;
        chartLog.markerPlugins = 0;
      },
    };
  };
  return {
    createChart: () => makeChart(),
    // 加權序列上第一個 markers plugin 是公布日標記（記進 chartLog.markers）；加權第二個是費波波段高低點（記進 fibMarkers）；第三個是重大事件（記進 geoMarkers）；
    // 對照窗格（櫃買、費半、KOSPI）各只有一個費波標記 plugin，不記
    createSeriesMarkers: (series: object) => {
      // 每次重建圖表第一個拿到 plugin 的是加權序列
      if (chartLog.markerPlugins === 0) twMarkerSeries = series;
      chartLog.markerPlugins++;
      const twSeries = series === twMarkerSeries;
      const nth = markerOwners.get(series) ?? 0;
      markerOwners.set(series, nth + 1);
      return {
        setMarkers: (m: { time: string; text?: string }[]) => {
          if (!twSeries) return;
          if (nth === 0) chartLog.markers = m;
          else if (nth === 1) chartLog.fibMarkers = m;
          else chartLog.geoMarkers = m;
        },
      };
    },
    createTextWatermark: (_pane: unknown, opts: { lines: { text: string }[] }) => {
      chartLog.watermarks.push(opts.lines[0]!.text);
      return { detach: () => {} };
    },
    CandlestickSeries: 'Candlestick',
    LineSeries: 'Line',
    HistogramSeries: 'Histogram',
    LineStyle: { Dashed: 2 },
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
  };
});

const { CrossMarketPanel } = await import('../src/components/CrossMarketPanel');

function series(id: string, bars: Bar[], closeOnly = false): SeriesFile {
  return {
    id,
    source: { provider: 'yahoo', symbol: id, url: '' },
    status: 'ok',
    fetchedAt: '2026-10-15T00:00:00Z',
    lastSuccessAt: '2026-10-15T00:00:00Z',
    lastDate: bars.at(-1)?.[0] ?? null,
    closeOnly,
    partial: false,
    errors: [],
    data: bars,
  };
}
const flat = (d: string, c: number): Bar => [d, c, c, c, c];
const DATES = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'];
const FILES: Record<string, SeriesFile> = {
  taiex: series('taiex', DATES.map((d, i) => flat(d, 46000 + i * 100))),
  sox: series('sox', DATES.map((d, i) => flat(d, 7000 + i * 10))),
  nasdaq: series('nasdaq', DATES.map((d, i) => flat(d, 24000 + i * 20))),
  kospi: series('kospi', DATES.map((d, i) => flat(d, 3500 + i * 5))),
  usdtwd: series('usdtwd', DATES.map((d, i) => flat(d, 32 + i * 0.01))),
  us10y: series('us10y', DATES.map((d, i) => flat(d, 5 + i * 0.01)), true),
  nikkei: series('nikkei', DATES.map((d, i) => flat(d, 48000 + i * 50))),
  tpex: series('tpex', DATES.map((d, i) => flat(d, 300 + i))),
  usdkrw: series('usdkrw', DATES.map((d) => flat(d, 1340))),
  // 韓國外資買賣超（億韓元）：最後一天 −12,060 ÷ 1,340 ＝ −9.0 億美元
  kr_foreign: series('kr_foreign', DATES.map((d, i) => flat(d, -1340 * (i + 1))), true),
};
// 台灣外資買賣超（億台幣）來自 foreign-chips.json：最後一天 −321 ÷ 32.08 ≈ −10.0 億美元
const CHIPS = { schemaVersion: 1, rows: DATES.map((d) => [d, 46000, -321, null, null, null, null, null, null]) };
const fetched: string[] = [];

beforeEach(() => {
  chartLog.seriesPanes = [];
  chartLog.seriesOpts = [];
  chartLog.watermarks = [];
  chartLog.removed = 0;
  chartLog.markers = [];
  chartLog.geoMarkers = [];
  chartLog.geoLabels = [];
  window.localStorage.clear();
  fetched.length = 0;
  vi.stubGlobal('fetch', (url: string) => {
    fetched.push(url);
    if (url.includes('foreign-chips.json')) return Promise.resolve(new Response(JSON.stringify(CHIPS), { status: 200 }));
    const id = /series\/([a-z0-9_]+)\.json/.exec(url)?.[1] ?? '';
    const f = FILES[id];
    return Promise.resolve(
      f ? new Response(JSON.stringify(f), { status: 200 }) : new Response('not found', { status: 404 }),
    );
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('跨市場對照面板', () => {
  it('預設加權＋費半、KOSPI、USD/TWD，美系序列對齊，窗格與浮水印依選擇配置', async () => {
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[60, 240]} onMas={() => {}} />);
    expect(screen.getByRole('button', { name: '費半SOX' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'KOSPI' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'USD/TWD' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'NASDAQ' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /美系對齊台股交易日/ }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(screen.getByText(/ρ60：/)).toBeTruthy());
    // 加權（含 2 條均線）在窗格 0，三個對照序列各佔一個窗格
    await waitFor(() => expect(chartLog.watermarks).toEqual(['加權指數（MA60／240）', '費半SOX（前一晚，已對齊）', 'KOSPI（同時段）', 'USD/TWD（同時段）']));
    // 每個窗格：主序列 + 勾選的 2 條均線
    expect(chartLog.seriesPanes).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(screen.getByText(/加權資料 2026-10-13/)).toBeTruthy();
  });

  it('費波那契：預設開、波段預設 1 年且與圖表區間脫鉤；資料太短時圖例說明不畫；關閉後波段按鈕收起', async () => {
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[60, 240]} onMas={() => {}} />);
    await waitFor(() => expect(chartLog.watermarks.length).toBe(4));
    expect(screen.getByRole('button', { name: /費波那契回撤/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '波段1年' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '3個月' }).getAttribute('aria-pressed')).toBe('true'); // 圖表區間
    expect(screen.getByText(/📐 波段1年｜加權/)).toBeTruthy();
    expect(screen.getByText(/📐 波段1年｜加權/).textContent).toMatch(/不畫/);
    // 費半、KOSPI 預設在對照裡，各自一行費波圖例；USD/TWD 不畫費波
    expect(screen.getByText(/📐 費半SOX/)).toBeTruthy();
    expect(screen.getByText(/📐 KOSPI/)).toBeTruthy();
    expect(screen.queryByText(/📐 USD\/TWD/)).toBeNull();
    expect(screen.queryByText(/📐 櫃買/)).toBeNull();
    expect(document.querySelectorAll('.cm-fib')).toHaveLength(3);
    // 選進櫃買後多一行櫃買圖例（共用同一顆開關與波段）
    fireEvent.click(screen.getByRole('button', { name: '櫃買指數' }));
    await waitFor(() => expect(screen.getByText(/📐 櫃買/)).toBeTruthy());
    expect(document.querySelectorAll('.cm-fib')).toHaveLength(4);
    // NASDAQ 也畫費波（美股三指數比照費半）
    fireEvent.click(screen.getByRole('button', { name: 'NASDAQ' }));
    await waitFor(() => expect(screen.getByText(/📐 NASDAQ/)).toBeTruthy());
    expect(document.querySelectorAll('.cm-fib')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '日經225' }));
    await waitFor(() => expect(screen.getByText(/📐 日經/)).toBeTruthy());
    expect(document.querySelectorAll('.cm-fib')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: '波段3個月' }));
    expect(window.localStorage.getItem('cm-fib-range')).toBe('3M');
    expect(screen.getByText(/📐 波段3個月｜加權/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '波段3個月' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /費波那契回撤/ }));
    expect(window.localStorage.getItem('cm-fib')).toBe('0');
    expect(screen.queryByRole('button', { name: '波段3個月' })).toBeNull();
    expect(document.querySelectorAll('.cm-fib')).toHaveLength(0);
    expect(screen.queryByText(/📐 櫃買/)).toBeNull();
  });

  it('取消對齊後浮水印標示未對齊；新增序列會增加窗格並記住選擇', async () => {
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[60, 240]} onMas={() => {}} />);
    await waitFor(() => expect(chartLog.watermarks.length).toBe(4));
    fireEvent.click(screen.getByRole('button', { name: /美系對齊台股交易日/ }));
    await waitFor(() => expect(chartLog.watermarks.at(-3)).toBe('費半SOX（前一晚，未對齊）'));
    fireEvent.click(screen.getByRole('button', { name: '美債10Y' }));
    await waitFor(() => expect(chartLog.watermarks.at(-1)).toBe('美債10Y（前一晚，未對齊）'));
    expect(JSON.parse(window.localStorage.getItem('cm-ids')!)).toEqual(['sox', 'kospi', 'usdtwd', 'us10y']);
    expect(window.localStorage.getItem('cm-align')).toBe('0');
  });

  it('已滿 6 個時再選會換掉最早選的，不必先取消；窗格依固定順序（櫃買在費半前）', async () => {
    window.localStorage.setItem('cm-ids', JSON.stringify(['sox', 'kospi', 'usdtwd', 'us10y', 'nikkei', 'tpex']));
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[60, 240]} onMas={() => {}} />);
    expect(screen.getByText(/已滿 6 個，再選會換掉最早選的（費半SOX）/)).toBeTruthy();
    await waitFor(() => expect(chartLog.watermarks.length).toBe(7));
    expect(chartLog.watermarks[1]).toBe('櫃買指數（同時段）');
    fireEvent.click(screen.getByRole('button', { name: 'NASDAQ' }));
    expect(JSON.parse(window.localStorage.getItem('cm-ids')!)).toEqual(['kospi', 'usdtwd', 'us10y', 'nikkei', 'tpex', 'nasdaq']);
    expect(screen.getByText(/再選會換掉最早選的（KOSPI）/)).toBeTruthy();
  });

  it('台外資、韓外資：換算成億美元，每格畫每日柱＋20 日累計線；台灣用 foreign-chips.json，不算 ρ', async () => {
    window.localStorage.setItem('cm-ids', JSON.stringify(['kr_foreign', 'net_foreign']));
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[60]} onMas={() => {}} />);
    expect(screen.getByRole('button', { name: '台外資' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '韓外資' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(chartLog.watermarks).toEqual([
        '加權指數（MA60）',
        '台外資（億美元｜柱＝每日、線＝20日累計）',
        '韓外資（億美元｜柱＝每日、線＝20日累計）',
      ]),
    );
    // 流量窗格不畫均線：柱＋累計線各 2 條
    expect(chartLog.seriesPanes).toEqual([0, 0, 1, 1, 2, 2]);
    expect(fetched.some((u) => u.includes('series/net_foreign.json'))).toBe(false);
    expect(fetched.some((u) => u.includes('foreign-chips.json'))).toBe(true);
    const legend = document.querySelector('.cm-legend')!.textContent!;
    expect(legend).toMatch(/台外資 -10\.0 億美元/);
    expect(legend).toMatch(/韓外資 -9\.0 億美元/);
    expect(screen.queryByText(/ρ60：/)).toBeNull();
  });

  it('一鍵切換組合：股市／匯率利率／原油，與目前選擇相同時顯示為按下', () => {
    window.localStorage.setItem('cm-ids', JSON.stringify(['dxy', 'usdtwd', 'us2y', 'tlt', 'us10y']));
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[60, 240]} onMas={() => {}} />);
    expect(screen.getByRole('button', { name: '匯率利率' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '股市' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '股市' }));
    expect(JSON.parse(window.localStorage.getItem('cm-ids')!)).toEqual(['tpex', 'sox', 'nasdaq', 'kospi', 'nikkei']);
    expect(screen.getByRole('button', { name: '股市' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '避險' }));
    expect(JSON.parse(window.localStorage.getItem('cm-ids')!)).toEqual(['gold', 'wti', 'brent', 'vix', 'btc']);
  });

  it('對照序列載入失敗時顯示原因，其餘窗格照常', async () => {
    window.localStorage.setItem('cm-ids', JSON.stringify(['sox', 'dxy']));
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[60, 240]} onMas={() => {}} />);
    await waitFor(() => expect(screen.getByText(/載入失敗：DXY：HTTP 404/)).toBeTruthy());
    await waitFor(() => expect(chartLog.watermarks).toEqual(['加權指數（MA60／240）', '費半SOX（前一晚，已對齊）']));
  });

  it('均線按鈕與單一指標圖共用設定：六條全開時每個窗格都畫六條，圖例列出加權的均線值', async () => {
    const onMas = vi.fn();
    const all = [5, 10, 20, 60, 120, 240] as const;
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[...all]} onMas={onMas} />);
    for (const p of all) expect(screen.getByRole('button', { name: `MA${p}` }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(chartLog.watermarks[0]).toBe('加權指數（MA5／10／20／60／120／240）'));
    expect(chartLog.seriesPanes.filter((i) => i === 0)).toHaveLength(7);
    expect(chartLog.seriesPanes.filter((i) => i === 1)).toHaveLength(7);
    // 圖例（.ma-legend）列出加權的 6 條均線值；資料只有 7 筆，MA5 有值、MA240 為 —
    const legend = document.querySelector('.ma-legend')!;
    expect(legend.querySelectorAll('span')).toHaveLength(6);
    expect(legend.textContent).toMatch(/MA5 46,[0-9]{3}/);
    expect(legend.textContent).toContain('MA240 —');
    fireEvent.click(screen.getByRole('button', { name: 'MA5' }));
    expect(onMas).toHaveBeenCalledWith([10, 20, 60, 120, 240]);
  });

  it('加權窗格的 MA120／MA240 不參與 Y 軸自動縮放；其他均線與對照窗格照常', async () => {
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[20, 60, 120, 240]} onMas={() => {}} />);
    await waitFor(() => expect(chartLog.seriesOpts.length).toBeGreaterThan(5));
    const excluded = chartLog.seriesOpts.filter((s) => typeof s.opts.autoscaleInfoProvider === 'function');
    expect(excluded).toHaveLength(2);
    expect(excluded.every((s) => s.pane === 0)).toBe(true);
    expect(excluded.map((s) => (s.opts.autoscaleInfoProvider as () => unknown)())).toEqual([null, null]);
  });

  it('公布日標記：10/14 CPI 公布 → 10/15 加權 K 棒標記；關閉後清空並記住', async () => {
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[]} onMas={() => {}} now={new Date('2026-10-16T08:00:00Z')} />);
    await waitFor(() => expect(chartLog.markers.length).toBeGreaterThan(0));
    // 2026-10-02 就業報告（ET 08:30）→ 10/05 台股；10/14 CPI 的反應日 10/15 不在資料內，9 月前的事件早於資料起點不標
    expect(chartLog.markers).toEqual([
      { time: '2026-10-05', position: 'belowBar', shape: 'circle', size: 0.6, color: expect.any(String), text: '非農' },
    ]);
    expect(screen.getByText(/2022 年起加權反應日/)).toBeTruthy();
    // 5 年以上不顯示
    fireEvent.click(screen.getByRole('button', { name: '5年' }));
    await waitFor(() => expect(chartLog.markers).toEqual([]));
    fireEvent.click(screen.getByRole('button', { name: '1年' }));
    await waitFor(() => expect(chartLog.markers.length).toBe(1));
    expect(chartLog.markers[0]!.text).toBeUndefined(); // 1 年只有圓點
    fireEvent.click(screen.getByRole('button', { name: /公布日標記/ }));
    await waitFor(() => expect(chartLog.markers).toEqual([]));
    expect(window.localStorage.getItem('cm-events')).toBe('0');
  });

  it('重大事件標記：react 當天（休市順延）加權 K 棒上方方塊，文字自繪防撞；5 年以上只畫方塊；一覽表點一筆聚焦；關閉後清空並記住', async () => {
    const geoEvents = [
      { id: 'a', type: 'summit' as const, name: '測試峰會', short: '峰會', start: '2026-10-02', end: '2026-10-03', react: '2026-10-03', note: '結果摘要' },
      { id: 'b', type: 'war' as const, name: '測試期限', short: '期限', start: '2026-10-05', react: '2026-10-05' },
      { id: 'c', type: 'summit' as const, name: '還沒到', short: '未來', start: '2026-10-20', react: '2026-10-21' },
    ];
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[]} onMas={() => {}} now={new Date('2026-10-16T08:00:00Z')} geoEvents={geoEvents} />);
    await waitFor(() => expect(chartLog.geoMarkers.length).toBeGreaterThan(0));
    // 10/03 是週六 → 順延到 10/05，和同日的期限合併成一個方塊
    expect(chartLog.geoMarkers).toEqual([
      { time: '2026-10-05', position: 'aboveBar', shape: 'square', size: 0.6, color: expect.any(String) },
    ]);
    // 文字交給 MarkerLabels（貼在那根 K 棒的最高價上方）
    expect(chartLog.geoLabels).toEqual([{ time: '2026-10-05', value: 46200, text: '峰會+期限', color: expect.any(String), above: true }]);
    expect(screen.getByRole('button', { name: /重大事件/ }).getAttribute('aria-pressed')).toBe('true');
    // 5 年：■ 還在、文字不畫
    fireEvent.click(screen.getByRole('button', { name: '5年' }));
    await waitFor(() => expect(chartLog.geoLabels).toEqual([]));
    expect(chartLog.geoMarkers.length).toBe(1);
    // 一覽表：新的在上、還沒發生的不能點；點一筆 → 進入聚焦（文字回來、顯示「回最新」），選區間就離開
    const rows = [...document.querySelectorAll('.cm-geo-table tbody tr')].map((tr) => tr.textContent ?? '');
    expect(rows.length).toBe(3);
    expect(rows[0]).toContain('還沒到');
    expect(rows[0]).toContain('尚未發生');
    expect(rows[1]).toContain('測試期限');
    expect(rows[1]).toContain('→ 10/05');
    expect(screen.queryByRole('button', { name: '還沒到' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '測試峰會' }));
    await waitFor(() => expect(chartLog.geoLabels[0]?.text).toBe('峰會+期限'));
    expect(screen.getByText(/正在看/).textContent).toContain('2026-10-05');
    // 那天有戰爭事件 → 可一鍵切到「避險」組合，切過去按鈕就消失
    fireEvent.click(screen.getByRole('button', { name: /對照避險組合/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /對照避險組合/ })).toBeNull());
    expect(window.localStorage.getItem('cm-ids')).toBe('["gold","wti","brent","vix","btc"]');
    expect(screen.getByRole('button', { name: '5年' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '1年' }));
    await waitFor(() => expect(screen.queryByText(/正在看/)).toBeNull());
    await waitFor(() => expect(chartLog.geoLabels[0]?.text).toBe('峰會+期限')); // 筆數少，1 年也附文字
    fireEvent.click(screen.getByRole('button', { name: /重大事件/ }));
    await waitFor(() => expect(chartLog.geoMarkers).toEqual([]));
    expect(chartLog.geoLabels).toEqual([]);
    expect(window.localStorage.getItem('cm-geo')).toBe('0');
    // 公布日標記不受影響
    expect(chartLog.markers.length).toBe(1);
  });
});
