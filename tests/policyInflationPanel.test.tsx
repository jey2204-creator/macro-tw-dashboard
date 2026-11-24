// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SeriesFile } from '../src/shared/types';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄序列配置
const chartLog = {
  series: [] as { pane: number; title?: string; label: boolean }[],
  styles: [] as { color?: string; dashed: boolean }[],
  labels: [] as string[][],
  watermarks: [] as string[],
  priceLines: [] as { price: number; title?: string; axis: boolean }[],
  prims: [] as { labels?: { text: string; at?: (t: string) => { price: number; text: string } | null }[] }[],
  // 假時間軸：標籤欄左緣落在第幾根（null＝量不到）、最後一根的索引
  scale: { logical: null as number | null, lastIdx: 0, time: '2025-09-17' },
};
vi.mock('lightweight-charts', () => {
  const makeChart = () => {
    const panes = new Map<number, { setStretchFactor: () => void }>();
    return {
      addSeries: (_type: unknown, opts: { title?: string; lastValueVisible?: boolean; color?: string; lineStyle?: number }, paneIndex = 0) => {
        chartLog.series.push({ pane: paneIndex, title: opts.title, label: opts.lastValueVisible !== false });
        chartLog.styles.push({ color: opts.color, dashed: opts.lineStyle === 2 });
        if (!panes.has(paneIndex)) panes.set(paneIndex, { setStretchFactor: () => {} });
        return { setData: () => {}, attachPrimitive: (p: { labels?: { text: string }[] }) => {
          chartLog.prims.push(p);
          chartLog.labels.push((p.labels ?? []).map((l) => l.text));
        }, createPriceLine: (o: { price: number; title?: string; axisLabelVisible?: boolean }) =>
            chartLog.priceLines.push({ price: o.price, title: o.title, axis: o.axisLabelVisible !== false }),
        };
      },
      panes: () => [...panes.keys()].sort((a, b) => a - b).map((k) => panes.get(k)!),
      priceScale: () => ({ applyOptions: () => {} }),
      timeScale: () => ({ fitContent: () => {}, setVisibleRange: () => {}, setVisibleLogicalRange: () => {}, applyOptions: () => {}, subscribeVisibleLogicalRangeChange: () => {}, unsubscribeVisibleLogicalRangeChange: () => {}, getVisibleLogicalRange: () => null, getVisibleRange: () => null, timeToCoordinate: () => null, timeToIndex: () => chartLog.scale.lastIdx, width: () => 300, coordinateToLogical: () => chartLog.scale.logical, logicalToCoordinate: (i: number) => i * 20, coordinateToTime: () => chartLog.scale.time }),
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
    PriceScaleMode: { Normal: 0, Logarithmic: 1 },
  };
});

const { PolicyInflationPanel } = await import('../src/components/PolicyInflationPanel');
const { rightGapBars, endLabelGapPx, followAnchor } = await import('../src/lib/endLabels');
const { stackYs } = await import('../src/lib/lineLabels');

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
  us2y: series('us2y', [flat('2025-10-14', 3.9), flat('2025-10-15', 3.7)]),
  // S&P：Fed 2025-09-18 降息前後各一天
  spx: series('spx', [flat('2025-09-17', 6600), flat('2025-09-18', 6620), flat('2025-10-15', 6700)]),
  nasdaq: series('nasdaq', [flat('2025-09-17', 22000), flat('2025-09-18', 22100), flat('2025-10-15', 22500)]),
  sox: series('sox', [flat('2025-09-17', 6000), flat('2025-09-18', 6050), flat('2025-10-15', 6300)]),
  taiex: series('taiex', [flat('2025-09-17', 25000), flat('2025-09-18', 25100), flat('2025-10-15', 26000)]),
  unrate: series('unrate', months(0, 21, () => 4.2)),
  baa10y: series('baa10y', [flat('2025-10-10', 1.5), flat('2025-10-14', 1.6)]),
  hy_oas: series('hy_oas', [flat('2025-10-10', 3.2), flat('2025-10-14', 3.3)]),
};

beforeEach(() => {
  chartLog.series = [];
  chartLog.styles = [];
  chartLog.labels = [];
  chartLog.watermarks = [];
  chartLog.priceLines = [];
  chartLog.prims = [];
  chartLog.scale = { logical: null, lastIdx: 0, time: '2025-09-17' };
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
    await waitFor(() =>
      expect(chartLog.watermarks).toEqual([
        'Fed 利率 vs 通膨年增（%）｜虛線 2% 目標',
        '實質＝Fed − 核心CPI（pp）｜虛線 +1 緊縮、0 中性',
        'S&P 500（對數）｜線色＝Fed 階段（見圖例、下表）',
      ]),
    );
    // 圖內不畫名稱方框、軸上不放最新值標籤（短區間會壓住刻度）；參考線也不佔軸標籤
    expect(chartLog.series).toEqual([
      { pane: 0, title: undefined, label: false },
      { pane: 0, title: undefined, label: false },
      { pane: 0, title: undefined, label: false },
      { pane: 0, title: undefined, label: false },
      { pane: 1, title: undefined, label: false },
      { pane: 2, title: undefined, label: false },
    ]);
    expect(chartLog.priceLines).toEqual([
      { price: 2, title: undefined, axis: false },
      { price: 0, title: undefined, axis: false },
      { price: 1, title: undefined, axis: false },
    ]);
    // 圖內標籤（右側留白一欄）：2% 目標＋各線線尾最新值（只標數字：Fed、目標、核心、CPI、2Y）；讀數列有核心距 2%
    // 下面各格也標線尾值：實質利率線的最後一點是 2025-09 月底（Fed 4.25 − 核心 3.0），與頁首「最新 Fed」讀數 +1.10 不同屬正常
    expect(chartLog.labels).toEqual([['4.10', '2%', '3.0', '4.0', '3.70'], ['+1.25'], ['6,700']]);
    expect(document.querySelector('.cm-legend')!.textContent).toMatch(/實質 \+1\.10pp ｜ 緊縮（≥ \+1pp） ｜ 核心距 2% \+1\.00pp/);
    expect(screen.getByRole('button', { name: '整體 CPI' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '核心 PCE' }).getAttribute('aria-pressed')).toBe('false');
    // 美債 2Y 預設開：圖例顯示 2Y 與 2Y−Fed（3.70 − 4.10 = −0.40pp → 市場押降息）
    expect(screen.getByRole('button', { name: '美債 2Y' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.cm-legend')!.textContent).toMatch(/美債2Y 3\.70% ｜ 2Y−Fed -0\.40pp ｜ 市場押降息/);
    // S&P 窗格預設開：圖例顯示 S&P 與階段（2025-09-18 降息 −25bp → 降息期）、階段表與循環表
    expect(document.querySelector('.cm-legend')!.textContent).toMatch(/S&P 500 6,700 ｜ 降息期 ｜ 上次動作 2025-10-15 -15bp（0 個月前）/);
    expect(document.querySelector('section > .table-wrap .bt-table tr.hl')!.textContent).toMatch(/降息期/);
    // 四個指數並排：表頭 S&P／NASDAQ／費半／加權，目前指數的表頭標 hl
    expect([...document.querySelectorAll('section > .table-wrap .bt-table thead th')].slice(1, 5).map((th) => th.textContent)).toEqual(['S&P', 'NASDAQ', '費半', '加權']);
    expect(document.querySelector('section > .table-wrap .bt-table thead th.hl')!.textContent).toBe('S&P');
    expect(screen.getByRole('button', { name: /歷次循環起點・S&P 500（1）/ })).toBeTruthy();
    // 降息性質判定：Sahm 0（失業率持平）、Baa−10Y 1.60pp 正常（HY 330bp 只顯示）、核心 CPI 距目標 +1.00pp（不超過 1）→ 預防性
    // Fed 立場卡：測試資料沒有自然失業率 → 泰勒那格無資料，其餘兩把尺照常
    expect(document.querySelector('.fs .fs-verdict')!.textContent).toMatch(/實質利率偏緊、市場押降息$/);
    expect(document.querySelector('.fs')!.textContent).toContain('無資料');
    const cr = document.querySelector('.cr')!;
    expect(cr.querySelector('.cr-verdict')!.textContent).toMatch(/Fed 階段：降息期｜這次降息依目前讀數是 ?預防性$/);
    const crRows = [...cr.querySelectorAll('.cr-table tbody tr')].map((tr) => tr.textContent);
    expect(crRows[0]).toMatch(/就業.*0\.00pp.*正常/);
    expect(crRows[1]).toMatch(/信用 Baa−10Y 2025-10-14.*1\.60pp.*正常/);
    expect(crRows[2]).toMatch(/HY 利差 2025-10-14.*330bp.*正常/);
    expect(crRows[3]).toMatch(/通膨.*\+1\.00pp.*可降/);
    expect(crRows[4]).toMatch(/節奏.*上次動作 2025-10-15 -15bp.*-40bp/);
    expect(screen.getByRole('button', { name: /歷次第一次降息・當時判定（1）/ })).toBeTruthy();
  });

  it('第三格切到加權會換線與圖例、記住選擇；「關」移除第三窗格與表格', async () => {
    render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.series.length).toBe(6));
    fireEvent.click(screen.getByRole('button', { name: '加權' }));
    await waitFor(() => expect(chartLog.series.length).toBe(12));
    expect(window.localStorage.getItem('pi-idx')).toBe('taiex');
    expect(chartLog.watermarks.at(-1)).toBe('加權（對數）｜線色＝Fed 階段（見圖例、下表）');
    expect(document.querySelector('.cm-legend')!.textContent).toMatch(/加權 26,000 ｜ 降息期/);
    expect(document.querySelector('section > .table-wrap .bt-table thead th.hl')!.textContent).toBe('加權');
    fireEvent.click(screen.getByRole('button', { name: '關' }));
    await waitFor(() => expect(chartLog.series.length).toBe(17));
    expect(window.localStorage.getItem('pi-idx')).toBe('off');
    expect(document.querySelector('section > .table-wrap .bt-table')).toBeNull();
    // 降息性質判定不隨第三格關閉（資料仍在）
    expect(document.querySelector('.cr .cr-table')).toBeTruthy();
    expect(document.querySelector('.cm-legend')!.textContent).not.toMatch(/降息期/);
  });

  it('關掉美債 2Y 會移除序列與圖例列', async () => {
    render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.series.length).toBe(6));
    fireEvent.click(screen.getByRole('button', { name: '美債 2Y' }));
    await waitFor(() => expect(chartLog.series.length).toBe(11));
    expect(window.localStorage.getItem('pi-2y')).toBe('0');
    expect(document.querySelector('.cm-legend')!.textContent).not.toMatch(/美債2Y/);
  });

  it('第四格 DXY／USD/TWD 各自開關：都關不顯示、開一條畫原始價位、兩條都開改累計 %，選擇記住', async () => {
    FILES.dxy = series('dxy', [flat('2025-07-15', 100), flat('2025-10-15', 102)]);
    FILES.usdtwd = series('usdtwd', [flat('2025-07-15', 30), flat('2025-10-15', 31)]);
    // FRED 為主（到 2025-07-15＝30），Yahoo 只補之後的 2025-10-15＝31
    FILES.usdtwd_legacy = series('usdtwd_legacy', [flat('2025-01-02', 33), flat('2025-07-15', 30)]);
    try {
      render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
      await waitFor(() => expect(chartLog.series.length).toBe(6));
      const dxyBtn = screen.getByRole('button', { name: 'DXY' });
      const twdBtn = screen.getByRole('button', { name: 'USD/TWD' });
      expect([dxyBtn.getAttribute('aria-pressed'), twdBtn.getAttribute('aria-pressed')]).toEqual(['false', 'false']);
      expect(document.querySelector('.pi-host')!.className).not.toMatch(/pi-host-4/);
      // 回測表不必開第四格就有
      await waitFor(() => expect(document.body.textContent).toMatch(/升息 × 台幣 vs 加權/));

      // 只開 USD/TWD：第四格一條原始價位線、沒有 0% 線
      fireEvent.click(twdBtn);
      await waitFor(() => expect(chartLog.series.length).toBe(13));
      expect(chartLog.series.at(-1)).toEqual({ pane: 3, title: undefined, label: false });
      expect(chartLog.watermarks.at(-1)).toBe('USD/TWD（元）｜往上＝台幣貶');
      expect(chartLog.priceLines.filter((l) => l.price === 0).length).toBe(2);
      expect(window.localStorage.getItem('pi-fx-twd')).toBe('1');
      // 5 年區間起點早於資料 → 基準＝台幣第一筆 2025-01-02＝33；33 → 31
      expect(document.querySelector('.cm-legend')!.textContent).toMatch(/USD\/TWD 31\.00\s+｜ 自 1\/2 起 -6\.1%（台幣升）/);
      expect(document.querySelector('.pi-host')!.className).toMatch(/pi-host-4/);

      // 再開 DXY：兩條累計 % 同一刻度＋0% 虛線；共同基準＝較晚開始的 DXY 第一筆（2025-07-15）；台幣 30 → 31
      fireEvent.click(dxyBtn);
      await waitFor(() => expect(chartLog.series.length).toBe(21));
      expect(chartLog.series.slice(-2)).toEqual([
        { pane: 3, title: undefined, label: false },
        { pane: 3, title: undefined, label: false },
      ]);
      expect(chartLog.watermarks.at(-1)).toBe('美元／台幣 累計 %｜藍線往上＝台幣貶');
      expect(chartLog.priceLines.at(-1)).toEqual({ price: 0, title: undefined, axis: false });
      expect(document.querySelector('.cm-legend')!.textContent).toMatch(/DXY \+2\.0% ｜\s+USD\/TWD \+3\.3%（31\.00） ｜ 台幣貶/);
      expect(window.localStorage.getItem('pi-fx-dxy')).toBe('1');

      // 關掉 USD/TWD：只剩 DXY 原始點數
      fireEvent.click(twdBtn);
      await waitFor(() => expect(chartLog.series.length).toBe(28));
      expect(chartLog.watermarks.at(-1)).toBe('DXY 美元指數（點）');
      expect(document.querySelector('.cm-legend')!.textContent).toMatch(/DXY 102\.00/);
      expect(window.localStorage.getItem('pi-fx-twd')).toBe('0');
    } finally {
      delete FILES.dxy;
      delete FILES.usdtwd;
      delete FILES.usdtwd_legacy;
    }
  });

  it('核心 CPI 可關：少一條線、2% 目標線仍在、實質仍以核心 CPI 計並註明，選擇記住；整體 CPI 是實線', async () => {
    render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.series.length).toBe(6));
    // 上窗格沒有任何虛線序列（虛線只留給 2% 目標參考線）
    expect(chartLog.styles.some((s) => s.dashed)).toBe(false);
    const core = screen.getByRole('button', { name: '核心 CPI' });
    expect(core.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.cm-legend')!.textContent).not.toMatch(/線已關/);
    fireEvent.click(core);
    // 重建圖表：6 條 → 少核心 CPI 剩 5 條
    await waitFor(() => expect(chartLog.series.length).toBe(11));
    expect(window.localStorage.getItem('pi-core')).toBe('0');
    expect(screen.getByRole('button', { name: '核心 CPI' }).getAttribute('aria-pressed')).toBe('false');
    // 2% 目標線掛在 Fed 序列，兩次建圖都有
    expect(chartLog.priceLines.filter((l) => l.price === 2).length).toBe(2);
    const legend = document.querySelector('.cm-legend')!.textContent ?? '';
    expect(legend).toMatch(/實質 \+1\.10pp ｜ 緊縮（≥ \+1pp） ｜ 核心距 2% \+1\.00pp ｜ 以核心CPI 3\.0% 計（線已關）/);
    expect(legend).not.toMatch(/Fed 4\.10% ｜ 核心CPI/);
    // 頁首讀數不受影響
    expect(document.querySelector('.pi-state')!.textContent).toMatch(/\+1\.10pp（Fed 4\.10% − 核心CPI 3\.0%）/);
  });

  it('線尾標籤的右側留白與上下錯開', () => {
    // 300px 寬放 1000 根＋60px 留白 → 每根 0.24px，留白 250 根；至少 2 根
    expect(rightGapBars(300, 1000, 60)).toBeCloseTo(250);
    expect(rightGapBars(300, 3, 60)).toBe(2);
    expect(rightGapBars(50, 100, 60)).toBe(2);
    // 量不到字寬時每字 7px：'Fed 4.10' 8 字 → 56＋邊距 17
    expect(endLabelGapPx(['Fed 4.10', '2Y 3.70'], 'sans-serif')).toBe(73);
    // 不擠：原位；兩個擠在一起：往下推開；頂到下緣：整組往上
    expect(stackYs([20, 60], 17, 9, 191)).toEqual([20, 60]);
    expect(stackYs([50, 55, 120], 17, 9, 191)).toEqual([50, 67, 120]);
    expect(stackYs([180, 185, 190], 17, 9, 191)).toEqual([157, 174, 191]);
  });

  it('標籤欄左緣落在哪一根：最新一根還在左緣內＝不跟（null），往左拖曳後回傳那一根', () => {
    const scale = (logical: number | null, lastIdx: number | null) => ({
      width: () => 300,
      coordinateToLogical: (x: number) => (x === 250 ? logical : null),
      logicalToCoordinate: (i: number) => i * 2,
      coordinateToTime: (x: number) => `x${x}`,
      timeToIndex: () => lastIdx,
    });
    // 沒拖曳：最新一根（索引 125）剛好在左緣，浮點誤差少一點點也不算拖曳
    expect(followAnchor(scale(125, 125), 50)).toBeNull();
    expect(followAnchor(scale(124.99, 125), 50)).toBeNull();
    expect(followAnchor(scale(130, 125), 50)).toBeNull();
    // 往左拖了 40 根：左緣是第 85 根（x＝170），查時間時往左退一點（圖表庫會進位到下一根）
    expect(followAnchor(scale(85.4, 125), 50)).toEqual({ time: 'x169.5', x: 170 });
    // 量不到（圖表還沒排版）或沒有標籤欄
    expect(followAnchor(scale(null, 125), 50)).toBeNull();
    expect(followAnchor(scale(85, 125), 0)).toBeNull();
  });

  it('往左拖曳：讀數列與線尾標籤改標畫面右緣那一天、日期標 ◀、重設鈕變「回最新」', async () => {
    // 標籤欄左緣在第 5 根（2025-09-17）、最後一根是第 10 根
    chartLog.scale = { logical: 5, lastIdx: 10, time: '2025-09-17' };
    render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(document.querySelector('.pi-follow')).toBeTruthy());
    expect(document.querySelector('.pi-follow')!.textContent).toBe('◀ 2025-09-17');
    // 2025-09-17 當天：Fed 仍是 4.50（09-18 才降）、核心 CPI 3.0 → 實質 +1.50；S&P 6,600、還沒有美債 2Y 資料
    const legend = document.querySelector('.cm-legend')!.textContent ?? '';
    expect(legend).toMatch(/Fed 4\.50%/);
    expect(legend).toMatch(/實質 \+1\.50pp/);
    expect(legend).toMatch(/S&P 500 6,600/);
    expect(legend).not.toMatch(/美債2Y/);
    expect(screen.getByRole('button', { name: '回到最新資料' }).textContent).toBe('↻ 回最新');
    expect(screen.queryByRole('button', { name: '重設圖表縮放' })).toBeNull();
    // 頁首讀數不跟著動（永遠是最新）
    expect(document.querySelector('.pi-state')!.textContent).toMatch(/\+1\.10pp（Fed 4\.10% − 核心CPI 3\.0%）/);
    // 圖內標籤：每條線給那一天的數值；2% 目標固定不變；那天還沒有資料的線（2Y）不標
    const at = (p: (typeof chartLog.prims)[number]) => (p.labels ?? []).map((l) => (l.at ? (l.at('2025-09-17')?.text ?? null) : l.text));
    expect(chartLog.prims.slice(0, 3).map(at)).toEqual([['4.50', '2%', '3.0', '4.0', null], ['+1.50'], ['6,600']]);
  });

  it('切換核心 PCE 會加序列並記住；區間預設 5 年', async () => {
    render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
    await waitFor(() => expect(chartLog.series.length).toBe(6));
    fireEvent.click(screen.getByRole('button', { name: '核心 PCE' }));
    // 重建圖表：第一次 6 條（含 2Y、S&P），加 PCE 後 7 條
    await waitFor(() => expect(chartLog.series.length).toBe(13));
    expect(chartLog.series.every((s) => s.title === undefined)).toBe(true);
    expect(window.localStorage.getItem('pi-pce')).toBe('1');
    expect(screen.getByRole('button', { name: '5年' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(window.localStorage.getItem('pi-range')).toBe('ALL');
  });
  it('美債 10Y 開關（預設關）與第五格 GDP 成長率：讀數列常駐 10Y−2Y、GDP 年增與 GDPNow，選擇記住', async () => {
    FILES.us10y = series('us10y', [flat('2025-10-14', 4.1), flat('2025-10-15', 4.0)]);
    FILES.gdp = series('gdp', ['2024-10-01', '2025-01-01', '2025-04-01', '2025-07-01'].map((d) => flat(d, 2)));
    FILES.gdpnow = series('gdpnow', [flat('2025-07-01', 2.5), flat('2025-10-01', 2)]);
    try {
      render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
      await waitFor(() => expect(chartLog.series.length).toBe(6));
      const legend = () => document.querySelector('.cm-legend')!.textContent ?? '';
      // 10Y 線沒開，讀數仍在：10Y 4.00 − 2Y 3.70 = +0.30pp
      expect(screen.getByRole('button', { name: '美債 10Y' }).getAttribute('aria-pressed')).toBe('false');
      expect(legend()).toMatch(/美債10Y 4\.00% ｜ 10Y−2Y \+0\.30pp 偏平/);
      expect(legend()).toMatch(/GDP 年增 2\.0%（25Q3，季增年化 2\.0%）/);
      expect(legend()).toMatch(/GDPNow 25Q4 2\.0%（推估年增 2\.0%）/);
      fireEvent.click(screen.getByRole('button', { name: '美債 10Y' }));
      await waitFor(() => expect(chartLog.series.length).toBe(13));
      expect(window.localStorage.getItem('pi-10y')).toBe('1');

      // 第五格切 GDP：多兩條（年增階梯＋GDPNow 虛線），圖加高
      expect(screen.getByRole('button', { name: '關' , pressed: true })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'GDP 成長率' }));
      await waitFor(() => expect(chartLog.watermarks.at(-1)).toBe('美國實質GDP 年增（%，季）｜橘虛線＝GDPNow'));
      expect(chartLog.styles.at(-1)!.dashed).toBe(true);
      expect(window.localStorage.getItem('pi-p5')).toBe('gdp');
      expect(document.querySelector('.pi-host')!.className).toMatch(/pi-host-fc/);
    } finally {
      delete FILES.us10y;
      delete FILES.gdp;
      delete FILES.gdpnow;
    }
  });

  it('舊的外資開關 pi-fc=1 沿用成第五格「外資」', async () => {
    window.localStorage.setItem('pi-fc', '1');
    FILES.gdp = series('gdp', ['2024-10-01', '2025-01-01', '2025-04-01', '2025-07-01'].map((d) => flat(d, 2)));
    try {
      render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'GDP 成長率' })).toBeTruthy());
      // 沒有外資資料時外資鈕不出現，但記住的選擇不會被改掉
      expect(screen.queryByRole('button', { name: '外資買賣超' })).toBeNull();
      expect(window.localStorage.getItem('pi-p5')).toBeNull();
    } finally {
      delete FILES.gdp;
    }
  });
  it('第五格「油價」：WTI 接 FRED 舊資料、讀數列常駐 WTI、選擇記住', async () => {
    FILES.wti = series('wti', [flat('2025-10-14', 60), flat('2025-10-15', 62)]);
    FILES.wti_legacy = series('wti_legacy', [flat('2024-10-15', 40), flat('2025-10-14', 99)]);
    try {
      render(<PolicyInflationPanel version="v1" themeKey="auto-false-tw" />);
      await waitFor(() => expect(chartLog.series.length).toBe(6));
      // 舊資料只用 Yahoo 第一天之前：一年前 40 → 62＝+55.0%
      expect(document.querySelector('.cm-legend')!.textContent).toMatch(/WTI 62\.00 美元 ｜ 年增 \+55\.0%/);
      fireEvent.click(screen.getByRole('button', { name: '油價' }));
      await waitFor(() => expect(chartLog.watermarks.at(-1)).toBe('WTI 原油（美元／桶）'));
      expect(window.localStorage.getItem('pi-p5')).toBe('oil');
      expect(document.body.textContent).toMatch(/WTI，2024 起/);
    } finally {
      delete FILES.wti;
      delete FILES.wti_legacy;
    }
  });
});
