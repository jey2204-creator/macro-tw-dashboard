// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SeriesFile } from '../src/shared/types';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄呼叫，驗證窗格與序列的配置
const chartLog = { seriesPanes: [] as number[], watermarks: [] as string[], removed: 0 };
vi.mock('lightweight-charts', () => {
  const makeChart = () => {
    const panes = new Map<number, { setStretchFactor: () => void }>();
    return {
      addSeries: (_type: unknown, _opts: unknown, paneIndex = 0) => {
        chartLog.seriesPanes.push(paneIndex);
        if (!panes.has(paneIndex)) panes.set(paneIndex, { setStretchFactor: () => {} });
        return { setData: () => {}, createPriceLine: () => {} };
      },
      panes: () => [...panes.keys()].sort((a, b) => a - b).map((k) => panes.get(k)!),
      priceScale: () => ({ applyOptions: () => {} }),
      timeScale: () => ({ fitContent: () => {}, setVisibleRange: () => {}, setVisibleLogicalRange: () => {} }),
      subscribeCrosshairMove: () => {},
      unsubscribeCrosshairMove: () => {},
      applyOptions: () => {},
      remove: () => {
        chartLog.removed++;
      },
    };
  };
  return {
    createChart: () => makeChart(),
    createTextWatermark: (_pane: unknown, opts: { lines: { text: string }[] }) => {
      chartLog.watermarks.push(opts.lines[0]!.text);
      return { detach: () => {} };
    },
    CandlestickSeries: 'Candlestick',
    LineSeries: 'Line',
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
const DATES = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'];
const FILES: Record<string, SeriesFile> = {
  taiex: series('taiex', DATES.map((d, i) => flat(d, 46000 + i * 100))),
  sox: series('sox', DATES.map((d, i) => flat(d, 7000 + i * 10))),
  kospi: series('kospi', DATES.map((d, i) => flat(d, 3500 + i * 5))),
  usdtwd: series('usdtwd', DATES.map((d, i) => flat(d, 32 + i * 0.01))),
  us10y: series('us10y', DATES.map((d, i) => flat(d, 5 + i * 0.01)), true),
  nikkei: series('nikkei', DATES.map((d, i) => flat(d, 48000 + i * 50))),
  tpex: series('tpex', DATES.map((d, i) => flat(d, 300 + i))),
};

beforeEach(() => {
  chartLog.seriesPanes = [];
  chartLog.watermarks = [];
  chartLog.removed = 0;
  window.localStorage.clear();
  vi.stubGlobal('fetch', (url: string) => {
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

  it('已滿 5 個時再選會換掉最早選的，不必先取消；窗格依固定順序（櫃買在費半前）', async () => {
    window.localStorage.setItem('cm-ids', JSON.stringify(['sox', 'kospi', 'usdtwd', 'us10y', 'nikkei']));
    render(<CrossMarketPanel version="v1" themeKey="auto-false-tw" mas={[60, 240]} onMas={() => {}} />);
    expect(screen.getByText(/已滿 5 個，再選會換掉最早選的（費半SOX）/)).toBeTruthy();
    await waitFor(() => expect(chartLog.watermarks.length).toBe(6));
    fireEvent.click(screen.getByRole('button', { name: '櫃買指數' }));
    expect(JSON.parse(window.localStorage.getItem('cm-ids')!)).toEqual(['kospi', 'usdtwd', 'us10y', 'nikkei', 'tpex']);
    expect(screen.getByText(/再選會換掉最早選的（KOSPI）/)).toBeTruthy();
    await waitFor(() => expect(chartLog.watermarks.at(-5)).toBe('櫃買指數（同時段）'));
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
    expect(JSON.parse(window.localStorage.getItem('cm-ids')!)).toEqual(['gold', 'wti', 'brent', 'vix']);
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
});
