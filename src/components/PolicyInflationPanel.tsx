import {
  BaselineSeries,
  type AutoscaleInfoProvider,
  ColorType,
  CrosshairMode,
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
import { PanelNote } from './PanelNote';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSeriesMap } from '../hooks/useData';
import { CHART_INTERACTION, resetPaneStretch, resetPriceScales, attachTimeAxis, TIME_AXIS } from '../lib/chartInteraction';
import { loadPref, savePref } from '../lib/storage';
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

/** 可切換的副線（核心 CPI 固定顯示） */
const EXTRA_LINES = [
  { id: 'cpi', label: '整體 CPI', key: 'pi-cpi', def: '1' },
  { id: 'core_pce', label: '核心 PCE', key: 'pi-pce', def: '0' },
  { id: 'us2y', label: '美債 2Y', key: 'pi-2y', def: '1' },
] as const;
const EXTRA_COLOR: Record<ExtraId, string> = { cpi: 'var(--ma60)', core_pce: 'var(--ma240)', us2y: 'var(--ma120)' };
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

const IDS = ['fed', 'fed_target_legacy', 'core_cpi', 'cpi', 'core_pce', 'us2y', 'unrate', ...INDICES.map((i) => i.id)];

const NO_BARS: Bar[] = [];

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
}

export function PolicyInflationPanel({ version, themeKey }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const near = useNearViewport(sectionRef);
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('pi-range', ['3M', '6M', '1Y', '5Y', '10Y', 'ALL'], '5Y'));
  const [extras, setExtras] = useState<Record<ExtraId, boolean>>(() => ({
    cpi: loadPref('pi-cpi', ['1', '0'] as const, '1') === '1',
    core_pce: loadPref('pi-pce', ['1', '0'] as const, '0') === '1',
    us2y: loadPref('pi-2y', ['1', '0'] as const, '1') === '1',
  }));
  const [indexPick, setIndexPick] = useState<IndexPick>(() => loadPref<IndexPick>('pi-idx', INDEX_PICKS, 'spx'));
  const [showEvents, setShowEvents] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const files = useSeriesMap(near ? IDS : [], version);
  const { fed, coreCpi, cpi, corePce, us2y, unrate, indexBars } = useMemo(() => {
    const ready = (id: string) => (files[id]?.status === 'ready' ? files[id]!.data.data : null);
    const upper = ready('fed');
    return {
      fed: upper ? splicePolicyRate(upper, ready('fed_target_legacy') ?? []) : ([] as Point[]),
      coreCpi: ready('core_cpi') ? yoyPoints(ready('core_cpi')!) : ([] as Point[]),
      cpi: ready('cpi') ? yoyPoints(ready('cpi')!) : ([] as Point[]),
      corePce: ready('core_pce') ? yoyPoints(ready('core_pce')!) : ([] as Point[]),
      us2y: (ready('us2y') ?? []).map((b) => [b[0], b[4]] as Point),
      unrate: (ready('unrate') ?? []).map((b) => [b[0], b[4]] as Point),
      indexBars: Object.fromEntries(INDICES.map((i) => [i.id, ready(i.id) ?? []])) as Record<IndexId, Bar[]>,
    };
  }, [files]);
  // Fed 階段 vs 四個指數：階段區段、各段漲跌、循環第一次動作之後的表現（每個指數各算一份，表格並排）
  const equities = useMemo(() => {
    if (!fed.length) return null;
    const out = {} as Record<IndexId, ReturnType<typeof buildEquity> | null>;
    for (const i of INDICES) out[i.id] = indexBars[i.id].length ? buildEquity(fed, indexBars[i.id], unrate) : null;
    return out;
  }, [fed, indexBars, unrate]);
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
  const toggleExtra = (id: ExtraId) => {
    const next = { ...extras, [id]: !extras[id] };
    setExtras(next);
    savePref(EXTRA_LINES.find((e) => e.id === id)!.key, next[id] ? '1' : '0');
  };

  const loaded = fed.length > 0 && coreCpi.length > 0;

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
      timeScale: { ...TIME_AXIS, rightOffset: 2, fixLeftEdge: true, fixRightEdge: true, minBarSpacing: 0.05, borderColor: grid },
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

    // 上窗格：Fed（階梯，深色粗線）、核心 CPI（強調色）、整體 CPI（細虛線）、核心 PCE（細線）
    const fedS = chart.addSeries(
      LineSeries,
      { color: cssVar('--text-1'), lineWidth: 2, lineType: LineType.WithSteps, priceFormat: pct, lastValueVisible: false },
      0,
    );
    fedS.setData(toData(fed));
    const coreS = chart.addSeries(
      LineSeries,
      { color: cssVar('--accent'), lineWidth: 2, priceFormat: pct, lastValueVisible: false, autoscaleInfoProvider: includeRange(FED_TARGET, FED_TARGET) },
      0,
    );
    coreS.setData(toData(coreCpi));
    coreS.createPriceLine({
      price: FED_TARGET,
      color: textColor,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
    });
    if (extras.cpi && cpi.length > 0) {
      const s = chart.addSeries(
        LineSeries,
        { color: cssVar('--ma60'), lineWidth: 1, lineStyle: LineStyle.Dashed, priceFormat: pct, lastValueVisible: false, priceLineVisible: false },
        0,
      );
      s.setData(toData(cpi));
    }
    if (extras.core_pce && corePce.length > 0) {
      const s = chart.addSeries(
        LineSeries,
        { color: cssVar('--ma240'), lineWidth: 1, priceFormat: pct, lastValueVisible: false, priceLineVisible: false },
        0,
      );
      s.setData(toData(corePce));
    }
    // 美債 2Y：市場對未來一年 Fed 利率的押注，跑在 Fed 階梯前面
    if (extras.us2y && us2y.length > 0) {
      const s = chart.addSeries(
        LineSeries,
        { color: cssVar('--ma120'), lineWidth: 1, priceFormat: pct, lastValueVisible: false, priceLineVisible: false },
        0,
      );
      s.setData(toData(us2y));
    }

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
      // priceScale(...).applyOptions 會把選項併進圖表層級預設，之後建立的窗格都繼承 → 所有窗格建好後再逐一設定
      chart.priceScale('right', 0).applyOptions({ mode: PriceScaleMode.Normal });
      chart.priceScale('right', 1).applyOptions({ mode: PriceScaleMode.Normal });
      chart.priceScale('right', 2).applyOptions({ mode: PriceScaleMode.Logarithmic });
    }

    const wm = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) createTextWatermark(pane, { horzAlign: 'left', vertAlign: 'top', lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }] });
    };
    wm(0, `Fed 利率 vs 通膨年增（%）｜虛線 2% 目標`);
    wm(1, `實質＝Fed − 核心CPI（pp）｜虛線 +${REAL_RATE_TIGHT} 緊縮、0 中性`);
    if (showSpx) wm(2, `${indexLabel}（對數）｜線色＝Fed 階段（見圖例、下表）`);

    const handler = (param: MouseEventParams<Time>) => setHoverTime(typeof param.time === 'string' ? param.time : null);
    chart.subscribeCrosshairMove(handler);
    attachTimeAxis(chart);
    chartRef.current = chart;
    setChartGen((g) => g + 1);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      chart.remove();
      chartRef.current = null;
    };
  }, [loaded, fed, coreCpi, cpi, corePce, us2y, spx, equity, showSpx, indexLabel, real, extras, themeKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = fed.at(-1);
    if (!chart || !last) return;
    const start = rangeStart(last[0], range);
    const apply = () => {
      resetPriceScales(chart);
      resetPaneStretch(chart, showSpx ? PANE_STRETCH_SPX : PANE_STRETCH);
      if (!start || start <= fed[0]![0]) chart.timeScale().fitContent();
      else chart.timeScale().setVisibleRange({ from: start as Time, to: last[0] as Time });
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [chartGen, range, resetKey, fed, showSpx]);

  // 圖例：十字線所在日期（沒有時顯示最新）
  const legend = useMemo(() => {
    if (!loaded) return null;
    const date = hoverTime ?? fed.at(-1)![0];
    const at = (pts: readonly Point[]) => (pts.length ? valueAtOrBefore(pts, date) : null);
    const fedV = at(fed);
    const coreV = at(coreCpi);
    const y2 = extras.us2y ? at(us2y) : null;
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
      spx: spxV,
      phase,
      move,
      sinceMove: move ? daysBetween(move.date, date) : null,
    };
  }, [loaded, hoverTime, fed, coreCpi, cpi, corePce, us2y, spx, equity, showSpx, extras]);
  const currentPhase = equity ? phaseAt(equity.segments, spx.at(-1)![0]) : null;
  // 2Y − Fed：低於 −0.25pp 市場押降息、高於 +0.25pp 押升息（約一碼）
  const spreadText = (v: number | null) =>
    v === null ? '' : v <= -0.25 ? '市場押降息' : v >= 0.25 ? '市場押升息' : '市場押不變';

  const failed = IDS.flatMap((id) => (files[id]?.status === 'error' ? [`${id}：${(files[id] as { error: string }).error}`] : []));

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
        美債 2Y 是市場對未來一年 Fed 利率的押注，通常跑在 Fed 階梯前面：2Y 低於 Fed 一碼以上＝押降息、高於一碼以上＝押升息；它比 CPI 早反應，但押錯也常見（2024 上半年押六次降息，實際三次）。
        第三格指數（S&P 500／NASDAQ／費半／加權，一次看一個）的線色是 Fed 階段（升息期／高原／降息期／谷底；超過 6 個月沒動作算暫停）。1982 年起四個階段 S&P 年化都是正的，階段本身不是方向訊號；差別在「為什麼降息」：降息後一年內失業率觸發 Sahm 規則的衰退式降息（2001、2007）之後一年 S&P 是負的，保險式降息（1995、1998、2019、2024）則續漲——分類器是失業率和 2Y−Fed，不是 Fed 動作本身。
        四個指數高度連動（費半對加權 ρ60 約 0.66），四欄同向不是四個證據；費半 1994、加權 1997 起，循環次數只有 S&P 的一半，加權對 Fed 的傳導還隔著台幣與外資。
        這張圖與「Fed 120 天」「核心CPI ±0.2pp」規則重疊，只用來解釋 FOMC 為什麼那樣做，不計分。2008 年前 Fed 為單一目標利率。
      </p>
      </PanelNote>

      <div className="cp-mas" role="group" aria-label="通膨序列">
        <span className="ma-chip" aria-pressed="true" aria-disabled="true" title="固定顯示">
          <i className="swatch" style={{ background: 'var(--accent)' }} />
          核心 CPI
        </span>
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

      <div className="seg" role="group" aria-label="時間區間">
        {RANGES.map((r) => (
          <button key={r.k} type="button" aria-pressed={range === r.k} onClick={() => pickRange(r.k)}>
            {r.label}
          </button>
        ))}
        <button type="button" onClick={() => setResetKey((k) => k + 1)} aria-label="重設圖表縮放" title="重設縮放">
          ↺ 重設
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
                <span className="muted">{legend.date}</span> Fed <b>{f2(legend.fed)}%</b> ｜ 核心CPI <b>{f1(legend.core)}%</b>
                {legend.cpi !== null && <> ｜ CPI {f1(legend.cpi)}%</>}
                {legend.pce !== null && <> ｜ 核心PCE {f1(legend.pce)}%</>}
              </div>
              <div>
                實質 <b>{fpp(legend.real)}</b>
                {legend.real !== null && <span className="muted"> ｜ {REAL_RATE_STATE_TEXT[legend.real < 0 ? 'loose' : legend.real >= REAL_RATE_TIGHT ? 'tight' : 'mid']}</span>}
              </div>
              {legend.us2y !== null && (
                <div>
                  美債2Y <b>{f2(legend.us2y)}%</b> ｜ 2Y−Fed <b>{fpp(legend.spread2y)}</b>
                  <span className="muted"> ｜ {spreadText(legend.spread2y)}</span>
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
            </div>
          )}
          <div ref={hostRef} className="chart-host pi-host" />
        </div>
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
    </section>
  );
}
