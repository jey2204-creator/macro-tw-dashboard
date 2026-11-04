import { BtcTwCard } from './BtcTwCard';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { PanelNote } from './PanelNote';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useForeignChips, useSeriesMap } from '../hooks/useData';
import { MA_COLOR_VAR } from '../lib/chartData';
import { MaAllChip } from './MaAllChip';
import { CHART_INTERACTION, resetPaneStretch, resetPriceScales, attachTimeAxis, TIME_AXIS } from '../lib/chartInteraction';
import { loadIdList, loadPref, savePref } from '../lib/storage';
import { cssVar } from '../lib/stressFormat';
import {
  alignToTwCalendar,
  dropWeekendBars,
  COMPARE_PRESETS,
  COMPARE_SERIES,
  compareFetchIds,
  compareLabel,
  CORR_WINDOWS,
  correlationSeries,
  DEFAULT_COMPARE,
  FLOW_CUM_DAYS,
  MAX_COMPARE,
  pairedReturns,
  rollingSum,
  toggleCompare,
  toUsdFlow,
  type CorrSeries,
  type Session,
} from '../shared/crossMarket';
import type { CalendarFile } from '../shared/calendar';
import { todayInTaipei } from '../shared/dates';
import {
  EVENT_KIND_TEXT,
  eventLabel,
  eventStats,
  eventsByReactionDay,
  pastEvents,
  surprisesFor,
  type EventKind,
  type MarkedEvent,
} from '../shared/eventMarkers';
import { FIB_DIRECTION_TEXT, FIB_RATIOS, type Fib, fibRetracement, fibSkipText } from '../shared/fibonacci';
import { INDICATOR_MAP } from '../shared/indicators';
import { maTrend, TREND_TEXT, type MaTrend } from '../shared/maTrend';
import { MA_PERIODS, rangeStart, sma, type MaPeriod, type RangeKey } from '../shared/timeseries';
import type { Bar, SummaryFile } from '../shared/types';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
const COMPARE_IDS = COMPARE_SERIES.map((s) => s.id);
/** 上窗格（加權）較高，其餘對照窗格等高 */
const TOP_STRETCH = 1.6;
// 加權窗格：長均線不參與 Y 軸自動縮放（否則 MA240 把刻度拉寬、K 棒被壓扁）；超出畫面時在邊緣標距離
const NO_AUTOSCALE_MAS: readonly MaPeriod[] = [120, 240];
type OffMa = { p: MaPeriod; value: number; pct: number; side: 'above' | 'below' };
type FibSideLabel = { key: string; text: string; x: number; y: number; side: 'left' | 'right' };
/** 波段點距圖表左／右緣不到幾 px 時，置中文字會被切掉 → 改放 K 棒右側／左側（約半個文字寬） */
const FIB_EDGE_PX = 50;
/** 公布日標記顏色（CSS 變數）；只在 1 年以內的區間顯示（5 年約 180 個點會蓋住 K 線、撐開 Y 軸） */
const EVENT_COLOR_VAR: Record<EventKind, string> = { cpi: '--accent', jobs: '--warn', fomc: '--text-1' };
const EVENT_RANGES: RangeKey[] = ['3M', '6M', '1Y'];
/** 文字標籤只在半年以內顯示（1 年約 36 個標記，加文字會互相蓋住） */
const EVENT_TEXT_RANGES: RangeKey[] = ['3M', '6M'];
/** 費波那契線：0.618 加粗；其餘細虛線 */
const FIB_KEY_RATIO = 0.618;
/** 費波那契波段長度：和圖表區間脫鉤（看 3 個月 K 線也能疊 1 年大波段），預設 1 年 */
const FIB_RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
];
const FIB_RANGE_KEYS = FIB_RANGES.map((r) => r.k);
/**
 * 對照窗格的費波那契：用同一顆開關與同一個波段設定，各自抓自己的高低點。
 * 櫃買窗格較矮只畫三條主要線（0.382／0.5／0.618）；費半、NASDAQ、S&P 500、KOSPI、日經比照加權畫全套五條。
 */
const FIB_SUBS: { id: string; ratios: readonly number[] }[] = [
  { id: 'tpex', ratios: [0.382, 0.5, 0.618] },
  { id: 'sox', ratios: [...FIB_RATIOS] },
  { id: 'nasdaq', ratios: [...FIB_RATIOS] },
  { id: 'spx', ratios: [...FIB_RATIOS] },
  { id: 'kospi', ratios: [...FIB_RATIOS] },
  { id: 'nikkei', ratios: [...FIB_RATIOS] },
];
const FIB_SUB_IDS = FIB_SUBS.map((s) => s.id);
const fibSubRatios = (id: string): readonly number[] => FIB_SUBS.find((s) => s.id === id)?.ratios ?? FIB_RATIOS;
/** 對照窗格算好的費波（含不畫時的說明） */
type SubFib = { id: string; label: string; decimals: number; ratios: readonly number[]; fib: Fib | null; skip: string };
/** 波動統計起算日（通膨主題期） */
const STATS_SINCE = '2022-01-01';

interface PaneData {
  id: string;
  label: string;
  session: Session;
  /** 顯示用 K 棒（美系序列對齊後為台股交易日） */
  bars: Bar[];
  closeOnly: boolean;
  decimals: number;
  corr: CorrSeries;
  /** 依勾選均線週期計算（以顯示用 K 棒的收盤） */
  ma: Partial<Record<MaPeriod, (number | null)[]>>;
  /** 流量型（外資買賣超，億美元）：bars 為每日值，cum 為 20 日累計 */
  flow?: { cum: (number | null)[] };
}

const NO_CORR: CorrSeries = { 20: [], 60: [] };
const SPEC_BY_ID = new Map(COMPARE_SERIES.map((s) => [s.id, s]));
const specLabel = (id: string) => {
  const spec = SPEC_BY_ID.get(id);
  return spec ? compareLabel(spec, INDICATOR_MAP[id]?.short) : (INDICATOR_MAP[id]?.short ?? id);
};

/** 依勾選的週期算均線 */
function maLines(bars: readonly Bar[], mas: readonly MaPeriod[]): Partial<Record<MaPeriod, (number | null)[]>> {
  const closes = bars.map((b) => b[4]);
  return Object.fromEntries(mas.map((p) => [p, sma(closes, p)])) as Partial<Record<MaPeriod, (number | null)[]>>;
}

const fmtNum = (v: number | null | undefined, decimals: number) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? '—'
    : v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const fmtPct = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmtRho = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2));
const fmtSigned = (v: number | null | undefined, decimals: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${fmtNum(v, decimals)}`;
const signClass = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? '' : v > 0 ? 'up' : 'down');

/** ≤ date 的最後一個索引（dates 遞增） */
function indexAtOrBefore(dates: readonly string[], date: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 進入可視範圍（含前後 600px）才載入資料，避免拖慢首頁 */
function useNearViewport(ref: { current: HTMLElement | null }): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}

function sessionText(session: Session, aligned: boolean): string {
  if (session === 'tw') return '同時段';
  return aligned ? '前一晚，已對齊' : '前一晚，未對齊';
}

interface Props {
  version: string;
  themeKey: string;
  /** 均線週期，與單一指標圖共用同一個設定 */
  mas: MaPeriod[];
  onMas: (mas: MaPeriod[]) => void;
  /** 公布日標記的市場預期與實績（選用） */
  calendar?: CalendarFile | null;
  summary?: SummaryFile | null;
  now?: Date;
}

export function CrossMarketPanel({ version, themeKey, mas, onMas, calendar = null, summary = null, now }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const twSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const fibLinesRef = useRef<IPriceLine[]>([]);
  /** 畫費波的對照窗格（櫃買、費半、KOSPI）各自的 K 線序列、波段標記 plugin 與費波線（key＝序列 id） */
  const subSeriesRef = useRef(new Map<string, ISeriesApi<'Candlestick'>>());
  /** 波段高低點標記（加權一組，和公布日標記分開的 plugin） */
  const fibMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const subFibMarkersRef = useRef(new Map<string, ISeriesMarkersPluginApi<Time>>());
  const subFibLinesRef = useRef(new Map<string, IPriceLine[]>());
  const [showFib, setShowFib] = useState(() => loadPref('cm-fib', ['1', '0'] as const, '1') === '1');
  const [fibRange, setFibRange] = useState<RangeKey>(() => loadPref<RangeKey>('cm-fib-range', FIB_RANGE_KEYS, '1Y'));
  const [offMas, setOffMas] = useState<{ list: OffMa[]; paneH: number }>({ list: [], paneH: 0 });
  /** 波段高低點貼近左緣時，文字改以浮動標籤放在 K 棒右側（key＝'tw-lo' 等） */
  const [fibSide, setFibSide] = useState<FibSideLabel[]>([]);
  const [priceAxisW, setPriceAxisW] = useState(0);
  const [showEvents, setShowEvents] = useState(() => loadPref('cm-events', ['1', '0'] as const, '1') === '1');
  const near = useNearViewport(sectionRef);
  const [selected, setSelected] = useState<string[]>(() => loadIdList('cm-ids', COMPARE_IDS, DEFAULT_COMPARE));
  const [aligned, setAligned] = useState(() => loadPref('cm-align', ['1', '0'] as const, '1') === '1');
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('cm-range', ['3M', '6M', '1Y', '5Y', '10Y', 'ALL'], '3M'));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const ids = useMemo(() => ['taiex', ...compareFetchIds(selected)], [selected]);
  const files = useSeriesMap(near ? ids : [], version);
  // 台灣外資買賣超用 foreign-chips.json（2010 年起；序列檔只有近一年）
  const chips = useForeignChips(near && selected.includes('net_foreign') ? version : null);
  const taiex = files.taiex;
  const twBars = useMemo(() => (taiex?.status === 'ready' ? taiex.data.data : []), [taiex]);

  const select = (next: string[]) => {
    setSelected(next);
    savePref('cm-ids', JSON.stringify(next));
  };
  const toggle = (id: string) => select(toggleCompare(selected, id));
  const setAlign = (v: boolean) => {
    setAligned(v);
    savePref('cm-align', v ? '1' : '0');
  };
  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('cm-range', r);
  };

  const toggleMa = (p: MaPeriod) => onMas(mas.includes(p) ? mas.filter((x) => x !== p) : [...mas, p].sort((a, b) => a - b));

  const twDates = useMemo(() => twBars.map((b) => b[0]), [twBars]);
  const twMa = useMemo(() => maLines(twBars, mas), [twBars, mas]);
  // 多空狀態列固定用 MA10/20/60/120/240 計算，不受均線按鈕開關影響
  const trendMa = useMemo(() => maLines(twBars, [10, 20, 60, 120, 240]), [twBars]);
  const nowDate = now ?? new Date();
  const today = todayInTaipei(nowDate);
  // 公布日標記：歷史清單＋日程表已發生者 → 反應日（公布後第一個台股交易日）
  const eventsByDay = useMemo(() => (twDates.length ? eventsByReactionDay(pastEvents(today), twDates) : new Map<string, MarkedEvent[]>()), [twDates, today]);
  const stats = useMemo(() => (twBars.length ? eventStats(twBars, eventsByDay, STATS_SINCE) : null), [twBars, eventsByDay]);
  const toggleEvents = () => {
    setShowEvents(!showEvents);
    savePref('cm-events', showEvents ? '0' : '1');
  };
  const toggleFib = () => {
    setShowFib(!showFib);
    savePref('cm-fib', showFib ? '0' : '1');
  };
  const pickFibRange = (r: RangeKey) => {
    setFibRange(r);
    savePref('cm-fib-range', r);
  };
  // 費波那契回撤：波段高低點取自「波段」按鈕選的期間（不跟圖表區間走）
  const fibRangeLabel = FIB_RANGES.find((r) => r.k === fibRange)?.label ?? '';
  const fib = useMemo(() => {
    const last = twBars.at(-1);
    if (!showFib || !last) return null;
    return fibRetracement(twBars, rangeStart(last[0], fibRange));
  }, [twBars, fibRange, showFib]);
  const fibSkip = useMemo(() => {
    const last = twBars.at(-1);
    return !fib && last ? fibSkipText(twBars, rangeStart(last[0], fibRange), fibRangeLabel) : '';
  }, [fib, twBars, fibRange, fibRangeLabel]);
  const panes = useMemo<PaneData[]>(() => {
    if (twBars.length === 0) return [];
    const out: PaneData[] = [];
    for (const spec of COMPARE_SERIES) {
      if (!selected.includes(spec.id)) continue;
      const def = INDICATOR_MAP[spec.id];
      const label = compareLabel(spec, def?.short);
      if (spec.flow) {
        const fx = files[spec.flow.fx];
        if (!fx || fx.status !== 'ready') continue;
        const f = files[spec.id];
        const raw: Bar[] | null =
          spec.flow.from === 'foreignChips'
            ? (chips?.rows.flatMap((r): Bar[] => (r[2] === null ? [] : [[r[0], r[2], r[2], r[2], r[2]]])) ?? null)
            : f?.status === 'ready'
              ? f.data.data
              : null;
        if (!raw) continue;
        const bars = toUsdFlow(raw, dropWeekendBars(fx.data.data));
        if (bars.length === 0) continue;
        out.push({ id: spec.id, label, session: spec.session, bars, closeOnly: true, decimals: 1, corr: NO_CORR, ma: {}, flow: { cum: rollingSum(bars, FLOW_CUM_DAYS) } });
        continue;
      }
      const f = files[spec.id];
      if (!f || f.status !== 'ready' || f.data.data.length === 0) continue;
      const raw = spec.allWeek && spec.session === 'us' && aligned ? f.data.data : dropWeekendBars(f.data.data);
      const bars = spec.session === 'us' && aligned ? alignToTwCalendar(raw, twDates) : raw;
      out.push({
        id: spec.id,
        label,
        session: spec.session,
        bars,
        closeOnly: f.data.closeOnly,
        // 數值 ≥ 1000（指數、黃金）在對照窗格用整數，價格軸較不占寬度；匯率、利率、油價、VIX 維持原精度
        decimals: (raw.at(-1)?.[4] ?? 0) >= 1000 ? 0 : (def?.decimals ?? 2),
        corr: correlationSeries(pairedReturns(twBars, bars)),
        ma: maLines(bars, mas),
      });
    }
    return out;
  }, [twBars, twDates, files, chips, selected, aligned, mas]);

  // 對照窗格的費波那契（櫃買、費半、KOSPI）：各自抓自己顯示用 K 棒的高低點（費半對齊後為台股交易日），波段期間與加權共用
  const subFibs = useMemo<SubFib[]>(() => {
    if (!showFib) return [];
    return panes.flatMap((p): SubFib[] => {
      if (!FIB_SUB_IDS.includes(p.id) || p.closeOnly || p.flow) return [];
      const last = p.bars.at(-1);
      if (!last) return [];
      const start = rangeStart(last[0], fibRange);
      const fib = fibRetracement(p.bars, start);
      return [{ id: p.id, label: p.label, decimals: p.decimals, ratios: fibSubRatios(p.id), fib, skip: fib ? '' : fibSkipText(p.bars, start, fibRangeLabel) }];
    });
  }, [panes, fibRange, fibRangeLabel, showFib]);

  // 圖表：窗格數會隨選擇變動，資料或選擇改變時整個重建（比逐一增刪窗格單純）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || twBars.length === 0) return;
    const grid = cssVar('--grid');
    const up = cssVar('--up');
    const down = cssVar('--down');
    const textColor = cssVar('--text-3');
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const chart = createChart(host, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd' },
      timeScale: { ...TIME_AXIS, rightOffset: 2, fixLeftEdge: true, fixRightEdge: true, minBarSpacing: 0.2, borderColor: grid },
      ...CHART_INTERACTION,
      layout: {
        ...CHART_INTERACTION.layout,
        background: { type: ColorType.Solid, color: cssVar('--surface') },
        textColor: cssVar('--text-2'),
        fontSize: 11,
        fontFamily,
        panes: { ...CHART_INTERACTION.layout?.panes, separatorColor: cssVar('--border') },
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { autoScale: true, borderColor: grid },
    });
    const candleOpts = { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down };
    const watermark = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) {
        createTextWatermark(pane, {
          horzAlign: 'left',
          vertAlign: 'top',
          lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }],
        });
      }
    };

    // 均線：所有窗格同一組週期；不標數值（加權的數值在圖例）
    const addMas = (paneIndex: number, bars: readonly Bar[], lines: Partial<Record<MaPeriod, (number | null)[]>>) => {
      for (const p of mas) {
        const vals = lines[p];
        if (!vals) continue;
        const s = chart.addSeries(
          LineSeries,
          {
            color: cssVar(MA_COLOR_VAR[p]),
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            ...(paneIndex === 0 && NO_AUTOSCALE_MAS.includes(p) ? { autoscaleInfoProvider: () => null } : {}),
          },
          paneIndex,
        );
        s.setData(bars.flatMap((b, i) => (vals[i] == null ? [] : [{ time: b[0] as Time, value: vals[i]! }])));
      }
    };
    const maText = mas.length > 0 ? `（MA${mas.join('／')}）` : '';

    const tw = chart.addSeries(CandlestickSeries, { ...candleOpts, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 0);
    tw.setData(twBars.map((b) => ({ time: b[0] as Time, open: b[1], high: b[2], low: b[3], close: b[4] })));
    markersRef.current = createSeriesMarkers(tw, []);
    fibMarkersRef.current = createSeriesMarkers(tw, []);
    twSeriesRef.current = tw;
    addMas(0, twBars, twMa);
    watermark(0, `加權指數${maText}`);

    panes.forEach((p, k) => {
      const paneIndex = k + 1;
      const priceFormat = { type: 'price' as const, precision: p.decimals, minMove: 1 / 10 ** p.decimals };
      if (p.flow) {
        // 每日買賣超柱放獨立小刻度貼底（否則被累計線壓扁）；20 日累計線用右側刻度，0 軸虛線
        const h = chart.addSeries(HistogramSeries, { priceFormat, priceScaleId: `flow-${p.id}`, priceLineVisible: false, lastValueVisible: false }, paneIndex);
        h.priceScale().applyOptions({ scaleMargins: { top: 0.55, bottom: 0 } });
        h.setData(p.bars.map((b) => ({ time: b[0] as Time, value: b[4], color: b[4] >= 0 ? `${up}99` : `${down}99` })));
        const cum = p.flow.cum;
        const line = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 2, priceFormat, priceLineVisible: false }, paneIndex);
        line.setData(p.bars.flatMap((b, i) => (cum[i] == null ? [] : [{ time: b[0] as Time, value: cum[i]! }])));
        line.createPriceLine({ price: 0, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
        watermark(paneIndex, `${p.label}（億美元｜柱＝每日、線＝${FLOW_CUM_DAYS}日累計）`);
        return;
      }
      if (p.closeOnly) {
        const s = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 2, priceFormat }, paneIndex);
        s.setData(p.bars.map((b) => ({ time: b[0] as Time, value: b[4] })));
      } else {
        const s = chart.addSeries(CandlestickSeries, { ...candleOpts, priceFormat }, paneIndex);
        s.setData(p.bars.map((b) => ({ time: b[0] as Time, open: b[1], high: b[2], low: b[3], close: b[4] })));
        if (FIB_SUB_IDS.includes(p.id)) {
          subSeriesRef.current.set(p.id, s);
          subFibMarkersRef.current.set(p.id, createSeriesMarkers(s, []));
        }
      }
      addMas(paneIndex, p.bars, p.ma);
      watermark(paneIndex, `${p.label}（${sessionText(p.session, aligned)}）`);
    });

    const handler = (param: MouseEventParams<Time>) => setHoverTime(typeof param.time === 'string' ? param.time : null);
    chart.subscribeCrosshairMove(handler);
    attachTimeAxis(chart);
    chartRef.current = chart;
    setChartGen((g) => g + 1);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      chart.remove();
      chartRef.current = null;
      markersRef.current = null;
      twSeriesRef.current = null;
      subSeriesRef.current.clear();
      fibMarkersRef.current = null;
      subFibMarkersRef.current.clear();
      subFibLinesRef.current.clear();
    };
  }, [twBars, twMa, panes, aligned, mas, themeKey]);

  // 公布日標記：加權 K 棒下方一個圓點＋文字（CPI 藍、非農橘、FOMC 黑）；只在 1 年以內區間顯示
  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    if (!showEvents || !EVENT_RANGES.includes(range)) {
      m.setMarkers([]);
      return;
    }
    const withText = EVENT_TEXT_RANGES.includes(range);
    const markers: SeriesMarker<Time>[] = [];
    for (const [day, evs] of eventsByDay) {
      // 同一天多個事件只畫一個點，顏色取最先的；文字合併
      const first = evs[0]!;
      markers.push({
        time: day as Time,
        position: 'belowBar',
        shape: 'circle',
        size: 0.6,
        color: cssVar(EVENT_COLOR_VAR[first.kind]),
        text: withText ? [...new Set(evs.map((e) => EVENT_KIND_TEXT[e.kind]))].join('+') : undefined,
      });
    }
    markers.sort((a, b) => (a.time as string).localeCompare(b.time as string));
    m.setMarkers(markers);
  }, [chartGen, showEvents, range, eventsByDay]);

  // 費波那契水平線：畫在加權窗格（價格線不參與自動縮放，不會撐開 Y 軸）
  useEffect(() => {
    const tw = twSeriesRef.current;
    if (!tw) return;
    for (const l of fibLinesRef.current) tw.removePriceLine(l);
    fibLinesRef.current = [];
    if (!fib) return;
    const color = cssVar('--text-3');
    fibLinesRef.current = fib.levels.map((l) =>
      tw.createPriceLine({
        price: Math.round(l.price),
        color,
        lineWidth: l.ratio === FIB_KEY_RATIO ? 2 : 1,
        lineStyle: l.ratio === FIB_KEY_RATIO ? LineStyle.Solid : LineStyle.Dashed,
        // 窗格內不標文字、價格軸也不標（五個標籤疊成一塊會蓋住 K 棒與刻度）；比例與價位列在圖例
        axisLabelVisible: false,
      }),
    );
  }, [chartGen, fib]);

  // 對照窗格的費波那契：櫃買只畫 0.382／0.5／0.618（窗格矮，五條會跟 K 棒疊在一起）；費半、KOSPI 畫全套
  useEffect(() => {
    const color = cssVar('--text-3');
    for (const [id, s] of subSeriesRef.current) {
      for (const l of subFibLinesRef.current.get(id) ?? []) s.removePriceLine(l);
      subFibLinesRef.current.delete(id);
      const sub = subFibs.find((f) => f.id === id);
      if (!sub?.fib) continue;
      subFibLinesRef.current.set(
        id,
        sub.fib.levels
          .filter((l) => sub.ratios.includes(l.ratio))
          .map((l) =>
            s.createPriceLine({
              price: sub.decimals === 0 ? Math.round(l.price) : l.price,
              color,
              lineWidth: l.ratio === FIB_KEY_RATIO ? 2 : 1,
              lineStyle: l.ratio === FIB_KEY_RATIO ? LineStyle.Solid : LineStyle.Dashed,
              axisLabelVisible: false,
            }),
          ),
      );
    }
  }, [chartGen, subFibs]);

  // 波段高低點標記：高點那根上方「▼ 價位」、低點那根下方「▲ 價位」，顏色同費波線。
  // 波段點貼近圖表左／右緣（50px 內）時，置中文字會被切掉 → 標記不帶字，文字改成浮動標籤放在 K 棒右側／左側
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const color = cssVar('--text-3');
    const host = hostRef.current;
    type Anchor = { key: string; time: string; price: number; above: boolean; text: string };
    const anchorsOf = (prefix: string, f: Fib | null, decimals: number): Anchor[] =>
      f
        ? [
            { key: `${prefix}-hi`, time: f.hiDate, price: f.hi, above: true, text: `波段高 ${fmtNum(f.hi, decimals)}` },
            { key: `${prefix}-lo`, time: f.loDate, price: f.lo, above: false, text: `波段低 ${fmtNum(f.lo, decimals)}` },
          ]
        : [];
    const groups: { m: ISeriesMarkersPluginApi<Time> | null; s: ISeriesApi<'Candlestick'> | null; anchors: Anchor[] }[] = [
      { m: fibMarkersRef.current, s: twSeriesRef.current, anchors: anchorsOf('tw', fib, 0) },
      ...[...subFibMarkersRef.current].map(([id, m]) => {
        const sub = subFibs.find((f) => f.id === id);
        return { m, s: subSeriesRef.current.get(id) ?? null, anchors: anchorsOf(id, sub?.fib ?? null, sub?.decimals ?? 2) };
      }),
    ];
    let raf = 0;
    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const ts = chart.timeScale();
        const plotW = ts.width();
        const hostBox = host?.getBoundingClientRect();
        const side: FibSideLabel[] = [];
        for (const g of groups) {
          if (!g.m) continue;
          const markers: SeriesMarker<Time>[] = [];
          for (const a of g.anchors) {
            const x = ts.timeToCoordinate(a.time as Time);
            const edge = x === null ? null : x < FIB_EDGE_PX ? 'right' : plotW - x < FIB_EDGE_PX ? 'left' : null;
            markers.push({
              time: a.time as Time,
              position: a.above ? 'aboveBar' : 'belowBar',
              shape: a.above ? 'arrowDown' : 'arrowUp',
              size: 0.8,
              color,
              text: edge ? undefined : a.text,
            });
            if (edge && x !== null && g.s && hostBox) {
              const y = g.s.priceToCoordinate(a.price);
              const paneEl = chart.panes()[g.s.getPane().paneIndex()]?.getHTMLElement();
              const paneTop = paneEl ? paneEl.getBoundingClientRect().top - hostBox.top : 0;
              // side=right：標籤放 K 棒右側（left 定位）；side=left：放左側（right 定位，從繪圖區右緣算）
              if (y !== null) side.push({ key: a.key, text: a.text, side: edge, x: edge === 'right' ? x + 10 : plotW - x + 10, y: paneTop + y + (a.above ? -22 : 10) });
            }
          }
          markers.sort((p, q) => (p.time as string).localeCompare(q.time as string));
          g.m.setMarkers(markers);
        }
        setFibSide((prev) => (JSON.stringify(prev) === JSON.stringify(side) ? prev : side));
        setPriceAxisW(chart.priceScale('right').width());
      });
    };
    apply();
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(apply);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    if (ro && host) ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(apply);
      ro?.disconnect();
    };
  }, [chartGen, fib, subFibs]);

  // 時間區間與重設：每個窗格 Y 軸自動縮放、高度比例設回預設
  useEffect(() => {
    const chart = chartRef.current;
    const lastTw = twBars.at(-1);
    if (!chart || !lastTw) return;
    const lastDate = panes.reduce((m, p) => (p.bars.at(-1)?.[0] ?? '') > m ? p.bars.at(-1)![0] : m, lastTw[0]);
    const start = rangeStart(lastTw[0], range);
    const apply = () => {
      resetPriceScales(chart);
      resetPaneStretch(chart, [TOP_STRETCH, ...panes.map(() => 1)]);
      if (!start || start <= twBars[0]![0]) chart.timeScale().fitContent();
      else chart.timeScale().setVisibleRange({ from: start as Time, to: lastDate as Time });
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [chartGen, range, resetKey, twBars, panes]);

  // 長均線超出加權窗格可見範圍時，在上／下緣標出數值與距離（以最新收盤計）
  useEffect(() => {
    const chart = chartRef.current;
    const tw = twSeriesRef.current;
    const lastClose = twBars.at(-1)?.[4];
    if (!chart || !tw || lastClose == null) return;
    let raf = 0;
    const check = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const paneH = chart.panes()[0]?.getHeight() ?? 0;
        const list: OffMa[] = [];
        for (const p of mas) {
          if (!NO_AUTOSCALE_MAS.includes(p)) continue;
          const value = twMa[p]?.at(-1);
          if (value == null) continue;
          const y = tw.priceToCoordinate(value);
          if (y === null || (y >= 0 && y <= paneH)) continue;
          list.push({ p, value, pct: (value / lastClose - 1) * 100, side: y < 0 ? 'above' : 'below' });
        }
        setOffMas((prev) => (JSON.stringify(prev) === JSON.stringify({ list, paneH }) ? prev : { list, paneH }));
      });
    };
    check();
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(check);
    chart.subscribeCrosshairMove(check);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    if (ro && hostRef.current) ro.observe(hostRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(check);
      chart.unsubscribeCrosshairMove(check);
      ro?.disconnect();
    };
  }, [chartGen, range, resetKey, twBars, twMa, mas]);

  // 圖例：十字線所在日期（沒有時各序列顯示自己最新一筆）
  const legend = useMemo(() => {
    if (twBars.length === 0) return null;
    const twIdx = hoverTime ? indexAtOrBefore(twDates, hoverTime) : twBars.length - 1;
    const twBar = hoverTime ? (twDates[twIdx] === hoverTime ? twBars[twIdx] : undefined) : twBars[twIdx];
    const twPrev = twBar && twIdx > 0 ? twBars[twIdx - 1]! : null;
    const rows = panes.map((p) => {
      const dates = p.bars.map((b) => b[0]);
      const i = hoverTime ? indexAtOrBefore(dates, hoverTime) : p.bars.length - 1;
      const bar = hoverTime ? (dates[i] === hoverTime ? p.bars[i] : undefined) : p.bars[i];
      const prev = bar && i > 0 ? p.bars[i - 1]! : null;
      const ci = Math.max(0, twIdx);
      return {
        id: p.id,
        label: p.label,
        decimals: p.decimals,
        flowCum: p.flow ? (bar ? (p.flow.cum[i] ?? null) : null) : undefined,
        bar,
        pct: bar && prev ? ((bar[4] - prev[4]) / Math.abs(prev[4])) * 100 : null,
        rho: Object.fromEntries(CORR_WINDOWS.map((n) => [n, p.corr[n][ci] ?? null])) as Record<(typeof CORR_WINDOWS)[number], number | null>,
      };
    });
    const day = hoverTime ?? twBar?.[0] ?? '';
    const events = (showEvents ? eventsByDay.get(day) ?? [] : []).map((e) => {
      const sv = surprisesFor(e, calendar, summary, nowDate).filter((v) => v.actual !== null);
      const text = sv
        .map((v) => {
          const short = INDICATOR_MAP[v.def.indicatorId]?.short ?? v.def.indicatorId;
          const name = v.def.label === short ? short : `${short} ${v.def.label}`;
          return `${name} ${v.actual}${v.def.unit === '%' ? '%' : 'k'}${v.event.forecast !== null ? `（預期 ${v.event.forecast}，${v.diff! > 0 ? '+' : ''}${v.diff}）` : ''}`;
        })
        .join('、');
      return { label: eventLabel(e), kind: e.kind, text };
    });
    return {
      date: day,
      events,
      twBar,
      twPct: twBar && twPrev ? ((twBar[4] - twPrev[4]) / Math.abs(twPrev[4])) * 100 : null,
      ma: Object.fromEntries(mas.map((p) => [p, twBar ? twMa[p]?.[twIdx] : null])) as Partial<Record<MaPeriod, number | null | undefined>>,
      trend: twBar
        ? maTrend({ close: twBar[4], 10: trendMa[10]?.[twIdx], 20: trendMa[20]?.[twIdx], 60: trendMa[60]?.[twIdx], 120: trendMa[120]?.[twIdx], 240: trendMa[240]?.[twIdx] })
        : null,
      rows,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twBars, twDates, twMa, trendMa, panes, hoverTime, mas, showEvents, eventsByDay, calendar, summary]);

  const latestRho = panes.filter((p) => !p.flow).map((p) => ({ label: p.label, rho60: p.corr[60].at(-1) ?? null }));
  const failed = COMPARE_SERIES.flatMap((s) => {
    const f = files[s.id];
    return selected.includes(s.id) && f && f.status === 'error' ? [`${specLabel(s.id)}：${f.error}`] : [];
  });
  const atMax = selected.length >= MAX_COMPARE;
  const oldest = atMax ? specLabel(selected[0]!) : null;
  const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const hostStyle = { ['--cm-panes' as string]: String(panes.length) } as CSSProperties;

  return (
    <section ref={sectionRef} id="sec-cm" className="regime ms cm" aria-label="跨市場對照">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">跨市場對照（參考）</span>
        </div>
        {twBars.length > 0 && <span className="small muted num">加權資料 {twBars.at(-1)![0]}</span>}
      </div>
      {latestRho.length > 0 && (
        <p className="score num cm-rho">ρ60：{latestRho.map((r) => `${r.label} ${fmtRho(r.rho60)}`).join('｜')}</p>
      )}

      <PanelNote>
        <p className="small muted ms-rule">
        美股、美債、美元、原油在台股開盤前收盤，是台股的「前一晚」：對齊後，同一直線上的美系 K 棒＝台股開盤時看到的那根（連假期間多根合併成一根）。
        日經、KOSPI、櫃買、亞洲匯率（USD/TWD、KRW、JPY）與台股同時段，不移。ρ20／ρ60＝日報酬 20／60 日相關係數，看背離與關係斷裂，不是預測；三張圖同向不等於三個證據。
        黃金、VIX 用來分辨今天是哪種行情（黃金↑油↑殖利率↓＝地緣避險；黃金↑美元↑殖利率↑＝通膨），不是預測戰爭。比特幣不是避險資產（跟美股同漲同跌），放在「避險」組合是看週末台股休市時的風險胃口。
        「亞洲資金」看外資有沒有撤出：台外資、韓外資是外資每日買賣超換算成億美元（柱＝每日、線＝20 日累計），是直接證據；兩國同時賣＝亞洲撤出，只有一國賣＝該國個別因素。匯率是結果：當地貨幣貶（USD/xxx 上升）而 DXY 沒漲＝資金離開該國，DXY 也漲＝全球美元回流。日圓是避險貨幣，恐慌時常升值，不能用來判斷外資撤出日股。韓國資料來自 Naver（韓國交易所數字）。
        TLT 是美債價格，與 10Y 殖利率鏡像（殖利率 +10bp ≈ TLT −1.6%），兩張圖是同一件事，不算兩個證據；用途是比 FRED 早 1–2 天看到昨晚美債走勢。
        加權下方的狀態列（參考、不計分）：短線＝收盤與 MA10 都在 MA20 之上為「短多」、都在之下為「短空」；中期＝收盤與 MA60 對 MA120 同理（MA60＝季線）；不一致為「整理」。乖離＝收盤離該均線多少 %。均線落後價格，狀態列描述現況、不是預測。
        加權 K 棒下方的圓點是 CPI（藍）、就業報告（橘）、FOMC（黑）公布後台股第一個交易日：美東 08:30／14:00 公布時台股已收盤，反應落在隔天。
        動市場的是「實績 vs 預期」不是年增率本身，所以用標記不畫月線；2026-10 起有市場預期，點到該日圖例會列出驚喜值。標記只在 1 年以內的區間顯示（半年以內才附文字）。
        費波那契回撤（參考、不計分）：取「波段」按鈕所選期間內加權的最高與最低價當波段（預設 1 年，不跟圖表區間走），高點在後＝多頭回撤、由高點往下畫 0.236／0.382／0.5／0.618（粗線）／0.786 當支撐；低點在後則由低點往上畫當壓力。3 個月看短波段、1 年看大波段；「📐波段」按鈕放在「區間」按鈕旁邊：區間＝圖看多長的 K 線、波段＝費波用哪段高低點，是兩個不同的設定，圖例開頭會標現在用的波段；線上不標數字，比例與價位列在圖例；波段高點那根 K 棒上方標「▼ 波段高」、低點下方標「▲ 波段低」，才知道費波是從哪兩根算的；波段點貼近左右緣時文字改放 K 棒旁邊（波段點在畫面外時看圖例日期）。
        它靠「大家都在看」才有效，單獨用勝率不高；守住 0.618 算趨勢延續、跌破要當趨勢可能反轉。高低點相隔不到 20 根 K 棒不畫；若最低（高）點就是最新一根，表示還在創波段新低（高）、下方（上方）沒有費波位，圖例會直接說明。
        櫃買、費半、NASDAQ、S&P 500、KOSPI、日經窗格用同一顆開關、同一個波段期間，但各自抓自己的高低點（美股對齊後以台股交易日計；KOSPI、日經與台股同時段，日期直接對得上）；櫃買窗格較矮只畫 0.382／0.5／0.618 三條，其餘比照加權畫全套五條，價位都列在圖例。
      </p>
        {stats && Number.isFinite(stats.normal.meanAbs) && (
          <p className="small muted num cm-stats">
            {STATS_SINCE.slice(0, 4)} 年起加權反應日 |漲跌| 均值：平常日 {stats.normal.meanAbs.toFixed(2)}%（≥1.5% 佔 {stats.normal.bigPct.toFixed(0)}%）｜
            {(['cpi', 'jobs', 'fomc'] as const)
              .map((k) => `${EVENT_KIND_TEXT[k]} ${stats.kinds[k].meanAbs.toFixed(2)}%（${stats.kinds[k].bigPct.toFixed(0)}%，n=${stats.kinds[k].n}）`)
              .join('｜')}
          </p>
        )}
      </PanelNote>

      <div className="cp-mas" role="group" aria-label="對照組合">
        <div className="seg" role="group" aria-label="一鍵切換組合">
          {COMPARE_PRESETS.map((g) => (
            <button key={g.key} type="button" aria-pressed={sameSet(selected, g.ids)} onClick={() => select(g.ids)}>
              {g.label}
            </button>
          ))}
        </div>
        <button type="button" className="ma-chip" aria-pressed={aligned} onClick={() => setAlign(!aligned)} title="美系序列往後對齊一個台股交易日">
          ⏰ 美系對齊台股交易日
        </button>
        <button type="button" className="ma-chip" aria-pressed={showEvents} onClick={toggleEvents} title="CPI／就業報告／FOMC 公布後台股第一個交易日">
          📌 公布日標記
        </button>
        <button type="button" className="ma-chip" aria-pressed={showFib} onClick={toggleFib} title="以所選波段內的高低點畫 0.236／0.382／0.5／0.618／0.786（加權、費半、NASDAQ、S&P 500、KOSPI、日經）；櫃買窗格只畫 0.382／0.5／0.618">
          📐 費波那契回撤
        </button>
      </div>

      <div className="cp-mas" role="group" aria-label="對照序列">
        {COMPARE_SERIES.map((s) => {
          const on = selected.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              className="ma-chip"
              aria-pressed={on}
              title={s.flow ? '外資每日買賣超（億美元）與 20 日累計' : s.session === 'us' ? '台股收盤後交易（前一晚）' : '與台股同時段'}
              onClick={() => toggle(s.id)}
            >
              {compareLabel(s, INDICATOR_MAP[s.id]?.short)}
            </button>
          );
        })}
        {atMax && <span className="small muted">已滿 {MAX_COMPARE} 個，再選會換掉最早選的（{oldest}）</span>}
      </div>

      <div className="cp-mas ma-row" role="group" aria-label="均線">
        <MaAllChip mas={mas} onMas={onMas} />
        {MA_PERIODS.map((p) => (
          <button key={p} type="button" className="ma-chip" aria-pressed={mas.includes(p)} onClick={() => toggleMa(p)}>
            <i className="swatch" style={{ background: `var(${MA_COLOR_VAR[p]})` }} />
            MA{p}
          </button>
        ))}
      </div>

      {/* 時間區間（圖看多長）與費波波段（費波用哪段高低點）並排，兩排選項長得像、放一起才看得出是兩個設定 */}
      <div className="cm-ranges">
        <div className="seg" role="group" aria-label="時間區間">
          <span className="small muted">區間</span>
          {RANGES.map((r) => (
            <button key={r.k} type="button" aria-pressed={range === r.k} onClick={() => pickRange(r.k)}>
              {r.label}
            </button>
          ))}
          <button type="button" onClick={() => setResetKey((k) => k + 1)} aria-label="重設圖表縮放" title="重設縮放">
            ↺ 重設
          </button>
        </div>
        {showFib && (
          <div className="seg cm-fib-seg" role="group" aria-label="費波那契波段長度">
            <span className="small muted">📐波段</span>
            {FIB_RANGES.map((r) => (
              <button key={r.k} type="button" aria-label={`波段${r.label}`} aria-pressed={fibRange === r.k} onClick={() => pickFibRange(r.k)}>
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {failed.length > 0 && <p className="small warn">載入失敗：{failed.join('；')}</p>}

      {!near || !taiex || taiex.status === 'loading' ? (
        <p className="cp-msg muted">載入中…</p>
      ) : taiex.status === 'error' ? (
        <p className="cp-msg warn">無法載入加權指數資料（{taiex.error}）</p>
      ) : (
        <div className="pricechart ms-chart">
          {legend && (
            <div className="legend num cm-legend" aria-live="off">
              <div>
                <span className="muted">{legend.date}</span> 加權 <b>{fmtNum(legend.twBar?.[4], 0)}</b>{' '}
                <span className={legend.twPct !== null ? (legend.twPct > 0 ? 'up' : legend.twPct < 0 ? 'down' : '') : ''}>{fmtPct(legend.twPct)}</span>
              </div>
              {legend.trend && <TrendRow t={legend.trend} />}
              {showFib && (
                <div className="cm-fib muted">
                  📐 波段{fibRangeLabel}｜加權{' '}
                  {fib ? (
                    <>
                      {FIB_DIRECTION_TEXT[fib.direction]} {fmtNum(fib.lo, 0)}（{fib.loDate.slice(5)}）→{fmtNum(fib.hi, 0)}（{fib.hiDate.slice(5)}）｜已
                      {fib.direction === 'up' ? '回撤' : '反彈'} <b className={fib.direction === 'up' ? 'down' : 'up'}>{fib.current.toFixed(3)}</b>
                      {fib.between && (
                        <>
                          ，在 {fib.between[0]}～{fib.between[1]} 之間
                        </>
                      )}
                      <span className="cm-fib-levels">
                        {fib.levels.map((l) => (
                          <span key={l.ratio}>
                            {l.ratio === FIB_KEY_RATIO ? <b>{l.ratio}</b> : l.ratio} {fmtNum(l.price, 0)}
                          </span>
                        ))}
                      </span>
                    </>
                  ) : (
                    fibSkip
                  )}
                </div>
              )}
              {subFibs.map((sub) => (
                <div key={sub.id} className="cm-fib muted">
                  📐 {sub.label}{' '}
                  {sub.fib ? (
                    <>
                      {FIB_DIRECTION_TEXT[sub.fib.direction]} {fmtNum(sub.fib.lo, sub.decimals)}（{sub.fib.loDate.slice(5)}）→{fmtNum(sub.fib.hi, sub.decimals)}（{sub.fib.hiDate.slice(5)}）｜已
                      {sub.fib.direction === 'up' ? '回撤' : '反彈'} <b className={sub.fib.direction === 'up' ? 'down' : 'up'}>{sub.fib.current.toFixed(3)}</b>
                      {sub.fib.between && (
                        <>
                          ，在 {sub.fib.between[0]}～{sub.fib.between[1]} 之間
                        </>
                      )}
                      <span className="cm-fib-levels">
                        {sub.fib.levels
                          .filter((l) => sub.ratios.includes(l.ratio))
                          .map((l) => (
                            <span key={l.ratio}>
                              {l.ratio === FIB_KEY_RATIO ? <b>{l.ratio}</b> : l.ratio} {fmtNum(l.price, sub.decimals)}
                            </span>
                          ))}
                      </span>
                    </>
                  ) : (
                    sub.skip
                  )}
                </div>
              ))}
              {legend.events.map((e) => (
                <div key={e.label} className="cm-event">
                  <i className="swatch" style={{ background: `var(${EVENT_COLOR_VAR[e.kind]})` }} />
                  {e.label}
                  {e.text && <span className="muted">：{e.text}</span>}
                </div>
              ))}
              {mas.length > 0 && (
                <div className="ma-legend">
                  {mas.map((p) => (
                    <span key={p}>
                      <i className="swatch" style={{ background: `var(${MA_COLOR_VAR[p]})` }} />
                      MA{p} {fmtNum(legend.ma[p], 0)}
                    </span>
                  ))}
                </div>
              )}
              {legend.rows.map((r) =>
                r.flowCum !== undefined ? (
                  <div key={r.id}>
                    {r.label} <b className={signClass(r.bar?.[4])}>{fmtSigned(r.bar?.[4], r.decimals)}</b> 億美元{' '}
                    <span className="muted">{FLOW_CUM_DAYS}日</span> <span className={signClass(r.flowCum)}>{fmtSigned(r.flowCum, r.decimals)}</span>
                  </div>
                ) : (
                <div key={r.id}>
                  {r.label} <b>{fmtNum(r.bar?.[4], r.decimals)}</b>{' '}
                  <span className={r.pct !== null ? (r.pct > 0 ? 'up' : r.pct < 0 ? 'down' : '') : ''}>{fmtPct(r.pct)}</span>{' '}
                  <span className="muted">
                    ρ20 {fmtRho(r.rho[20])} ρ60 {fmtRho(r.rho[60])}
                  </span>
                </div>
                ),
              )}
            </div>
          )}
          <div className="cm-host-wrap">
            <div ref={hostRef} className="chart-host cm-host" style={hostStyle} />
            {fibSide.map((l) => (
              <div key={l.key} className="cm-fibside num" style={l.side === 'right' ? { left: l.x, top: l.y } : { right: l.x + priceAxisW, top: l.y }}>
                {l.text}
              </div>
            ))}
            {offMas.list.map((o) => (
              <div
                key={o.p}
                className="cm-offma num"
                style={o.side === 'above' ? { top: 22 } : { top: Math.max(0, offMas.paneH - 24) }}
              >
                <i className="swatch" style={{ background: `var(${MA_COLOR_VAR[o.p]})` }} />
                {o.side === 'above' ? '↑' : '↓'} MA{o.p} {fmtNum(o.value, 0)}（{o.pct > 0 ? '+' : ''}
                {o.pct.toFixed(1)}%）
              </div>
            ))}
          </div>
        </div>
      )}
      <BtcTwCard version={version} near={near} />
    </section>
  );
}

const sideClass = (v: string | null) => (v === 'bull' || v === 'above' ? 'up' : v === 'bear' || v === 'below' ? 'down' : 'muted');
const fmtDev = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

/** 加權多空狀態列：短線／中期／年線三格＋乖離 */
function TrendRow({ t }: { t: MaTrend }) {
  return (
    <div className="cm-trend">
      {t.short && <b className={`cm-tag ${sideClass(t.short)}`}>{TREND_TEXT.short[t.short]}</b>}
      {t.mid && <b className={`cm-tag ${sideClass(t.mid)}`}>{TREND_TEXT.mid[t.mid]}</b>}
      {t.long && <b className={`cm-tag ${sideClass(t.long)}`}>{TREND_TEXT.long[t.long]}</b>}
      <span className="muted">
        乖離 MA20 <span className={signClass(t.dev[20])}>{fmtDev(t.dev[20])}</span> MA60 <span className={signClass(t.dev[60])}>{fmtDev(t.dev[60])}</span> MA240{' '}
        <span className={signClass(t.dev[240])}>{fmtDev(t.dev[240])}</span>
      </span>
    </div>
  );
}
