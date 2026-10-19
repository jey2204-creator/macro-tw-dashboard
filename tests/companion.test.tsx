// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SeriesFile } from '../src/shared/types';

// lightweight-charts 需要 canvas，jsdom 沒有：記錄每個序列的窗格、資料顏色與窗格標籤
const log = {
  series: [] as { pane: number; opts: Record<string, unknown>; data: { time: string; value: number; color?: string }[] }[],
  watermarks: [] as string[],
  stretch: [] as number[],
  crosshair: null as null | ((p: { time?: string }) => void),
};
vi.mock('lightweight-charts', () => {
  const makeChart = () => {
    const panes: { setStretchFactor: (f: number) => void }[] = [];
    const ensure = (i: number) => {
      while (panes.length <= i) {
        const k = panes.length;
        panes.push({ setStretchFactor: (f: number) => (log.stretch[k] = f) });
      }
    };
    ensure(0);
    return {
      addSeries: (_type: unknown, opts: Record<string, unknown>, pane = 0) => {
        ensure(pane);
        const rec = { pane, opts, data: [] as { time: string; value: number; color?: string }[] };
        log.series.push(rec);
        return {
          setData: (d: { time: string; value: number; color?: string }[]) => (rec.data = d),
          applyOptions: () => {},
          attachPrimitive: () => {},
          createPriceLine: () => {},
        };
      },
      removeSeries: () => {},
      panes: () => panes,
      priceScale: () => ({ applyOptions: () => {} }),
      timeScale: () => ({
        fitContent: () => {},
        setVisibleRange: () => {},
        applyOptions: () => {},
        subscribeVisibleLogicalRangeChange: () => {},
        unsubscribeVisibleLogicalRangeChange: () => {},
        getVisibleLogicalRange: () => ({ from: 0, to: 11 }),
      }),
      subscribeCrosshairMove: (h: (p: { time?: string }) => void) => (log.crosshair = h),
      unsubscribeCrosshairMove: () => {},
      applyOptions: () => {},
      remove: () => {},
    };
  };
  return {
    createChart: () => makeChart(),
    createTextWatermark: (_pane: unknown, o: { lines: { text: string }[] }) => {
      log.watermarks.push(o.lines[0]!.text);
      return { detach: () => {} };
    },
    LineSeries: 'Line',
    CandlestickSeries: 'Candle',
    HistogramSeries: 'Histogram',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2 },
  };
});

const { PriceChart } = await import('../src/components/PriceChart');
const { ChartPanel } = await import('../src/components/ChartPanel');
const { monthlyCloses, shortMonth, zoneStreaks } = await import('../src/lib/companion');
const { coloredZones, getIndicator } = await import('../src/shared/indicators');
const { computeRegime } = await import('../src/shared/regime');

const COLORS = {
  '--lamp-blue': '#1a64c8',
  '--lamp-yellowblue': '#1fa6d0',
  '--lamp-green': '#0e8a3a',
  '--lamp-yellowred': '#ec8b00',
  '--lamp-red': '#d42f35',
  '--lamp-band-alpha': '0.1',
  '--text-1': '#101317',
  '--text-3': '#6b7380',
};
beforeEach(() => {
  log.series = [];
  log.watermarks = [];
  log.stretch = [];
  log.crosshair = null;
  for (const [k, v] of Object.entries(COLORS)) document.documentElement.style.setProperty(k, v);
});
afterEach(cleanup);

const signal = getIndicator('tw_signal');
const zones = coloredZones(signal)!;
const flat = (d: string, v: number): Bar => [d, v, v, v, v];
const month = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}-01`;

describe('月底收盤與燈號期間', () => {
  it('日 K → 月底收盤，日期記為當月 1 日；記住最新交易日', () => {
    const m = monthlyCloses([flat('2026-07-30', 100), flat('2026-07-31', 110), flat('2026-08-29', 121), flat('2026-10-19', 130)]);
    expect(m.bars).toEqual([flat('2026-07-01', 110), flat('2026-08-01', 121), flat('2026-10-01', 130)]);
    expect(m.lastDate).toBe('2026-10-19');
    expect(shortMonth('2025-12-01')).toBe('25/12');
  });

  it('連續同燈號合成一段；漲跌＝最後月底 ÷ 前一個月底；燈號未公布的月份另列一段', () => {
    const score: [string, number][] = [
      [month(2025, 10), 33],
      [month(2025, 11), 36],
      [month(2025, 12), 38],
      [month(2026, 1), 41],
      [month(2026, 2), 40],
    ];
    const taiex: [string, number][] = [
      [month(2025, 9), 100],
      [month(2025, 10), 105],
      [month(2025, 11), 110],
      [month(2025, 12), 120],
      [month(2026, 1), 126],
      [month(2026, 2), 132],
      [month(2026, 3), 125.4],
      [month(2026, 4), 138],
    ];
    const st = zoneStreaks(score, zones, taiex);
    expect(st.map((s) => [s.zone?.label ?? '未公布', s.from, s.to, s.months, s.change?.toFixed(1)])).toEqual([
      ['未公布', month(2026, 3), month(2026, 4), 2, '4.5'],
      ['紅燈', month(2025, 12), month(2026, 2), 3, '20.0'],
      ['黃紅燈', month(2025, 10), month(2025, 11), 2, '10.0'],
    ]);
  });

  it('缺前一個月的對照資料時漲跌為 null；月份不連續就拆段', () => {
    const st = zoneStreaks([[month(2026, 1), 41], [month(2026, 3), 41]], zones, [[month(2026, 1), 10], [month(2026, 3), 12]]);
    expect(st.map((s) => [s.from, s.months, s.change])).toEqual([
      [month(2026, 3), 1, null],
      [month(2026, 1), 1, null],
    ]);
  });
});

describe('圖表：加權在上、燈號在下', () => {
  const score = [flat(month(2026, 5), 39), flat(month(2026, 6), 37), flat(month(2026, 7), 41), flat(month(2026, 8), 41)];
  const taiex = { label: '加權指數', bars: [flat(month(2026, 5), 40000), flat(month(2026, 6), 41000), flat(month(2026, 7), 44366), flat(month(2026, 8), 46128), flat(month(2026, 9), 45000), flat(month(2026, 10), 46822)], lastDate: '2026-10-19' };

  it('加權在窗格 0、燈號在窗格 1；加權每段線用「這段漲跌所屬月份」的燈號色，未公布月份灰色', () => {
    render(<PriceChart bars={score} kind="line" mas={[]} range="1Y" decimals={0} showPct={false} themeKey="t" zones={zones} companion={taiex} mainLabel="景氣燈號" />);
    const main = log.series.find((s) => s.pane === 1)!;
    const comp = log.series.find((s) => s.pane === 0)!;
    expect(main.data.map((d) => d.value)).toEqual([39, 37, 41, 41]);
    // 第 i 點的顏色＝第 i+1 個月的燈號（5→6 月漲跌屬 6 月＝黃紅…；8→9、9→10 未公布）
    expect(comp.data.map((d) => d.color)).toEqual(['#ec8b00', '#d42f35', '#d42f35', '#6b7380', '#6b7380', '#6b7380']);
    expect(log.watermarks).toEqual(['加權指數（月底）｜線色＝當月燈號', '景氣燈號']);
    expect(log.stretch).toEqual([0.42, 0.58]);
  });

  it('讀值列：預設最新燈號月份＋同月加權；移到未公布月份顯示「燈號尚未公布」與加權至今', () => {
    const { container } = render(
      <PriceChart bars={score} kind="line" mas={[]} range="1Y" decimals={0} showPct={false} themeKey="t" zones={zones} companion={taiex} mainLabel="景氣燈號" />,
    );
    const legend = () => container.querySelector('.legend')!.textContent!.replace(/\s+/g, ' ');
    expect(legend()).toContain('2026-08');
    expect(legend()).toContain('紅燈');
    expect(legend()).toContain('加權指數 46,128 月 +4.0%');
    act(() => log.crosshair!({ time: month(2026, 10) }));
    expect(legend()).toContain('2026-10 燈號尚未公布');
    expect(legend()).toContain('加權指數 46,822 月 +4.0%（至 10/19）');
  });

  it('沒有對照時維持單一窗格', () => {
    render(<PriceChart bars={score} kind="line" mas={[]} range="1Y" decimals={0} showPct={false} themeKey="t" zones={zones} />);
    expect(log.series.every((s) => s.pane === 0)).toBe(true);
    expect(log.watermarks).toEqual([]);
  });
});

describe('景氣燈號圖表面板（載入加權指數）', () => {
  const file = (id: string, data: Bar[]): SeriesFile => ({
    id,
    source: { provider: 'x', symbol: id, url: '' },
    status: 'ok',
    fetchedAt: '2026-10-19T00:00:00Z',
    lastSuccessAt: '2026-10-19T00:00:00Z',
    lastDate: data.at(-1)![0],
    closeOnly: true,
    partial: false,
    errors: [],
    data,
  });
  const months = Array.from({ length: 14 }, (_, i) => month(2025 + Math.floor((i + 6) / 12), ((i + 6) % 12) + 1)); // 2025-07 … 2026-08
  const sigVals = [30, 30, 33, 35, 37, 38, 39, 40, 39, 40, 41, 41, 41, 41];
  const FILES: Record<string, SeriesFile> = {
    tw_signal: file('tw_signal', months.map((d, i) => flat(d, sigVals[i]!))),
    taiex: file('taiex', [...months.map((d, i) => flat(`${d.slice(0, 8)}28`, 20000 + i * 1000)), flat('2026-09-30', 34000), flat('2026-10-19', 35000)]),
  };

  it('表格列出每段燈號期間的加權漲跌，最上面是未公布月份', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      const id = /series\/(\w+)\.json/.exec(url)?.[1] ?? '';
      const f = FILES[id];
      return Promise.resolve(f ? new Response(JSON.stringify(f)) : new Response('nf', { status: 404 }));
    });
    const summary = { schemaVersion: 1 as const, generatedAt: 'v-companion', entries: {} };
    const ev = computeRegime(summary, '2026-10-19').evals.find((e) => e.def.id === 'tw_signal')!;
    render(
      <ChartPanel
        def={signal}
        ev={ev}
        entry={undefined}
        version="v-companion"
        prefs={{ period: 'D', range: '1Y', mas: [] }}
        onPrefs={() => {}}
        onClose={() => {}}
        themeKey="t"
      />,
    );
    await waitFor(() => expect(screen.getByText('燈號期間')).toBeTruthy());
    const rows = [...document.querySelectorAll('.streak-table tbody tr')].map((tr) => tr.textContent);
    // 未公布 9–10 月：35000 ÷ 33000（8 月底）− 1 ＝ +6.1%；紅燈 25/12–26/08（9 個月）：33000 ÷ 24000（11 月底）− 1 ＝ +37.5%；黃紅 24000 ÷ 21000 − 1 ＝ +14.3%
    expect(rows[0]).toBe('未公布26/09–至今2+6.1%');
    expect(rows[1]).toBe('紅燈25/12–26/089+37.5%');
    expect(rows[2]).toBe('黃紅燈25/09–25/113+14.3%');
    expect(rows[3]).toBe('綠燈25/07–25/082—');
    vi.unstubAllGlobals();
  });
});

describe('漲跌顯示', () => {
  it('四捨五入後為 0 顯示「0.0%」、不上色；缺資料顯示「—」', async () => {
    const { pctSign, pctText } = await import('../src/lib/companion');
    expect([pctText(-0.04), pctSign(-0.04)]).toEqual(['0.0%', 0]);
    expect([pctText(67.04), pctSign(67.04)]).toEqual(['+67.0%', 1]);
    expect([pctText(-12.2), pctSign(-12.2)]).toEqual(['-12.2%', -1]);
    expect([pctText(null), pctSign(null)]).toEqual(['—', 0]);
  });
});
