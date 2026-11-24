import {
  BaselineSeries,
  type AutoscaleInfoProvider,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  PriceScaleMode,
  createChart,
  createTextWatermark,
  type IChartApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { CutRegimeCard } from './CutRegimeCard';
import { FedStanceCard } from './FedStanceCard';
import { PanelNote } from './PanelNote';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSeriesMap } from '../hooks/useData';
import { CHART_INTERACTION, resetPaneStretch, resetPriceScales, attachTimeAxis, TIME_AXIS } from '../lib/chartInteraction';
import { loadPref, savePref } from '../lib/storage';
import { LineLabels, type LineLabel } from '../lib/lineLabels';
import { END_LABEL_FONT, endLabelGapPx, followAnchor, rightGapBars } from '../lib/endLabels';
import { cssVar, pctCell } from '../lib/stressFormat';
import {
  PHASE_COLOR,
  PHASE_TEXT,
  SAHM_TRIGGER,
  cycleEvents,
  eventStats,
  fedMoves,
  phaseAt,
  phaseRows,
  phaseSegments,
  phaseStats,
} from '../shared/fedEquity';
import { assessCuts, readingsAt, verdictStats } from '../shared/cutRegime';
import { stanceAt, stanceBaseline, stanceSamples, stanceStats } from '../shared/fedStance';
import { baseDateLabel } from '../lib/breadthPct';
import { CRASH_PCT, FX_GROUP_TEXT, FX_LOOKBACK_MONTHS, fxPctLine, fxSamples, fxStats, hikeCycles, spliceCloses, spliceUsdTwd, type FxStat } from '../shared/fedFx';
import { daysBetween } from '../shared/dates';
import {
  FED_TARGET,
  REAL_RATE_STATE_TEXT,
  REAL_RATE_TIGHT,
  lastSignFlip,
  realRateSeries,
  splicePolicyRate,
  summarize,
  valueAtOrBefore,
  yoyPoints,
  type RealRateRow,
} from '../shared/policyInflation';
import { rangeStart, type Point, type RangeKey } from '../shared/timeseries';
import type { Bar } from '../shared/types';
import type { ForeignChipsFile } from '../shared/foreignChips';
import { curveText, gdpNowcast, gdpYoy, nextQuarter, quarterLabel } from '../shared/gdpGrowth';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
const PANE_STRETCH = [0.6, 0.4] as const;
/** 開 S&P 窗格時三格比例 */
const PANE_STRETCH_SPX = [0.42, 0.25, 0.33] as const;
/** 再開美元／台幣窗格（第四格）；沒開指數時美元／台幣排第三格 */
const PANE_STRETCH_FX = [0.45, 0.27, 0.28] as const;
const PANE_STRETCH_SPX_FX = [0.33, 0.18, 0.25, 0.24] as const;
/** 第四格兩條線的顏色（美元指數橘、USD/TWD 主色） */
const FX_COLOR = { dxy: '--ma60', twd: '--accent' } as const;
/** 第四格可各自開關的線；兩條都開＝累計 % 同一刻度，只開一條＝原始價位 */
const FX_LINES = [
  { id: 'dxy', label: 'DXY', key: 'pi-fx-dxy' },
  { id: 'twd', label: 'USD/TWD', key: 'pi-fx-twd' },
] as const;
type FxId = (typeof FX_LINES)[number]['id'];
const FX_RAW_TITLE: Record<FxId, string> = { dxy: 'DXY 美元指數（點）', twd: 'USD/TWD（元）｜往上＝台幣貶' };

/** 可切換的副線（核心 CPI 另有開關 `pi-core`：關掉只是不畫線，實質利率與讀數仍以核心 CPI 計） */
const EXTRA_LINES = [
  { id: 'cpi', label: '整體 CPI', key: 'pi-cpi', def: '1' },
  { id: 'core_pce', label: '核心 PCE', key: 'pi-pce', def: '0' },
  { id: 'us2y', label: '美債 2Y', key: 'pi-2y', def: '1' },
  { id: 'us10y', label: '美債 10Y', key: 'pi-10y', def: '0' },
] as const;
const EXTRA_COLOR: Record<ExtraId, string> = { cpi: 'var(--ma60)', core_pce: 'var(--ma240)', us2y: 'var(--ma120)', us10y: 'var(--ma10)' };
type ExtraId = (typeof EXTRA_LINES)[number]['id'];

/** 第三格可選指數（一次一個；表格四個並排）。費半 1994、加權 1997 起，樣本比 S&P 少 */
const INDICES = [
  { id: 'spx', label: 'S&P 500', short: 'S&P' },
  { id: 'nasdaq', label: 'NASDAQ', short: 'NASDAQ' },
  { id: 'sox', label: '費半', short: '費半' },
  { id: 'taiex', label: '加權', short: '加權' },
] as const;
type IndexId = (typeof INDICES)[number]['id'];
type IndexPick = IndexId | 'off';
const INDEX_PICKS: readonly IndexPick[] = ['spx', 'nasdaq', 'sox', 'taiex', 'off'];

const IDS = ['fed', 'fed_target_legacy', 'core_cpi', 'cpi', 'core_pce', 'us2y', 'us10y', 'gdp', 'gdpnow', 'unrate', 'nrou', 'baa10y', 'hy_oas', 'dxy', 'usdtwd', 'usdtwd_legacy', ...INDICES.map((i) => i.id)];
/** FRED 的 USD/TWD（長期、乾淨）抓不到時退回 Yahoo，照常顯示（回測只剩 2004 起且較吵），不報載入失敗 */
const OPTIONAL_IDS = new Set(['usdtwd_legacy', 'nrou', 'us10y', 'gdp', 'gdpnow']);
/** Fed 立場卡回測起點（Greenspan 上任那年；之前 Fed 以貨幣供給為操作目標） */
const STANCE_FROM = '1987-01-01';
const STANCE_INDEX_IDS = ['spx', 'taiex'] as const;

const NO_BARS: Bar[] = [];
const signed = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
const FX_ROW_TEXT: Record<FxStat['group'], string> = { ...FX_GROUP_TEXT, all: '全部' };

function buildEquity(fed: readonly Point[], bars: readonly Bar[], unrate: readonly Point[]) {
  const segments = phaseSegments(fed, bars.map((b) => b[0]));
  const rows = phaseRows(segments, bars);
  const events = cycleEvents(fed, bars, unrate);
  return { segments, rows, stats: phaseStats(rows), events, eventStats: eventStats(events) };
}

const f2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2));
const f1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(1));
const fpp = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}pp`;
const ym = (d: string) => d.slice(0, 7);

/** 進入可視範圍（含前後 600px）才載入資料 */
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

interface Props {
  version: string;
  themeKey: string;
  /** 外資籌碼對照的資料（第五格外資買賣超用；沒有就不顯示開關） */
  foreign?: ForeignChipsFile | null;
}

/** 第五格三選一：外資買賣超／美國 GDP 成長率／關 */
type P5 = 'fc' | 'gdp' | 'off';
const P5_PICKS: readonly P5[] = ['fc', 'gdp', 'off'];
/** 第五格在整張圖裡占的比例；開啟時圖表同步加高，其他格維持原本高度 */
const FC_SHARE = 0.2;
const withFc = (base: readonly number[], on: boolean) => (on ? [...base.map((x) => x * (1 - FC_SHARE)), FC_SHARE] : base);
const fcPctl = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `第 ${Math.round(p * 100)} 百分位`);
const fcNum = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
/** 依日期找外資資料列（當天或之前最近一個台股交易日） */
function fcIndexAt(rows: ForeignChipsFile['rows'], date: string): number | null {
  let lo = 0;
  let hi = rows.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]![0] <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function PolicyInflationPanel({ version, themeKey, foreign = null }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const endTextsRef = useRef<string[]>([]);
  /** 線尾標籤欄寬（px）；圖內標籤與讀數列用同一個值判斷「畫面右緣那一根」 */
  const gapPxRef = useRef(0);
  const near = useNearViewport(sectionRef);
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('pi-range', ['3M', '6M', '1Y', '5Y', '10Y', 'ALL'], '5Y'));
  const [extras, setExtras] = useState<Record<ExtraId, boolean>>(() => ({
    cpi: loadPref('pi-cpi', ['1', '0'] as const, '1') === '1',
    core_pce: loadPref('pi-pce', ['1', '0'] as const, '0') === '1',
    us2y: loadPref('pi-2y', ['1', '0'] as const, '1') === '1',
    us10y: loadPref('pi-10y', ['1', '0'] as const, '0') === '1',
  }));
  const [coreOn, setCoreOn] = useState(() => loadPref('pi-core', ['1', '0'] as const, '1') === '1');
  const [indexPick, setIndexPick] = useState<IndexPick>(() => loadPref<IndexPick>('pi-idx', INDEX_PICKS, 'spx'));
  // 第五格：外資買賣超／GDP 成長率／關（預設關、記住選擇；舊的外資開關 pi-fc 開著就沿用成「外資」）
  const [p5, setP5] = useState<P5>(() => loadPref<P5>('pi-p5', P5_PICKS, loadPref('pi-fc', ['1', '0'] as const, '0') === '1' ? 'fc' : 'off'));
  const pickP5 = (v: P5) => {
    setP5(v);
    savePref('pi-p5', v);
  };
  const fcRows = useMemo(() => (foreign?.rows ?? []).filter((r) => r[2] !== null), [foreign]);
  const fcOn = p5 === 'fc' && fcRows.length > 0;
  const [fxOn, setFxOn] = useState<Record<FxId, boolean>>(() => ({
    dxy: loadPref('pi-fx-dxy', ['1', '0'] as const, '0') === '1',
    twd: loadPref('pi-fx-twd', ['1', '0'] as const, '0') === '1',
  }));
  const [showEvents, setShowEvents] = useState(false);
  const [showCycles, setShowCycles] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  /** 往左拖曳後標籤欄左緣那一根的日期（沒拖曳＝null，讀數與標籤標最新值） */
  const [followTime, setFollowTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const files = useSeriesMap(near ? IDS : [], version);
  const { fed, coreCpi, cpi, corePce, us2y, us10y, gdpSaar, gdpNowPts, unrate, nrou, credit, hy, dxy, twd, indexBars } = useMemo(() => {
    const ready = (id: string) => (files[id]?.status === 'ready' ? files[id]!.data.data : null);
    const upper = ready('fed');
    return {
      fed: upper ? splicePolicyRate(upper, ready('fed_target_legacy') ?? []) : ([] as Point[]),
      coreCpi: ready('core_cpi') ? yoyPoints(ready('core_cpi')!) : ([] as Point[]),
      cpi: ready('cpi') ? yoyPoints(ready('cpi')!) : ([] as Point[]),
      corePce: ready('core_pce') ? yoyPoints(ready('core_pce')!) : ([] as Point[]),
      us2y: (ready('us2y') ?? []).map((b) => [b[0], b[4]] as Point),
      us10y: (ready('us10y') ?? []).map((b) => [b[0], b[4]] as Point),
      gdpSaar: (ready('gdp') ?? []).map((b) => [b[0], b[4]] as Point),
      gdpNowPts: (ready('gdpnow') ?? []).map((b) => [b[0], b[4]] as Point),
      unrate: (ready('unrate') ?? []).map((b) => [b[0], b[4]] as Point),
      nrou: (ready('nrou') ?? []).map((b) => [b[0], b[4]] as Point),
      credit: (ready('baa10y') ?? []).map((b) => [b[0], b[4]] as Point),
      hy: (ready('hy_oas') ?? []).map((b) => [b[0], b[4]] as Point),
      dxy: spliceCloses(ready('dxy') ?? []),
      twd: spliceUsdTwd(ready('usdtwd_legacy') ?? [], ready('usdtwd') ?? []),
      indexBars: Object.fromEntries(INDICES.map((i) => [i.id, ready(i.id) ?? []])) as Record<IndexId, Bar[]>,
    };
  }, [files]);
  // 美國實質 GDP：年化季增換算年增率（季度起始日）＋GDPNow 當季推估
  const gdpYoyPts = useMemo(() => gdpYoy(gdpSaar), [gdpSaar]);
  const nowcast = useMemo(() => gdpNowcast(gdpSaar, gdpNowPts), [gdpSaar, gdpNowPts]);
  const gdpOn = p5 === 'gdp' && gdpYoyPts.length > 0;
  const p5On = fcOn || gdpOn;
  // Fed 階段 vs 四個指數：階段區段、各段漲跌、循環第一次動作之後的表現（每個指數各算一份，表格並排）
  const equities = useMemo(() => {
    if (!fed.length) return null;
    const out = {} as Record<IndexId, ReturnType<typeof buildEquity> | null>;
    for (const i of INDICES) out[i.id] = indexBars[i.id].length ? buildEquity(fed, indexBars[i.id], unrate) : null;
    return out;
  }, [fed, indexBars, unrate]);
  // 降息性質判定：目前讀數（以 S&P 最新交易日為判定日）＋歷次第一次降息當時判定 vs 事後
  const cutRegime = useMemo(() => {
    const spxBars = indexBars.spx;
    if (!fed.length || !unrate.length || !spxBars.length) return null;
    const inp = { fed, unrate, credit, hy, coreCpi };
    const rows = assessCuts(inp, spxBars, indexBars.taiex);
    return { now: readingsAt(inp, spxBars.at(-1)![0]), rows, stats: verdictStats(rows), hasTaiex: indexBars.taiex.length > 0 };
  }, [fed, unrate, credit, hy, coreCpi, indexBars]);
  // Fed 立場卡：實質利率、泰勒缺口、2Y − Fed 目前讀數＋每月底樣本分組回測（自然失業率抓不到時泰勒那格顯示無資料）
  const stance = useMemo(() => {
    if (!fed.length || !coreCpi.length) return null;
    const inp = { fed, coreCpi, corePce, unrate, nrou, us2y };
    const now = stanceAt(inp, fed.at(-1)![0]);
    if (!now) return null;
    const samples = stanceSamples(inp, { spx: indexBars.spx, taiex: indexBars.taiex }, STANCE_FROM);
    return { now, stats: stanceStats(samples, STANCE_INDEX_IDS), baseline: stanceBaseline(samples, STANCE_INDEX_IDS), hasTaiex: indexBars.taiex.length > 0 };
  }, [fed, coreCpi, corePce, unrate, nrou, us2y, indexBars]);
  // 升息 × 美元／台幣 vs 加權：每個升息循環期間各走多少＋每月底樣本依台幣 3 個月變化分組
  const fxBt = useMemo(() => {
    const taiex = indexBars.taiex;
    if (!fed.length || !taiex.length || !twd.length) return null;
    const samples = fxSamples(fed, taiex, twd);
    const lastDate = taiex.at(-1)![0];
    const eq = equities?.taiex ?? null;
    const a = valueAtOrBefore(twd, rangeStart(lastDate, '3M')!);
    const b = valueAtOrBefore(twd, lastDate);
    const twd3m = a !== null && b !== null ? (b / a - 1) * 100 : null;
    return {
      cycles: hikeCycles(fed, taiex, dxy, twd),
      stats: fxStats(samples),
      from: samples[0]?.date.slice(0, 4) ?? '—',
      now: { date: lastDate, hike: eq ? phaseAt(eq.segments, lastDate) === 'hike' : false, twd3m },
    };
  }, [fed, indexBars, dxy, twd, equities]);
  // 第四格：DXY、USD/TWD 自區間起點起的累計 %（同一刻度）
  const fxLines = useMemo(() => {
    const last = fed.at(-1)?.[0];
    if (!last || !dxy.length || !twd.length || (!fxOn.dxy && !fxOn.twd)) return null;
    let d = fxPctLine(dxy, last, range);
    let t = fxPctLine(twd, last, range);
    if (!d || !t) return null;
    // 只開一條：畫原始價位（刻度＝點數／匯價），累計 % 只寫在圖例
    if (fxOn.dxy !== fxOn.twd) {
      const id: FxId = fxOn.dxy ? 'dxy' : 'twd';
      return { mode: 'raw' as const, id, raw: id === 'dxy' ? dxy : twd, line: id === 'dxy' ? d : t };
    }
    // 「全部」時兩序列起點不同（DXY 1971、台幣 1983）→ 以較晚的起點為共同基準
    if (d.baseDate !== t.baseDate) {
      const base = d.baseDate > t.baseDate ? d.baseDate : t.baseDate;
      const re = (pts: readonly Point[]) => {
        const i = pts.findIndex((p) => p[0] >= base);
        const b0 = pts[Math.max(0, i)]!;
        return { baseDate: b0[0], base: b0[1], points: pts.map(([x, v]) => [x, (v / b0[1] - 1) * 100] as Point), last: (pts.at(-1)![1] / b0[1] - 1) * 100 };
      };
      d = re(dxy);
      t = re(twd);
    }
    return { mode: 'pct' as const, dxy: d, twd: t };
  }, [fxOn, fed, dxy, twd, range]);
  const indexId: IndexId | null = indexPick === 'off' ? null : indexPick;
  const equity = indexId && equities ? equities[indexId] : null;
  const spx = indexId ? indexBars[indexId] : NO_BARS;
  const showSpx = equity !== null;
  const indexLabel = indexId ? INDICES.find((i) => i.id === indexId)!.label : '';
  const real = useMemo<RealRateRow[]>(() => realRateSeries(fed, coreCpi), [fed, coreCpi]);
  const summary = useMemo(() => summarize(fed, coreCpi), [fed, coreCpi]);
  const flip = useMemo(() => lastSignFlip(real), [real]);

  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('pi-range', r);
  };
  const pickIndex = (p: IndexPick) => {
    setIndexPick(p);
    savePref('pi-idx', p);
  };
  const toggleFx = (id: FxId) => {
    const next = { ...fxOn, [id]: !fxOn[id] };
    setFxOn(next);
    savePref(FX_LINES.find((f) => f.id === id)!.key, next[id] ? '1' : '0');
  };
  const toggleCore = () => {
    setCoreOn(!coreOn);
    savePref('pi-core', coreOn ? '0' : '1');
  };
  const toggleExtra = (id: ExtraId) => {
    const next = { ...extras, [id]: !extras[id] };
    setExtras(next);
    savePref(EXTRA_LINES.find((e) => e.id === id)!.key, next[id] ? '1' : '0');
  };

  const loaded = fed.length > 0 && coreCpi.length > 0;
  const hasFx = fxLines !== null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !loaded) return;
    const grid = cssVar('--grid');
    const textColor = cssVar('--text-3');
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const chart = createChart(host, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd' },
      timeScale: { ...TIME_AXIS, rightOffset: 2, fixLeftEdge: true, fixRightEdge: false, minBarSpacing: 0.05, borderColor: grid },
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
    const pct = { type: 'price' as const, precision: 2, minMove: 0.01 };
    const toData = (pts: readonly Point[]) => pts.map(([d, v]) => ({ time: d as Time, value: v }));
    // 軸上不放最新值標籤（區間短時刻度密，標籤一定會壓住刻度數字）；數值看上方讀數列，水平虛線標出位置
    // Y 軸至少涵蓋參考線，避免短區間把小幅變化放大成陡升、門檻線跑出畫面
    const includeRange = (lo: number, hi: number): AutoscaleInfoProvider => (original) => {
      const r = original();
      if (!r?.priceRange) return r;
      return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, lo), maxValue: Math.max(r.priceRange.maxValue, hi) } };
    };

    // 上窗格：Fed（階梯，深色粗線）、核心 CPI（強調色，可關）、整體 CPI（橘色實線）、核心 PCE（細線）、美債 2Y
    // 2% 目標線與 Y 軸涵蓋範圍掛在 Fed 序列：核心 CPI 關掉時目標線仍在
    // Fed 最新值的水平位置線不畫（和 2% 目標虛線長得一樣，容易看成另一條目標）；各線最新值改標在線尾
    const fedS = chart.addSeries(
      LineSeries,
      { color: cssVar('--text-1'), lineWidth: 2, lineType: LineType.WithSteps, priceFormat: pct, lastValueVisible: false, priceLineVisible: false, autoscaleInfoProvider: includeRange(FED_TARGET, FED_TARGET) },
      0,
    );
    fedS.setData(toData(fed));
    fedS.createPriceLine({
      price: FED_TARGET,
      color: textColor,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
    });
    const surface = cssVar('--surface');
    // 往左拖曳後標籤改標「標籤欄左緣那一根」當天（或之前最後一筆）的數值；那天還沒有資料就不標
    const follower =
      (pts: readonly Point[], fmt: (v: number) => string, colorAt?: (d: string) => string) =>
      (t: string) => {
        const v = valueAtOrBefore(pts, t);
        return v === null ? null : { price: v, text: fmt(v), ...(colorAt ? { color: colorAt(t) } : {}) };
      };
    const follow = () => followAnchor(chart.timeScale(), gapPxRef.current);
    // 線尾標籤：只標最新值（不帶名稱，留白才窄），靠外框顏色＝線色認線；排在最後一根右邊的留白裡（留白寬度見下方區間 effect）
    const ends: LineLabel[] = [];
    const addTop = (pts: readonly Point[], colorVar: string, width: 1 | 2, digits: number) => {
      const color = cssVar(colorVar);
      const s = chart.addSeries(LineSeries, { color, lineWidth: width, priceFormat: pct, lastValueVisible: false, priceLineVisible: false }, 0);
      s.setData(toData(pts));
      const last = pts.at(-1)!;
      ends.push({ price: last[1], text: last[1].toFixed(digits), color, endTime: last[0] as Time, at: follower(pts, (v) => v.toFixed(digits)) });
    };
    {
      const last = fed.at(-1)!;
      ends.push({ price: last[1], text: last[1].toFixed(2), color: cssVar('--text-1'), endTime: last[0] as Time, at: follower(fed, (v) => v.toFixed(2)) });
      // 2% 目標也標在同一欄（虛線一路畫到標籤），不另外蓋住左側的歷史線
      ends.push({ price: FED_TARGET, text: `${FED_TARGET}%`, color: textColor, endTime: last[0] as Time });
    }
    if (coreOn) addTop(coreCpi, '--accent', 2, 1);
    // 整體 CPI：實線（虛線只留給 2% 目標），原本的細虛線在手機上看不清楚
    if (extras.cpi && cpi.length > 0) addTop(cpi, '--ma60', 2, 1);
    if (extras.core_pce && corePce.length > 0) addTop(corePce, '--ma240', 1, 1);
    // 美債 2Y：市場對未來一年 Fed 利率的押注，跑在 Fed 階梯前面
    if (extras.us2y && us2y.length > 0) addTop(us2y, '--ma120', 1, 2);
    // 美債 10Y：長天期定價錨（房貸、企業借款、股票估值的折現率），比 2Y 更受成長與通膨預期、財政供給影響
    if (extras.us10y && us10y.length > 0) addTop(us10y, '--ma10', 1, 2);
    // 每格的線尾標籤共用同一段右側留白；allEnds 收集全部文字，用來算留白寬度
    const allEnds: string[] = [];
    // 標籤欄排在時間軸最後一根右邊：各格的線終點不同（月資料較早結束），取所有標籤終點裡最晚的那天
    let scaleEnd: string | null = null;
    const endLabels = (series: { attachPrimitive: (p: LineLabels) => void }, labels: LineLabel[]) => {
      if (!labels.length) return;
      allEnds.push(...labels.map((l) => l.text));
      for (const l of labels) if (typeof l.endTime === 'string' && (scaleEnd === null || l.endTime > scaleEnd)) scaleEnd = l.endTime;
      series.attachPrimitive(
        new LineLabels(labels, { color: cssVar('--text-1'), background: surface, border: textColor, fontSize: END_LABEL_FONT, fontFamily, align: 'right', stack: true, stackAt: () => scaleEnd as Time | null, follow }),
      );
    };
    endLabels(fedS, ends);

    // 中窗格：實質政策利率，0 以上緊縮方向、以下寬鬆方向
    const realS = chart.addSeries(
      BaselineSeries,
      {
        baseValue: { type: 'price', price: 0 },
        topLineColor: cssVar('--text-1'),
        topFillColor1: 'rgba(120, 120, 120, 0.25)',
        topFillColor2: 'rgba(120, 120, 120, 0.02)',
        bottomLineColor: cssVar('--accent'),
        bottomFillColor1: 'rgba(0, 0, 0, 0.02)',
        bottomFillColor2: 'rgba(42, 120, 214, 0.25)',
        lineWidth: 2,
        priceFormat: pct,
        lastValueVisible: false,
        autoscaleInfoProvider: includeRange(0, REAL_RATE_TIGHT),
      },
      1,
    );
    realS.setData(real.map((r) => ({ time: r[0] as Time, value: r[3] })));
    {
      const last = real.at(-1);
      const realFmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
      const realPts = real.map((r) => [r[0], r[3]] as Point);
      // 往左拖曳時：位置跟著線（月資料，取當月月底的 Fed），數字與讀數列一致（那一天的 Fed − 當時最新核心 CPI），
      // 否則 Fed 當月有動作時標籤與讀數列會差一碼
      const realAt = (t: string) => {
        const onLine = valueAtOrBefore(realPts, t);
        const f = valueAtOrBefore(fed, t);
        const c = valueAtOrBefore(coreCpi, t);
        return onLine === null || f === null || c === null ? null : { price: onLine, text: realFmt(f - c) };
      };
      if (last) endLabels(realS, [{ price: last[3], text: realFmt(last[3]), color: cssVar('--text-1'), endTime: last[0] as Time, at: realAt }]);
    }
    // 參考線只畫虛線，不加圖內文字與軸標籤（標籤會被圖表庫上下推開、蓋住最近的線），說明放在窗格標題
    for (const v of [0, REAL_RATE_TIGHT]) {
      realS.createPriceLine({ price: v, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }

    // 第三格：S&P 500（對數軸），線段顏色＝當日 Fed 階段（沿用景氣燈號五色，紅熱藍冷）
    if (showSpx && equity) {
      const colorOf = (d: string) => {
        const ph = phaseAt(equity.segments, d);
        return ph ? cssVar(PHASE_COLOR[ph]) : textColor;
      };
      const s = chart.addSeries(
        LineSeries,
        { color: cssVar('--text-1'), lineWidth: 2, priceFormat: { type: 'price', precision: 0, minMove: 1 }, lastValueVisible: false, priceLineVisible: false },
        2,
      );
      s.setData(spx.map((b) => ({ time: b[0] as Time, value: b[4], color: colorOf(b[0]) })));
      const last = spx.at(-1);
      const idxFmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });
      const idxPts = spx.map((b) => [b[0], b[4]] as Point);
      if (last) endLabels(s, [{ price: last[4], text: idxFmt(last[4]), color: colorOf(last[0]), endTime: last[0] as Time, at: follower(idxPts, idxFmt, colorOf) }]);
    }

    // 第四格（沒開指數時排第三格）：DXY 與 USD/TWD 自區間起點起的累計 %，同一刻度；0% 虛線＝起點
    const fxPane = showSpx ? 3 : 2;
    if (fxLines?.mode === 'pct') {
      const fxFormat = { type: 'custom' as const, minMove: 0.1, formatter: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%` };
      const dxyS = chart.addSeries(
        LineSeries,
        { color: cssVar(FX_COLOR.dxy), lineWidth: 2, priceFormat: fxFormat, lastValueVisible: false, priceLineVisible: false },
        fxPane,
      );
      dxyS.setData(toData(fxLines.dxy.points));
      const twdS = chart.addSeries(
        LineSeries,
        { color: cssVar(FX_COLOR.twd), lineWidth: 2, priceFormat: fxFormat, lastValueVisible: false, priceLineVisible: false, autoscaleInfoProvider: includeRange(0, 0) },
        fxPane,
      );
      twdS.setData(toData(fxLines.twd.points));
      twdS.createPriceLine({ price: 0, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
      const endOf = (pts: readonly Point[], colorVar: string): LineLabel[] => {
        const last = pts.at(-1);
        return last ? [{ price: last[1], text: fxFormat.formatter(last[1]), color: cssVar(colorVar), endTime: last[0] as Time, at: follower(pts, fxFormat.formatter) }] : [];
      };
      endLabels(twdS, [...endOf(fxLines.dxy.points, FX_COLOR.dxy), ...endOf(fxLines.twd.points, FX_COLOR.twd)]);
    } else if (fxLines) {
      // 只開一條：原始價位（DXY 點數／USD/TWD 匯價），不畫 0% 線
      const rawS = chart.addSeries(
        LineSeries,
        { color: cssVar(FX_COLOR[fxLines.id]), lineWidth: 2, priceFormat: pct, lastValueVisible: false, priceLineVisible: false },
        fxPane,
      );
      rawS.setData(toData(fxLines.raw));
      const last = fxLines.raw.at(-1);
      if (last) endLabels(rawS, [{ price: last[1], text: last[1].toFixed(2), color: cssVar(FX_COLOR[fxLines.id]), endTime: last[0] as Time, at: follower(fxLines.raw, (v) => v.toFixed(2)) }]);
    }
    // 第五格：外資買賣超（上市，億）＝單日柱（獨立刻度貼底）＋5 日細／20 日粗累計線，畫法同外資籌碼對照面板
    const fcPane = 2 + (showSpx ? 1 : 0) + (fxLines ? 1 : 0);
    // 或：美國實質 GDP 年增（季，階梯；0 以上紅、以下綠依漲跌色）＋GDPNow 推估（虛線段）
    if (gdpOn) {
      const lastDay = fed.at(-1)![0];
      const clampDay = (d: string) => (d > lastDay ? lastDay : d);
      const lastQ = gdpYoyPts.at(-1)!;
      // 最後一季畫滿整季（階梯線最後一點只是一個點）；下一季（GDPNow）另畫虛線段
      const gdpPts: Point[] = [...gdpYoyPts];
      const tail = clampDay(nextQuarter(lastQ[0]));
      if (tail > lastQ[0]) gdpPts.push([tail, lastQ[1]]);
      const up = cssVar('--up');
      const down = cssVar('--down');
      const gS = chart.addSeries(
        BaselineSeries,
        {
          baseValue: { type: 'price', price: 0 },
          lineType: LineType.WithSteps,
          topLineColor: up,
          topFillColor1: `${up}55`,
          topFillColor2: `${up}10`,
          bottomLineColor: down,
          bottomFillColor1: `${down}10`,
          bottomFillColor2: `${down}55`,
          lineWidth: 2,
          priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
          lastValueVisible: false,
          priceLineVisible: false,
          autoscaleInfoProvider: includeRange(0, 0),
        },
        fcPane,
      );
      gS.setData(toData(gdpPts));
      gS.createPriceLine({ price: 0, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
      const fmt = (v: number) => v.toFixed(1);
      const labels: LineLabel[] = [{ price: lastQ[1], text: fmt(lastQ[1]), color: lastQ[1] >= 0 ? up : down, endTime: gdpPts.at(-1)![0] as Time, at: follower(gdpPts, fmt) }];
      if (nowcast && nowcast.yoy !== null && nowcast.date === nextQuarter(lastQ[0])) {
        const nowColor = cssVar('--warn');
        const nS = chart.addSeries(
          LineSeries,
          { color: nowColor, lineWidth: 2, lineStyle: LineStyle.Dashed, lineType: LineType.WithSteps, priceFormat: { type: 'price', precision: 1, minMove: 0.1 }, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
          fcPane,
        );
        // 虛線段＝本季推估（從季初畫到今天）
        const nPts: Point[] = [[nowcast.date, nowcast.yoy]];
        const end = clampDay(nextQuarter(nowcast.date));
        if (end > nowcast.date) nPts.push([end, nowcast.yoy]);
        nS.setData(toData(nPts));
        labels.push({ price: nowcast.yoy, text: fmt(nowcast.yoy), color: nowColor, endTime: nPts.at(-1)![0] as Time });
      }
      endLabels(gS, labels);
    }
    if (fcOn) {
      const up = cssVar('--up');
      const down = cssVar('--down');
      const yi = { type: 'price', precision: 0, minMove: 1 } as const;
      const net = chart.addSeries(HistogramSeries, { priceFormat: yi, priceScaleId: 'pi-fc-net', priceLineVisible: false, lastValueVisible: false }, fcPane);
      net.setData(fcRows.map((r) => ({ time: r[0] as Time, value: r[2]!, color: r[2]! >= 0 ? `${up}aa` : `${down}aa` })));
      const cum5 = chart.addSeries(LineSeries, { color: cssVar('--warn'), lineWidth: 1, priceFormat: yi, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, fcPane);
      cum5.setData(fcRows.filter((r) => r[3] !== null).map((r) => ({ time: r[0] as Time, value: r[3]! })));
      const c20 = fcRows.filter((r) => r[4] !== null);
      const cum20 = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 2, priceFormat: yi, priceLineVisible: false, lastValueVisible: false }, fcPane);
      cum20.setData(c20.map((r) => ({ time: r[0] as Time, value: r[4]! })));
      cum20.createPriceLine({ price: 0, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
      const last = c20.at(-1);
      const pts = c20.map((r) => [r[0], r[4]!] as Point);
      const fmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });
      if (last) endLabels(cum20, [{ price: last[4]!, text: fmt(last[4]!), color: cssVar('--accent'), endTime: last[0] as Time, at: follower(pts, fmt) }]);
    }
    // priceScale(...).applyOptions 會把選項併進圖表層級預設，之後建立的窗格都繼承 → 所有窗格建好後再逐一設定
    if (showSpx || fxLines) {
      chart.priceScale('right', 0).applyOptions({ mode: PriceScaleMode.Normal });
      chart.priceScale('right', 1).applyOptions({ mode: PriceScaleMode.Normal });
      if (showSpx) chart.priceScale('right', 2).applyOptions({ mode: PriceScaleMode.Logarithmic });
      // 上方留給窗格標題、下方留給時間軸上緣，線不貼邊
      if (fxLines) chart.priceScale('right', fxPane).applyOptions({ mode: PriceScaleMode.Normal, scaleMargins: { top: 0.22, bottom: 0.1 } });
    }
    if (gdpOn) chart.priceScale('right', fcPane).applyOptions({ mode: PriceScaleMode.Normal, scaleMargins: { top: 0.22, bottom: 0.08 } });
    if (fcOn) {
      chart.priceScale('right', fcPane).applyOptions({ mode: PriceScaleMode.Normal, scaleMargins: { top: 0.22, bottom: 0.08 } });
      // 單日柱：獨立刻度壓在窗格下半部，否則被 ±上兆的累計線壓扁
      chart.priceScale('pi-fc-net', fcPane).applyOptions({ visible: false, scaleMargins: { top: 0.6, bottom: 0 } });
    }

    const wm = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) createTextWatermark(pane, { horzAlign: 'left', vertAlign: 'top', lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }] });
    };
    wm(0, `Fed 利率 vs 通膨年增（%）｜虛線 2% 目標`);
    wm(1, `實質＝Fed − 核心CPI（pp）｜虛線 +${REAL_RATE_TIGHT} 緊縮、0 中性`);
    if (showSpx) wm(2, `${indexLabel}（對數）｜線色＝Fed 階段（見圖例、下表）`);
    // 文字太長圖表庫會整行縮小到看不清楚 → 只留一句，基準日與數值看上方圖例
    if (fxLines) wm(fxPane, fxLines.mode === 'pct' ? '美元／台幣 累計 %｜藍線往上＝台幣貶' : FX_RAW_TITLE[fxLines.id]);
    if (fcOn) wm(fcPane, '外資買賣超（上市，億）｜柱＝單日、粗線＝20日累計');
    if (gdpOn) wm(fcPane, '美國實質GDP 年增（%，季）｜橘虛線＝GDPNow');

    const handler = (param: MouseEventParams<Time>) => setHoverTime(typeof param.time === 'string' ? param.time : null);
    chart.subscribeCrosshairMove(handler);
    attachTimeAxis(chart);
    chartRef.current = chart;
    endTextsRef.current = allEnds;
    setChartGen((g) => g + 1);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      chart.remove();
      chartRef.current = null;
    };
  }, [loaded, fed, coreCpi, cpi, corePce, us2y, us10y, spx, equity, showSpx, indexLabel, real, extras, coreOn, fxLines, fcOn, fcRows, gdpOn, gdpYoyPts, nowcast, themeKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = fed.at(-1);
    if (!chart || !last) return;
    const start = rangeStart(last[0], range);
    const ts = chart.timeScale();
    // 右側留白＝最寬的線尾標籤＋邊距（像素），換算成 K 棒數；fixRightEdge 會吃掉留白，所以自己限制右界：
    // 往左拖不會拉出更多空白
    const gapPx = endLabelGapPx(endTextsRef.current, getComputedStyle(document.body).fontFamily);
    gapPxRef.current = gapPx;
    let maxTo = Infinity;
    // 讀數列跟著圖內標籤：往左拖曳後改顯示標籤欄左緣那一根的日期
    const syncFollow = () => setFollowTime(followAnchor(ts, gapPx)?.time ?? null);
    const clamp = () => {
      const r = ts.getVisibleLogicalRange();
      if (r && r.to > maxTo + 0.01) ts.setVisibleLogicalRange({ from: r.from - (r.to - maxTo), to: maxTo });
      else syncFollow();
    };
    const apply = () => {
      resetPriceScales(chart);
      resetPaneStretch(chart, withFc(showSpx ? (hasFx ? PANE_STRETCH_SPX_FX : PANE_STRETCH_SPX) : hasFx ? PANE_STRETCH_FX : PANE_STRETCH, p5On));
      const lastIdx = ts.timeToIndex('9999-12-31' as Time, true);
      const fromIdx = !start || start <= fed[0]![0] ? 0 : ts.timeToIndex(start as Time, true);
      if (lastIdx === null || fromIdx === null) {
        ts.fitContent();
        return;
      }
      const gap = rightGapBars(ts.width(), lastIdx - fromIdx, gapPx);
      maxTo = Infinity;
      // 兩端都固定時圖表庫會自動把最小 K 棒寬降到「剛好放得下全部」；右端改成自己限制後要自己算，
      // 否則「全部」（一萬多根）會被預設下限卡住、只顯示一小段
      const fitAll = (ts.width() - gapPx) / (lastIdx + 1);
      ts.applyOptions({ rightOffset: gap, minBarSpacing: fitAll > 0 ? Math.min(0.05, fitAll * 0.98) : 0.05 });
      ts.setVisibleLogicalRange({ from: fromIdx, to: lastIdx + gap });
      maxTo = lastIdx + gap;
      syncFollow();
    };
    apply();
    const raf = requestAnimationFrame(apply);
    ts.subscribeVisibleLogicalRangeChange(clamp);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(clamp);
    };
  }, [chartGen, range, resetKey, fed, showSpx, hasFx, p5On]);

  // 圖例：十字線所在日期；沒有十字線時，往左拖曳過＝畫面右緣（標籤欄左緣）那一根，否則最新
  const legend = useMemo(() => {
    if (!loaded) return null;
    // 最新：取畫面上各條日資料線裡最晚的一天（FRED 的 Fed 常晚一天，加權／台幣當天就有），Fed／CPI 沿用前一筆
    let latest = fed.at(-1)![0];
    const bump = (d: string | undefined) => {
      if (d && d > latest) latest = d;
    };
    if (showSpx) bump(spx.at(-1)?.[0]);
    if (fxLines) {
      if (fxLines.mode === 'pct') {
        bump(fxLines.dxy.points.at(-1)?.[0]);
        bump(fxLines.twd.points.at(-1)?.[0]);
      } else bump(fxLines.raw.at(-1)?.[0]);
    }
    const date = hoverTime ?? followTime ?? latest;
    const at = (pts: readonly Point[]) => (pts.length ? valueAtOrBefore(pts, date) : null);
    const fedV = at(fed);
    const coreV = at(coreCpi);
    const y2 = extras.us2y ? at(us2y) : null;
    // 10Y、GDP 讀數常駐（不看線開不開）；GDP 取十字線那天所在季度（或之前最後一季）
    const y10 = at(us10y);
    const y2all = at(us2y);
    const gq = (() => {
      let k = -1;
      for (let i = gdpYoyPts.length - 1; i >= 0; i--) if (gdpYoyPts[i]![0] <= date) { k = i; break; }
      if (k < 0) return null;
      const d = gdpYoyPts[k]![0];
      return { date: d, yoy: gdpYoyPts[k]![1], saar: valueAtOrBefore(gdpSaar, d) };
    })();
    const spxV = showSpx ? valueAtOrBefore(spx.map((b) => [b[0], b[4]] as Point), date) : null;
    const phase = showSpx && equity ? phaseAt(equity.segments, date) : null;
    // 十字線所在日期當時的最後一次動作
    const move = showSpx && equity ? [...fedMoves(fed)].reverse().find((m) => m.trend && m.date <= date) ?? null : null;
    return {
      date,
      fed: fedV,
      core: coreV,
      cpi: extras.cpi ? at(cpi) : null,
      pce: extras.core_pce ? at(corePce) : null,
      real: fedV !== null && coreV !== null ? fedV - coreV : null,
      us2y: y2,
      spread2y: y2 !== null && fedV !== null ? y2 - fedV : null,
      us10y: y10,
      curve: y10 !== null && y2all !== null ? y10 - y2all : null,
      gdp: gq,
      nowcast: nowcast && date >= nowcast.date ? nowcast : null,
      spx: spxV,
      phase,
      move,
      sinceMove: move ? daysBetween(move.date, date) : null,
      fx: !fxLines
        ? null
        : fxLines.mode === 'pct'
          ? { mode: 'pct' as const, base: fxLines.twd.baseDate, dxy: valueAtOrBefore(fxLines.dxy.points, date), twd: valueAtOrBefore(fxLines.twd.points, date), rate: valueAtOrBefore(twd, date) }
          : { mode: 'raw' as const, id: fxLines.id, base: fxLines.line.baseDate, value: valueAtOrBefore(fxLines.raw, date), change: valueAtOrBefore(fxLines.line.points, date) },
    };
  }, [loaded, hoverTime, followTime, fed, coreCpi, cpi, corePce, us2y, us10y, gdpYoyPts, gdpSaar, nowcast, spx, equity, showSpx, extras, fxLines, twd]);
  const currentPhase = equity ? phaseAt(equity.segments, spx.at(-1)![0]) : null;
  // 2Y − Fed：低於 −0.25pp 市場押降息、高於 +0.25pp 押升息（約一碼）
  const spreadText = (v: number | null) =>
    v === null ? '' : v <= -0.25 ? '市場押降息' : v >= 0.25 ? '市場押升息' : '市場押不變';

  const failed = IDS.flatMap((id) =>
    files[id]?.status === 'error' && !OPTIONAL_IDS.has(id) ? [`${id}：${(files[id] as { error: string }).error}`] : [],
  );

  return (
    <section ref={sectionRef} id="sec-pi" className="regime ms pi" aria-label="政策利率與通膨">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">政策利率 vs 通膨（參考）</span>
        </div>
        {summary && (
          <span className="small muted num">
            Fed {summary.fedDate}｜核心CPI {ym(summary.inflationDate)}
          </span>
        )}
      </div>

      {summary && (
        <p className={`score num pi-state pi-${summary.state}`}>
          實質政策利率 <b>{fpp(summary.real)}</b>（Fed {f2(summary.fed)}% − 核心CPI {f1(summary.inflation)}%）→ {REAL_RATE_STATE_TEXT[summary.state]}
          ｜核心CPI 距 2% 目標 {fpp(summary.gapToTarget)}
          {flip && (
            <>
              ｜實質利率 {ym(flip.date)} 轉{flip.to === 'positive' ? '正' : '負'}
            </>
          )}
        </p>
      )}

      <PanelNote>
        <p className="small muted ms-rule">
        看 Fed 跟通膨的距離，不看方向：實質政策利率（Fed − 核心CPI）小於 0 是寬鬆，Fed 歷來不會在這裡停止升息；大於 +1pp 才算緊縮，才有降息空間。
        2000、2006、2019、2023 幾次升息頂點都出現在實質利率翻正之後，但翻正不等於馬上降息（2023 翻正後又撐了一年）。
        核心 CPI 是落後指標；整體 CPI 用來解釋油價飆時 Fed 為什麼不動，核心 PCE 是 Fed 正式目標但晚兩週。
        圖上每一格各線尾端的小標籤是最新值（只標數字，外框顏色＝線色、對照上方晶片的顏色認線，排在圖表右側留白，月資料的線較早結束、用細線連過去；擠在一起時上下錯開），灰框「2%」標的是 Fed 的通膨目標虛線；往左拖曳看舊資料時，標籤改標「畫面右緣那一天」的數值（月資料取當月或之前最後一筆），右緣標籤欄會蓋一層淡底色，上方讀數列也換成那一天、日期變橘色加「◀」提醒不是最新值，「↺ 重設」會變成「↻ 回最新」，按下回到最新；讀數列「核心距 2%」是十字線那天核心 CPI 離目標多遠。
        核心 CPI 的線可以關掉專心看整體 CPI，但關掉只是不畫線：實質利率、緊縮／寬鬆判讀一律以核心 CPI 計，不要拿圖上「Fed − 整體 CPI」的距離來讀（油價飆時整體 CPI 會讓 Fed 看起來不夠緊，那不是 Fed 的算法）。
        美債 2Y 是市場對未來一年 Fed 利率的押注，通常跑在 Fed 階梯前面：2Y 低於 Fed 一碼以上＝押降息、高於一碼以上＝押升息；它比 CPI 早反應，但押錯也常見（2024 上半年押六次降息，實際三次）。
        第三格指數（S&P 500／NASDAQ／費半／加權，一次看一個）的線色是 Fed 階段（升息期／高原／降息期／谷底；超過 6 個月沒動作算暫停）。1982 年起四個階段 S&P 年化都是正的，階段本身不是方向訊號；差別在「為什麼降息」：降息後一年內失業率觸發 Sahm 規則的衰退式降息（2001、2007）之後一年 S&P 是負的，保險式降息（1995、1998、2019、2024）則續漲——分類器是失業率和 2Y−Fed，不是 Fed 動作本身。
        「降息性質判定」用降息當天看得到的資料判：就業（Sahm 值 ≥ 0.5）與信用（Baa 公司債 − 美債 10Y ≥ 3.5pp）兩個都到才叫衰退式、只到一個是衰退警訊（例如 2024-09 只有就業到），通膨（核心 CPI 距 2% 超過 1pp）另外標「未解」＝停滯型風險；門檻事先定、不依結果調整，利差單獨看太吵（2011、2016 到過 3.4pp 沒衰退）。高收益債利差 FRED 只給近 3 年，只顯示不進規則。
        四個指數高度連動（費半對加權 ρ60 約 0.66），四欄同向不是四個證據；費半 1994、加權 1997 起，循環次數只有 S&P 的一半，加權對 Fed 的傳導還隔著台幣與外資。
        第四格的 DXY、USD/TWD 可各自開關：兩條都開時換成自區間起點起的累計 %（同一刻度，方便比誰動得多）；只開一條時畫原始價位（DXY 點數／匯價），累計 % 寫在圖例；都關就不顯示。USD/TWD 往上＝台幣貶；第三格切到加權就能三者一起看。
        下方「升息 × 台幣」表：升息期裡台幣 3 個月貶 2% 以上的月份，加權之後 3 個月平均較差、跌逾 10% 的比例約是升息期其他月份的兩倍，但一年後沒有比較差；非升息期台幣貶反而常是恐慌尾聲。壞的月份集中在 1997、2000、2018、2022 四次，2004～2006、2016、2023 台幣貶之後照漲——是風險提示，不是崩盤訊號，不計分。USD/TWD 用 FRED 日資料（1983 起），最近幾天以 Yahoo 補。
        「Fed 立場」卡把三把尺排在一起：實質利率（Fed − 核心CPI）、泰勒缺口、美債 2Y − Fed。泰勒法則是 1993 年 John Taylor 提的公式，用通膨和就業算「利率該在哪」：法則利率＝2 ＋ 核心PCE ＋ 0.5 ×（核心PCE − 2）＋ 0.5 × 產出缺口，產出缺口用 2 ×（自然失業率 − 失業率）換算，自然失業率是美國國會預算局（CBO）的估計。缺口＝法則利率 − Fed：正的代表 Fed 比公式低（偏鬆、落後通膨），負的代表 Fed 比公式高（偏緊）。公式裡的 2（中性實質利率）和係數是主觀設定，換一組數字結果差 1～2pp，所以門檻放寬到 ±1pp，只看大方向。
        回測（1987 年起每月底）：泰勒缺口 ≥ +1 時之後 12 個月 Fed 升息的比例約六成（全部月份約四成）；2Y − Fed ≤ −0.25 時之後降息約八成半，是三把尺裡對 Fed 下一步最準的；但三把尺對 S&P、加權之後 12 個月報酬都沒有穩定的分組差異——它們回答的是「Fed 接下來往哪走」，不是「股市往哪走」，不計分。
        美債 10Y（粉紅線，預設關）是長天期利率的定價錨：房貸、企業借款與股票估值都拿它折現，10Y 急升最傷高本益比的科技股；2Y 看 Fed 預期、10Y 還多了成長、通膨預期與美債供給。讀數列的 10Y−2Y 是殖利率曲線斜率：小於 0 叫倒掛，1978 年起每次美國衰退前都倒掛過，但領先 6～24 個月、2022～2024 長期倒掛也沒衰退，只當背景、不當進出場訊號；利差依規則審查不計分。
        第五格可切「GDP 成長率」：美國實質 GDP 的年增率（季資料，由 BEA 的年化季增連乘四季換算，和官方年增差 0.1pp 內；不畫年化季增是因為 2020 年單季 −28%／+35% 會把刻度撐爆）；線畫在該季期間，但實際公布晚約一個月、之後還會修正，是落後指標，只用來確認「擴張還是衰退」的大背景。橘色虛線段是亞特蘭大 Fed 的 GDPNow 對當季的即時估計，配上前三季實際值換算成推估年增；GDPNow 季初波動大、越接近公布越準。讀數列的 GDP 一律常駐顯示。
        這張圖與「Fed 120 天」「核心CPI ±0.2pp」規則重疊，只用來解釋 FOMC 為什麼那樣做，不計分。2008 年前 Fed 為單一目標利率。
      </p>
      </PanelNote>

      <div className="cp-mas" role="group" aria-label="通膨序列">
        <button type="button" className="ma-chip" aria-pressed={coreOn} onClick={toggleCore}>
          <i className="swatch" style={{ background: 'var(--accent)' }} />
          核心 CPI
        </button>
        {EXTRA_LINES.map((e) => (
          <button key={e.id} type="button" className="ma-chip" aria-pressed={extras[e.id]} onClick={() => toggleExtra(e.id)}>
            <i className="swatch" style={{ background: EXTRA_COLOR[e.id] }} />
            {e.label}
          </button>
        ))}
      </div>
      <div className="cp-mas" role="group" aria-label="第三格指數">
        <span className="small muted">第三格</span>
        {INDICES.map((i) => (
          <button key={i.id} type="button" className="ma-chip" aria-pressed={indexPick === i.id} onClick={() => pickIndex(i.id)}>
            {i.label}
          </button>
        ))}
        <button type="button" className="ma-chip" aria-pressed={indexPick === 'off'} onClick={() => pickIndex('off')}>
          關
        </button>
      </div>
      <div className="cp-mas" role="group" aria-label="第四格美元與台幣">
        <span className="small muted">第四格</span>
        {FX_LINES.map((f) => (
          <button key={f.id} type="button" className="ma-chip" aria-pressed={fxOn[f.id]} onClick={() => toggleFx(f.id)}>
            <i className="swatch" style={{ background: `var(${FX_COLOR[f.id]})` }} />
            {f.label}
          </button>
        ))}
        <span className="small muted">{fxOn.dxy && fxOn.twd ? '兩條＝累計 %' : fxOn.dxy || fxOn.twd ? '一條＝原始價位' : '都關＝不顯示'}</span>
      </div>
      {(fcRows.length > 0 || gdpYoyPts.length > 0) && (
        <div className="cp-mas" role="group" aria-label="第五格">
          <span className="small muted">第五格</span>
          {fcRows.length > 0 && (
            <button type="button" className="ma-chip" aria-pressed={p5 === 'fc'} onClick={() => pickP5('fc')}>
              <i className="swatch" style={{ background: 'var(--accent)' }} />
              外資買賣超
            </button>
          )}
          {gdpYoyPts.length > 0 && (
            <button type="button" className="ma-chip" aria-pressed={p5 === 'gdp'} onClick={() => pickP5('gdp')}>
              <i className="swatch" style={{ background: 'var(--up)' }} />
              GDP 成長率
            </button>
          )}
          <button type="button" className="ma-chip" aria-pressed={p5 === 'off'} onClick={() => pickP5('off')}>
            關
          </button>
          <span className="small muted">
            {fcOn ? `上市，${fcRows[0]![0].slice(0, 4)} 起` : gdpOn ? `美國實質，年增 %，${gdpYoyPts[0]![0].slice(0, 4)} 起` : ''}
          </span>
        </div>
      )}

      <div className="seg" role="group" aria-label="時間區間">
        {RANGES.map((r) => (
          <button key={r.k} type="button" aria-pressed={range === r.k} onClick={() => pickRange(r.k)}>
            {r.label}
          </button>
        ))}
        <button
          type="button"
          className={followTime ? 'pi-back' : undefined}
          onClick={() => setResetKey((k) => k + 1)}
          aria-label={followTime ? '回到最新資料' : '重設圖表縮放'}
          title={followTime ? '回到最新資料並重設縮放' : '重設縮放'}
        >
          {followTime ? '↻ 回最新' : '↺ 重設'}
        </button>
      </div>

      {failed.length > 0 && <p className="small warn">載入失敗：{failed.join('；')}</p>}

      {!near || (!loaded && failed.length === 0) ? (
        <p className="cp-msg muted">載入中…</p>
      ) : !loaded ? (
        <p className="cp-msg warn">無法載入 Fed 或核心 CPI 資料</p>
      ) : (
        <div className="pricechart ms-chart">
          {legend && (
            <div className="legend num cm-legend" aria-live="off">
              <div>
                {followTime && !hoverTime ? (
                  <span className="pi-follow" title="往左拖曳中：讀數與圖內標籤是畫面右緣這一天的數值，不是最新值">◀ {legend.date}</span>
                ) : (
                  <span className="muted">{legend.date}</span>
                )}{' '}
                Fed <b>{f2(legend.fed)}%</b>
                {coreOn && <> ｜ 核心CPI <b>{f1(legend.core)}%</b></>}
                {legend.cpi !== null && <> ｜ CPI {coreOn ? `${f1(legend.cpi)}%` : <b>{f1(legend.cpi)}%</b>}</>}
                {legend.pce !== null && <> ｜ 核心PCE {f1(legend.pce)}%</>}
              </div>
              <div>
                實質 <b>{fpp(legend.real)}</b>
                {legend.real !== null && <span className="muted"> ｜ {REAL_RATE_STATE_TEXT[legend.real < 0 ? 'loose' : legend.real >= REAL_RATE_TIGHT ? 'tight' : 'mid']}</span>}
                {legend.core !== null && <span className="muted"> ｜ 核心距 {FED_TARGET}% {fpp(legend.core - FED_TARGET)}</span>}
                {!coreOn && <span className="muted"> ｜ 以核心CPI {f1(legend.core)}% 計（線已關）</span>}
              </div>
              {legend.us2y !== null && (
                <div>
                  美債2Y <b>{f2(legend.us2y)}%</b> ｜ 2Y−Fed <b>{fpp(legend.spread2y)}</b>
                  <span className="muted"> ｜ {spreadText(legend.spread2y)}</span>
                </div>
              )}
              {(legend.us10y !== null || legend.gdp) && (
                <div>
                  {legend.us10y !== null && (
                    <>
                      美債10Y <b>{f2(legend.us10y)}%</b>
                      {legend.curve !== null && (
                        <>
                          {' '}｜ 10Y−2Y <b>{fpp(legend.curve)}</b> <span className="muted">{curveText(legend.curve)}</span>
                        </>
                      )}
                    </>
                  )}
                  {legend.us10y !== null && legend.gdp && ' ｜ '}
                  {legend.gdp && (
                    <>
                      GDP 年增 <b className={legend.gdp.yoy > 0 ? 'up' : legend.gdp.yoy < 0 ? 'down' : ''}>{f1(legend.gdp.yoy)}%</b>
                      <span className="muted">（{quarterLabel(legend.gdp.date)}，季增年化 {f1(legend.gdp.saar)}%）</span>
                    </>
                  )}
                  {legend.nowcast && (
                    <>
                      {' '}｜ GDPNow {quarterLabel(legend.nowcast.date)} <b>{f1(legend.nowcast.saar)}%</b>
                      {legend.nowcast.yoy !== null && <span className="muted">（推估年增 {f1(legend.nowcast.yoy)}%）</span>}
                    </>
                  )}
                </div>
              )}
              {legend.spx !== null && (
                <div>
                  {indexLabel} <b>{legend.spx.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>
                  {legend.phase && (
                    <>
                      {' '}｜ <i className="lamp" style={{ background: `var(${PHASE_COLOR[legend.phase]})` }} aria-hidden="true" />
                      {PHASE_TEXT[legend.phase]}
                    </>
                  )}
                  {legend.move && (
                    <span className="muted">
                      {' '}｜ 上次動作 {legend.move.date} {legend.move.bp > 0 ? '+' : ''}{legend.move.bp}bp（{Math.round((legend.sinceMove ?? 0) / 30.44)} 個月前）
                    </span>
                  )}
                </div>
              )}
              {legend.fx?.mode === 'pct' && (
                <div>
                  <span className="muted">自 {baseDateLabel(legend.fx.base, legend.date)} 起</span>{' '}
                  <i className="swatch" style={{ background: `var(${FX_COLOR.dxy})` }} aria-hidden="true" /> DXY <b>{signed(legend.fx.dxy)}</b> ｜{' '}
                  <i className="swatch" style={{ background: `var(${FX_COLOR.twd})` }} aria-hidden="true" /> USD/TWD <b>{signed(legend.fx.twd)}</b>
                  {legend.fx.rate !== null && <span className="muted">（{legend.fx.rate.toFixed(2)}）</span>}
                  {legend.fx.twd !== null && (
                    <span className="muted"> ｜ 台幣{legend.fx.twd > 0 ? '貶' : legend.fx.twd < 0 ? '升' : '持平'}</span>
                  )}
                </div>
              )}
              {fcOn && foreign && (() => {
                const k = fcIndexAt(foreign.rows, legend.date);
                const r = k === null ? null : foreign.rows[k]!;
                if (!r || r[2] === null) return <div>外資買賣超 —</div>;
                const cls = (v: number | null) => (v === null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
                return (
                  <div>
                    外資 <b className={cls(r[2])}>{fcNum(r[2])}</b> 億 ｜ 5日 <span className={cls(r[3])}>{fcNum(r[3])}</span> ｜ 20日 <b className={cls(r[4])}>{fcNum(r[4])}</b>
                    <span className="muted">（{fcPctl(foreign.pctl.cum20[k!])}）</span>
                    {r[0] !== legend.date && <span className="muted"> ｜ {r[0].slice(5)}</span>}
                  </div>
                );
              })()}
              {legend.fx?.mode === 'raw' && (
                <div>
                  <i className="swatch" style={{ background: `var(${FX_COLOR[legend.fx.id]})` }} aria-hidden="true" />{' '}
                  {legend.fx.id === 'dxy' ? 'DXY' : 'USD/TWD'} <b>{f2(legend.fx.value)}</b>
                  <span className="muted">
                    {' '}｜ 自 {baseDateLabel(legend.fx.base, legend.date)} 起 {signed(legend.fx.change)}
                    {legend.fx.id === 'twd' && legend.fx.change !== null && <>（台幣{legend.fx.change > 0 ? '貶' : legend.fx.change < 0 ? '升' : '持平'}）</>}
                  </span>
                </div>
              )}
            </div>
          )}
          <div ref={hostRef} className={`chart-host pi-host${hasFx ? (showSpx ? ' pi-host-4' : ' pi-host-3') : ''}${p5On ? ' pi-host-fc' : ''}`} />
        </div>
      )}

      {stance && (
        <FedStanceCard now={stance.now} stats={stance.stats} baseline={stance.baseline} fromYear={STANCE_FROM.slice(0, 4)} hasTaiex={stance.hasTaiex} />
      )}

      {cutRegime && (
        <CutRegimeCard
          now={cutRegime.now}
          phase={equities?.spx ? phaseAt(equities.spx.segments, indexBars.spx.at(-1)![0]) : null}
          rows={cutRegime.rows}
          stats={cutRegime.stats}
          hasTaiex={cutRegime.hasTaiex}
        />
      )}

      {showSpx && equity && equities && (
        <>
          <div className="table-wrap">
            <table className="bt-table num">
              <caption className="small muted">
                Fed 階段 vs 指數：各段年化報酬平均（段為正的比例）；不足 3 個月的段不算。資料起點
                {INDICES.map((i) => ` ${i.short} ${equities[i.id]?.segments[0]?.from.slice(0, 4) ?? '—'}`).join('、')}
              </caption>
              <thead>
                <tr>
                  <th>階段</th>
                  {INDICES.map((i) => (
                    <th key={i.id} className={`r${i.id === indexId ? ' hl' : ''}`}>{i.short}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {equity.stats.map((st, k) => (
                  <tr key={st.phase} className={st.phase === currentPhase ? 'hl' : ''}>
                    <td>
                      <i className="lamp" style={{ background: `var(${PHASE_COLOR[st.phase]})` }} aria-hidden="true" />
                      {PHASE_TEXT[st.phase]}
                    </td>
                    {INDICES.map((i) => {
                      const x = equities[i.id]?.stats[k];
                      return (
                        <td key={i.id} className="r">
                          {pctCell(x?.avgAnnualized ?? null)}
                          <br />
                          <span className="small muted">{x?.upShare === null || x?.upShare === undefined ? '—' : `${x.upShare.toFixed(0)}%`}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table className="bt-table num">
              <caption className="small muted">
                循環第一次降息／升息之後 12 個月報酬（12 個月內最大跌幅・次數）。衰退式＝降息後 12 個月內失業率觸發 Sahm 規則（≥ {SAHM_TRIGGER}pp），保險式＝未觸發
              </caption>
              <thead>
                <tr>
                  <th>事件</th>
                  {INDICES.map((i) => (
                    <th key={i.id} className={`r${i.id === indexId ? ' hl' : ''}`}>{i.short}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {equity.eventStats.map((st, k) => (
                  <tr key={st.label}>
                    <td>{st.label}</td>
                    {INDICES.map((i) => {
                      const x = equities[i.id]?.eventStats[k];
                      return (
                        <td key={i.id} className="r">
                          {pctCell(x?.avg12m ?? null)}
                          <br />
                          <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                            {pctCell(x?.avgDrawdown ?? null)}・{x?.n ?? 0}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="linkbtn small" onClick={() => setShowEvents(!showEvents)} aria-expanded={showEvents}>
            {showEvents ? '收起' : '展開'}歷次循環起點・{indexLabel}（{equity.events.length}）
          </button>
          {showEvents && (
            <div className="table-wrap">
              <table className="bt-table num">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>動作</th>
                    <th className="r">Fed</th>
                    <th className="r">3月</th>
                    <th className="r">12月</th>
                    <th className="r">最大跌幅</th>
                    <th className="r">Sahm</th>
                  </tr>
                </thead>
                <tbody>
                  {equity.events.map((e) => (
                    <tr key={e.date}>
                      <td>{e.date}</td>
                      <td>
                        {e.kind === 'cut' ? '降息' : '升息'} {e.bp > 0 ? '+' : ''}{e.bp}bp
                        {e.kind === 'cut' && e.recession === true && <span className="warn">・衰退式</span>}
                        {e.kind === 'cut' && e.recession === false && <span className="muted">・保險式</span>}
                      </td>
                      <td className="r">{f2(e.rate)}%</td>
                      <td className="r">{pctCell(e.ret3m)}</td>
                      <td className="r">{pctCell(e.ret12m)}</td>
                      <td className="r">{pctCell(e.maxDrawdown)}</td>
                      <td className="r">{e.sahmMax === null ? '—' : e.sahmMax.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {fxBt && (
        <>
          <div className="table-wrap">
            <table className="bt-table num">
              <caption className="small muted">
                升息 × 台幣 vs 加權（{fxBt.from} 起，每月最後一個交易日取樣）：依當時 USD/TWD 過去 {FX_LOOKBACK_MONTHS} 個月變化分組，看加權之後 3、12 個月平均報酬（3 個月上漲比例）、3
                個月內最深跌幅平均（曾跌逾 {-CRASH_PCT}% 的比例）。
                {fxBt.now.twd3m !== null && (
                  <>
                    {' '}目前（{fxBt.now.date}）：{fxBt.now.hike ? '升息期' : '非升息期'}、USD/TWD 近 3 個月 <b>{signed(fxBt.now.twd3m)}</b>
                  </>
                )}
              </caption>
              <thead>
                <tr>
                  <th>台幣 3 個月</th>
                  <th className="r">月數</th>
                  <th className="r">之後 3月</th>
                  <th className="r">之後 12月</th>
                  <th className="r">3月內最深</th>
                </tr>
              </thead>
              <tbody>
                {(['hike', 'other'] as const).map((k) => (
                  <FxRows key={k} title={k === 'hike' ? '升息期' : '其他時期'} rows={fxBt.stats[k]} current={fxBt.now.hike === (k === 'hike') ? fxBt.now.twd3m : null} />
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="linkbtn small" onClick={() => setShowCycles(!showCycles)} aria-expanded={showCycles}>
            {showCycles ? '收起' : '展開'}歷次升息循環：美元、台幣、加權各走多少（{fxBt.cycles.length}）
          </button>
          {showCycles && (
            <div className="table-wrap">
              <table className="bt-table num">
                <caption className="small muted">
                  期間＝第一次升息日 → 最後一次升息後 6 個月（升息期結束）；最大跌幅＝期間內加權自高點的最深收盤跌幅
                </caption>
                <thead>
                  <tr>
                    <th>升息循環</th>
                    <th className="r">升息</th>
                    <th className="r">DXY</th>
                    <th className="r">USD/TWD</th>
                    <th className="r">加權</th>
                    <th className="r">最大跌幅</th>
                  </tr>
                </thead>
                <tbody>
                  {fxBt.cycles.map((c) => (
                    <tr key={c.from} className={c.ongoing ? 'hl' : ''}>
                      <td>
                        {c.from.slice(0, 7)}
                        <br />
                        <span className="small muted">～{c.ongoing ? '進行中' : c.to.slice(0, 7)}</span>
                      </td>
                      <td className="r">
                        +{c.bp}bp
                        <br />
                        <span className="small muted">{c.hikes} 次</span>
                      </td>
                      <td className="r">{pctCell(c.dxy)}</td>
                      <td className="r">
                        {pctCell(c.twd)}
                        {c.twd !== null && (
                          <>
                            <br />
                            <span className="small muted">{c.twd >= 2 ? '貶' : c.twd <= -2 ? '升' : '持平'}</span>
                          </>
                        )}
                      </td>
                      <td className="r">{pctCell(c.index)}</td>
                      <td className="r">{pctCell(c.drawdown)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FxRows({ title, rows, current }: { title: string; rows: readonly FxStat[]; current: number | null }) {
  const cur = current === null ? null : current >= 2 ? 'weak' : current <= -2 ? 'strong' : 'flat';
  return (
    <>
      <tr className="grp">
        <td colSpan={5}>{title}</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.group} className={r.group === cur ? 'hl' : ''}>
          <td>{FX_ROW_TEXT[r.group]}</td>
          <td className="r">{r.n}</td>
          <td className="r">
            {pctCell(r.avg3m)}
            <br />
            <span className="small muted">{r.up3m === null ? '—' : `${r.up3m.toFixed(0)}%`}</span>
          </td>
          <td className="r">{pctCell(r.avg12m)}</td>
          <td className="r">
            {pctCell(r.avgWorst3m)}
            <br />
            <span className="small muted">{r.crash3m === null ? '—' : `${r.crash3m.toFixed(0)}%`}</span>
          </td>
        </tr>
      ))}
    </>
  );
}
