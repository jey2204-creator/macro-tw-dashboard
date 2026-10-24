// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SummaryFile } from '../src/shared/types';

// lightweight-charts 需要 canvas，jsdom 沒有：以假物件記錄序列、參考線與色帶
const log = {
  series: [] as { opts: Record<string, unknown>; data: { value: number; color?: string }[]; applied: Record<string, unknown>[] }[],
  priceLines: [] as { price: number; color: string; lineVisible?: boolean; title?: string }[],
  primitives: [] as unknown[],
};
vi.mock('lightweight-charts', () => {
  const makeChart = () => ({
    addSeries: (_type: unknown, opts: Record<string, unknown>) => {
      const rec = { opts, data: [] as { value: number; color?: string }[], applied: [] as Record<string, unknown>[] };
      log.series.push(rec);
      return {
        setData: (d: { value: number; color?: string }[]) => {
          rec.data = d;
        },
        applyOptions: (o: Record<string, unknown>) => rec.applied.push(o),
        attachPrimitive: (p: unknown) => log.primitives.push(p),
        createPriceLine: (o: { price: number; color: string; lineVisible?: boolean; title?: string }) => log.priceLines.push(o),
      };
    },
    removeSeries: () => {},
    panes: () => [{}],
    priceScale: () => ({ applyOptions: () => {} }),
    timeScale: () => ({
      fitContent: () => {},
      setVisibleRange: () => {},
      applyOptions: () => {},
      subscribeVisibleLogicalRangeChange: () => {},
      unsubscribeVisibleLogicalRangeChange: () => {},
      getVisibleLogicalRange: () => ({ from: 0, to: 11 }),
    }),
    subscribeCrosshairMove: () => {},
    unsubscribeCrosshairMove: () => {},
    applyOptions: () => {},
    remove: () => {},
  });
  return {
    createChart: () => makeChart(),
    LineSeries: 'Line',
    CandlestickSeries: 'Candle',
    HistogramSeries: 'Histogram',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2 },
  };
});

const { PriceChart } = await import('../src/components/PriceChart');
const { IndicatorTable } = await import('../src/components/IndicatorTable');
const { bandsFromZones, hexAlpha, ZoneBands } = await import('../src/lib/zoneBands');
const { coloredZones, getIndicator, INDICATORS, zoneAt } = await import('../src/shared/indicators');
const { computeRegime } = await import('../src/shared/regime');
const { buildRow } = await import('../src/lib/rows');

const LIGHT = {
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
  log.priceLines = [];
  log.primitives = [];
  for (const [k, v] of Object.entries(LIGHT)) document.documentElement.style.setProperty(k, v);
});
afterEach(cleanup);

const signal = getIndicator('tw_signal');
const zones = coloredZones(signal)!;
const months = (vals: number[]): Bar[] =>
  vals.map((v, i) => {
    const y = 2025 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    return [`${y}-${String(m).padStart(2, '0')}-01`, v, v, v, v];
  });

describe('景氣燈號分區與顏色', () => {
  it('五個燈號都有顏色；整數分數落在正確燈號（界線在 .5）', () => {
    expect(zones.map((z) => [z.label, z.color])).toEqual([
      ['藍燈', '--lamp-blue'],
      ['黃藍燈', '--lamp-yellowblue'],
      ['綠燈', '--lamp-green'],
      ['黃紅燈', '--lamp-yellowred'],
      ['紅燈', '--lamp-red'],
    ]);
    const label = (v: number) => zoneAt(zones, v)?.label;
    expect([9, 16, 17, 22, 23, 31, 32, 37, 38, 45].map(label)).toEqual([
      '藍燈', '藍燈', '黃藍燈', '黃藍燈', '綠燈', '綠燈', '黃紅燈', '黃紅燈', '紅燈', '紅燈',
    ]);
    // 有顏色分區的只有估值（S&P 本益比、日經預估本益比與淨值比、台股本益比、淨值比與預估本益比：便宜→昂貴，與燈號同一套冷→熱色）與景氣燈號；
    // 其他台灣指標（成長／衰退等）不上色
    expect(INDICATORS.filter((d) => coloredZones(d)).map((d) => d.id)).toEqual(['spx_pe', 'jp_fwd_pe', 'jp_pb', 'kr_pb', 'kr_pe', 'kr_fwd_pe', 'tw_pe', 'tw_pb', 'tw_fwd_pe', 'tw_signal']);
  });

  it('色帶：相鄰區間首尾相接，最上與最下延伸到圖邊', () => {
    const bands = bandsFromZones(zones, (v) => `fill(${v})`);
    expect(bands.map((b) => [b.from, b.to, b.color])).toEqual([
      [-Infinity, 16.5, 'fill(--lamp-blue)'],
      [16.5, 22.5, 'fill(--lamp-yellowblue)'],
      [22.5, 31.5, 'fill(--lamp-green)'],
      [31.5, 37.5, 'fill(--lamp-yellowred)'],
      [37.5, Infinity, 'fill(--lamp-red)'],
    ]);
    expect(hexAlpha('#d42f35', 0.1)).toBe('rgba(212, 47, 53, 0.1)');
    expect(hexAlpha(' #0E8A3A ', 0.2)).toBe('rgba(14, 138, 58, 0.2)');
    expect(hexAlpha('rgb(1,2,3)', 0.2)).toBe('rgb(1,2,3)');
  });

  it('淺色與兩個深色區塊都定義了五個燈號色與色帶透明度，且深色另外配色', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/styles.css'), 'utf8');
    for (const t of ['--lamp-blue', '--lamp-yellowblue', '--lamp-green', '--lamp-yellowred', '--lamp-red', '--lamp-band-alpha']) {
      const values = [...css.matchAll(new RegExp(`${t}:\\s*([^;]+);`, 'g'))].map((m) => m[1]!.trim());
      expect(values, t).toHaveLength(3);
      expect(values[1], t).toBe(values[2]);
      expect(values[0], t).not.toBe(values[1]);
    }
  });
});

describe('圖表（假圖表物件）', () => {
  const bars = months([30, 33, 36, 38, 39, 40, 41, 41, 41, 35, 22, 16]);
  const chart = (z = zones) =>
    render(
      <PriceChart
        bars={bars}
        kind="line"
        mas={[]}
        range="1Y"
        decimals={0}
        showPct={false}
        themeKey="t"
        refLines={signal.refLines}
        zones={z}
      />,
    );

  it('每個月的線段依燈號上色；最新值標籤＝最新燈號色；畫一組色帶', () => {
    chart();
    const line = log.series[0]!;
    expect(line.data.map((d) => d.color)).toEqual([
      '#0e8a3a', '#ec8b00', '#ec8b00', '#d42f35', '#d42f35', '#d42f35', '#d42f35', '#d42f35', '#d42f35', '#ec8b00', '#1fa6d0', '#1a64c8',
    ]);
    expect(line.opts.color).toBe('#1a64c8');
    expect(log.primitives).toHaveLength(1);
    expect(log.primitives[0]).toBeInstanceOf(ZoneBands);
    // 一年內（≤36 個月）每個月畫圓點
    expect(line.applied.at(-1)).toEqual({ pointMarkersVisible: true });
  });

  it('門檻標籤：不畫虛線、底色為該燈號色、文字為燈號名', () => {
    chart();
    expect(log.priceLines.map((p) => [p.price, p.title, p.color, p.lineVisible])).toEqual([
      [38, '紅燈', '#d42f35', false],
      [32, '黃紅燈', '#ec8b00', false],
      [23, '綠燈', '#0e8a3a', false],
      [17, '黃藍燈', '#1fa6d0', false],
      [16, '藍燈', '#1a64c8', false],
    ]);
  });

  it('讀值列顯示燈號名稱與色點（文字不單靠顏色）', () => {
    const { container } = chart();
    const tag = container.querySelector('.legend .zone-tag')!;
    expect(tag.textContent?.trim()).toBe('藍燈');
    expect((tag.querySelector('.lamp') as HTMLElement).style.background).toBe('var(--lamp-blue)');
  });

  it('沒有分區顏色的指標維持原樣：虛線參考線、不畫色帶、單一線色', () => {
    render(
      <PriceChart bars={bars} kind="line" mas={[]} range="1Y" decimals={0} showPct={false} themeKey="t" refLines={[{ value: 50, label: '榮枯線 50' }]} />,
    );
    expect(log.primitives).toHaveLength(0);
    expect(log.series[0]!.data.every((d) => d.color === undefined)).toBe(true);
    expect(log.priceLines[0]).toMatchObject({ price: 50, color: '#6b7380', lineVisible: true });
  });
});

describe('指標列', () => {
  const tail = (vals: number[]) => months(vals).map((b): [string, number] => [b[0], b[4]]);
  const summary: SummaryFile = {
    schemaVersion: 1,
    generatedAt: '2026-10-19T00:00:00Z',
    entries: {
      tw_signal: {
        id: 'tw_signal',
        source: { provider: 'tw_gov', symbol: 'NDC_SIGNAL', url: '' },
        status: 'ok',
        fetchedAt: '2026-10-19T00:00:00Z',
        lastSuccessAt: '2026-10-19T00:00:00Z',
        lastDate: '2026-08-01',
        closeOnly: true,
        partial: false,
        errors: [],
        tail: tail([...Array(11).fill(30), 38, 39, 40, 40, 40, 40, 41, 41, 41]),
      },
      tw_pmi: {
        id: 'tw_pmi',
        source: { provider: 'tw_gov', symbol: 'NDC_PMI', url: '' },
        status: 'ok',
        fetchedAt: '2026-10-19T00:00:00Z',
        lastSuccessAt: '2026-10-19T00:00:00Z',
        lastDate: '2026-09-01',
        closeOnly: true,
        partial: false,
        errors: [],
        tail: tail([...Array(9).fill(48), ...Array(12).fill(55)]),
      },
    },
  };

  it('景氣燈號列：依據文字前有目前燈號色點；PMI 列沒有', () => {
    const regime = computeRegime(summary, '2026-10-19');
    const rows = regime.evals.filter((e) => e.def.category === 'tw_macro').map((ev) => buildRow(ev, summary));
    const { container } = render(
      <IndicatorTable rows={rows} today="2026-10-19" selectedId={null} onSelect={() => {}} now={new Date('2026-10-19T11:00:00Z')} />,
    );
    const lamps = container.querySelectorAll('#sec-grp-tw_macro .c-reason .lamp');
    expect(lamps).toHaveLength(1);
    expect((lamps[0] as HTMLElement).style.background).toBe('var(--lamp-red)');
    expect(lamps[0]!.parentElement!.textContent).toBe('紅燈（連 9 個月），近3月變化 +1分');
  });
});
