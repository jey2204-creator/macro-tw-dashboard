import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createTextWatermark,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import { CHART_INTERACTION, resetPriceScales, attachTimeAxis, TIME_AXIS } from '../lib/chartInteraction';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MA_PERIODS, rangeStart, sma, type MaPeriod, type RangeKey } from '../shared/timeseries';
import type { Bar } from '../shared/types';
import { MA_COLOR_VAR, type ChartKind } from '../lib/chartData';
import { bandsFromZones, hexAlpha, ZoneBands } from '../lib/zoneBands';
import type { Companion } from '../lib/companion';
import { toneClass, zoneAt, type Zone } from '../shared/indicators';


interface Props {
  bars: Bar[];
  kind: ChartKind;
  mas: MaPeriod[];
  range: RangeKey;
  decimals: number;
  /** 圖例是否顯示百分比變化（利率、年增率等百分比單位不顯示） */
  showPct: boolean;
  /** 讀取 CSS 變數的觸發鍵（主題或漲跌色改變時重新套用） */
  themeKey: string;
  /** 水平參考線 */
  refLines?: { value: number; label: string }[];
  /** 數值越大越偏空（跌停家數等）：柱狀圖與圖例改用空方色 */
  bearish?: boolean;
  /** 有顏色的分區（景氣燈號）：背景色帶、線段依區間上色、參考線標籤上色、讀值顯示區間名稱 */
  zones?: Zone[];
  /** 上方另開一格對照（景氣燈號 vs 加權指數月底收盤），同一時間軸；本指標移到下方窗格 */
  companion?: Companion;
  /** 下方窗格名稱（有對照窗格時顯示） */
  mainLabel?: string;
}

/** 對照窗格／本指標窗格的高度比例 */
const COMPANION_STRETCH = [0.42, 0.58] as const;

/** 放大到這個月數以內（約 3 年）才在每個點畫圓點，避免長期圖點擠成一團 */
const POINT_MARKER_MAX_BARS = 36;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

interface Hover {
  bar: Bar;
  prevClose: number | null;
  ma: Partial<Record<MaPeriod, number | null>>;
}

export function PriceChart({ bars, kind, mas, range, decimals, showPct, themeKey, refLines, bearish, zones, companion, mainLabel }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType>[]>([]);
  const watermarksRef = useRef<{ detach: () => void }[]>([]);
  /** 十字線所在的時間（null＝沒在讀值，顯示最新一期） */
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const comp = companion && companion.bars.length > 0 ? companion : undefined;
  const compIndex = useMemo(() => new Map((comp?.bars ?? []).map((b, i) => [b[0], i])), [comp]);

  const maData = useMemo(() => {
    const closes = bars.map((b) => b[4]);
    return Object.fromEntries(MA_PERIODS.map((p) => [p, sma(closes, p)])) as Record<MaPeriod, (number | null)[]>;
  }, [bars]);

  const indexByDate = useMemo(() => new Map(bars.map((b, i) => [b[0], i])), [bars]);

  const hoverAt = useMemo(
    () =>
      (i: number): Hover | null => {
        const bar = bars[i];
        if (!bar) return null;
        return {
          bar,
          prevClose: i > 0 ? bars[i - 1]![4] : null,
          ma: Object.fromEntries(mas.map((p) => [p, maData[p][i] ?? null])),
        };
      },
    [bars, mas, maData],
  );

  // 建立圖表（只做一次）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd' },
      timeScale: { ...TIME_AXIS, rightOffset: 2, fixLeftEdge: true, fixRightEdge: true, minBarSpacing: 0.2 },
      ...CHART_INTERACTION,
      rightPriceScale: { autoScale: true, scaleMargins: { top: 0.12, bottom: 0.06 } },
    });
    attachTimeAxis(chart);
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
      watermarksRef.current = [];
    };
  }, []);

  // 主題色
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const grid = cssVar('--grid');
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: cssVar('--surface') },
        textColor: cssVar('--text-2'),
        fontSize: 11,
        fontFamily: getComputedStyle(document.body).fontFamily,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid },
    });
    chart.applyOptions({ layout: { panes: { separatorColor: cssVar('--border') } } });
  }, [themeKey]);

  // 資料與均線
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const w of watermarksRef.current) w.detach();
    watermarksRef.current = [];
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];
    // 有對照窗格時：對照在上（窗格 0）、本指標在下（窗格 1）
    const pane = comp ? 1 : 0;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const priceFormat = { type: 'price' as const, precision: decimals, minMove: 1 / 10 ** decimals };

    if (kind === 'candle') {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: up,
        downColor: down,
        borderUpColor: up,
        borderDownColor: down,
        wickUpColor: up,
        wickDownColor: down,
        priceFormat,
      }, pane);
      s.setData(bars.map((b) => ({ time: b[0] as Time, open: b[1], high: b[2], low: b[3], close: b[4] })));
      seriesRef.current.push(s);
    } else if (kind === 'histogram') {
      const s = chart.addSeries(HistogramSeries, { priceFormat }, pane);
      s.setData(bars.map((b) => ({ time: b[0] as Time, value: b[4], color: (b[4] >= 0) !== !!bearish ? up : down })));
      seriesRef.current.push(s);
    } else if (zones) {
      // 景氣燈號：每個月的線段依燈號上色；序列主色＝最新一期的燈號色（右側最新值標籤）
      const base = cssVar('--text-1');
      const colorOf = (v: number) => {
        const z = zoneAt(zones, v);
        return z?.color ? cssVar(z.color) : base;
      };
      const last = bars.at(-1);
      const s = chart.addSeries(LineSeries, {
        color: last ? colorOf(last[4]) : base,
        lineWidth: 2,
        pointMarkersRadius: 3,
        priceFormat,
      }, pane);
      s.setData(bars.map((b) => ({ time: b[0] as Time, value: b[4], color: colorOf(b[4]) })));
      const alpha = Number.parseFloat(cssVar('--lamp-band-alpha')) || 0.1;
      s.attachPrimitive(new ZoneBands(bandsFromZones(zones, (v) => hexAlpha(cssVar(v), alpha))));
      seriesRef.current.push(s);
    } else {
      const s = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat }, pane);
      s.setData(bars.map((b) => ({ time: b[0] as Time, value: b[4] })));
      seriesRef.current.push(s);
    }

    // 參考線（例如融資維持率 130／140／170%），以文字標籤標示，不單靠顏色；
    // 有色帶時（景氣燈號）不畫虛線，只留右側標籤，標籤底色＝該燈號色
    const main = seriesRef.current[0];
    for (const r of refLines ?? []) {
      const z = zones ? zoneAt(zones, r.value) : undefined;
      main?.createPriceLine({
        price: r.value,
        color: z?.color ? cssVar(z.color) : cssVar('--text-3'),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lineVisible: !z?.color,
        axisLabelVisible: true,
        title: r.label,
      });
    }

    // 對照窗格（加權指數月底收盤）：每段線＝某個月的漲跌，顏色＝那個月的燈號；燈號尚未公布的月份用灰色
    if (comp) {
      const neutral = cssVar('--text-3');
      const scoreAt = new Map(bars.map((b) => [b[0], b[4]]));
      // 圖表庫用「起點」的顏色畫到下一點，所以第 i 點帶第 i+1 個月（這段漲跌所屬月份）的燈號色
      const segColor = (i: number) => {
        const next = comp.bars[i + 1];
        const v = next ? scoreAt.get(next[0]) : undefined;
        const z = v === undefined ? undefined : zoneAt(zones, v);
        return z?.color ? cssVar(z.color) : neutral;
      };
      const cs = chart.addSeries(
        LineSeries,
        { color: cssVar('--text-1'), lineWidth: 2, priceLineVisible: false, priceFormat: { type: 'price', precision: 0, minMove: 1 } },
        0,
      );
      cs.setData(comp.bars.map((b, i) => ({ time: b[0] as Time, value: b[4], color: segColor(i) })));
      seriesRef.current.push(cs);
      const panes = chart.panes();
      const textColor = cssVar('--text-3');
      const fontFamily = getComputedStyle(document.body).fontFamily;
      const label = (i: number, text: string) => {
        const p = panes[i];
        if (!p) return;
        watermarksRef.current.push(
          createTextWatermark(p, { horzAlign: 'left', vertAlign: 'top', lines: [{ text, color: textColor, fontSize: 11, fontFamily, fontStyle: '' }] }),
        );
        p.setStretchFactor(COMPANION_STRETCH[i] ?? 0.5);
      };
      label(0, `${comp.label}（月底）${zones ? '｜線色＝當月燈號' : ''}`);
      label(1, mainLabel ?? '');
    }

    // 放大到約 3 年內，每個月畫一個燈號色圓點
    let unsubscribe: (() => void) | undefined;
    if (zones && main && kind === 'line') {
      const ts = chart.timeScale();
      const update = () => {
        const lr = ts.getVisibleLogicalRange();
        main.applyOptions({ pointMarkersVisible: lr !== null && lr.to - lr.from <= POINT_MARKER_MAX_BARS });
      };
      update();
      ts.subscribeVisibleLogicalRangeChange(update);
      unsubscribe = () => ts.unsubscribeVisibleLogicalRangeChange(update);
    }

    for (const p of mas) {
      const vals = maData[p];
      const s = chart.addSeries(LineSeries, {
        color: cssVar(MA_COLOR_VAR[p]),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat,
      }, pane);
      s.setData(
        bars.flatMap((b, i) => (vals[i] === null || vals[i] === undefined ? [] : [{ time: b[0] as Time, value: vals[i]! }])),
      );
      seriesRef.current.push(s);
    }
    return unsubscribe;
  }, [bars, kind, mas, maData, decimals, themeKey, refLines, bearish, zones, comp, mainLabel]);

  // 時間區間
  useEffect(() => {
    const chart = chartRef.current;
    // 有對照窗格時，時間範圍涵蓋兩者（加權比燈號多 1–2 個月）
    const dates = [bars.at(-1)?.[0], comp?.bars.at(-1)?.[0]].filter((d): d is string => !!d).sort();
    const firsts = [bars[0]?.[0], comp?.bars[0]?.[0]].filter((d): d is string => !!d).sort();
    const last = dates.at(-1);
    if (!chart || !last) return;
    const start = rangeStart(last, range);
    resetPriceScales(chart);
    if (!start || start <= firsts[0]!) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleRange({ from: start as Time, to: last as Time });
  }, [bars, range, kind, mas, comp]);

  // 十字線讀值
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (param: MouseEventParams<Time>) => {
      setHoverTime(typeof param.time === 'string' ? param.time : null);
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, []);

  // 讀值：十字線所在時間；沒有本指標資料的時間（燈號尚未公布的月份）只顯示對照窗格
  const hoverIdx = hoverTime ? indexByDate.get(hoverTime) : undefined;
  const shown = hoverIdx !== undefined ? hoverAt(hoverIdx) : hoverTime && comp ? null : hoverAt(bars.length - 1);
  const shownTime = hoverTime && (hoverIdx !== undefined || comp) ? hoverTime : (bars.at(-1)?.[0] ?? null);
  const ci = shownTime ? compIndex.get(shownTime) : undefined;
  const compBar = ci !== undefined ? comp!.bars[ci]! : null;
  const compPrev = ci !== undefined && ci > 0 ? comp!.bars[ci - 1]![4] : null;
  const compPct = compBar && compPrev ? (compBar[4] / compPrev - 1) * 100 : null;
  const compIsLast = ci !== undefined && ci === comp!.bars.length - 1;
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const chg = shown && shown.prevClose !== null ? shown.bar[4] - shown.prevClose : null;
  const chgPct = chg !== null && shown?.prevClose ? (chg / Math.abs(shown.prevClose)) * 100 : null;

  return (
    <div className="pricechart">
      {(shown || compBar) && (
        <div className="legend num" aria-live="off">
          <div>
            <span className="muted">{comp && shownTime ? shownTime.slice(0, 7) : shown?.bar[0]}</span>{' '}
            {!shown ? (
              <span className="muted">燈號尚未公布</span>
            ) : kind === 'candle' ? (
              <>
                開 {fmt(shown.bar[1])} 高 {fmt(shown.bar[2])} 低 {fmt(shown.bar[3])} 收 <b>{fmt(shown.bar[4])}</b>
              </>
            ) : (
              <b>{fmt(shown.bar[4])}</b>
            )}{' '}
            {shown && zones && <ZoneTag zones={zones} value={shown.bar[4]} />}
            {chg !== null && (
              <span className={toneClass({ bearish }, chg > 0 ? 'up' : chg < 0 ? 'down' : '')}>
                {chg > 0 ? '+' : ''}
                {fmt(chg)}
                {chgPct !== null && showPct ? ` (${chgPct > 0 ? '+' : ''}${chgPct.toFixed(2)}%)` : ''}
              </span>
            )}
          </div>
          {comp && compBar && (
            <div className="ma-legend">
              <span>
                {comp.label} {Math.round(compBar[4]).toLocaleString('en-US')}
                {compPct !== null && (
                  <span className={toneClass({}, compPct > 0 ? 'up' : compPct < 0 ? 'down' : '')}>
                    {' '}
                    月 {compPct > 0 ? '+' : ''}
                    {compPct.toFixed(1)}%
                  </span>
                )}
                {compIsLast && comp.lastDate && <span className="muted">（至 {comp.lastDate.slice(5).replace('-', '/')}）</span>}
              </span>
            </div>
          )}
          {shown && mas.length > 0 && (
            <div className="ma-legend">
              {mas.map((p) => (
                <span key={p}>
                  <i className="swatch" style={{ background: `var(${MA_COLOR_VAR[p]})` }} />
                  MA{p} {fmt(shown.ma[p])}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div ref={hostRef} className="chart-host" />
    </div>
  );
}

/** 讀值列的區間名稱：色點＋文字（文字用一般字色，不單靠顏色） */
function ZoneTag({ zones, value }: { zones: Zone[]; value: number }) {
  const z = zoneAt(zones, value);
  if (!z) return null;
  return (
    <span className="zone-tag">
      {z.color && <i className="lamp" style={{ background: `var(${z.color})` }} aria-hidden="true" />}
      {z.label}{' '}
    </span>
  );
}
