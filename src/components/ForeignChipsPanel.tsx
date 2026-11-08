import {
  type AutoscaleInfo,
  BaselineSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { PanelNote } from './PanelNote';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CHART_INTERACTION, attachTimeAxis, resetPaneStretch, resetPriceScales, TIME_AXIS } from '../lib/chartInteraction';
import { cssVar, f2, pctCell } from '../lib/stressFormat';
import {
  DEEPER_STEP,
  DIVERGE_PCTL,
  EXTREME_HIGH,
  EXTREME_LOW,
  FOREIGN_EVENT_LABEL,
  FOREIGN_EVENT_TYPES,
  FOREIGN_MARKER_TEXT,
  PACE_RATIO,
  PCTL_WINDOW,
  RESET_PCTL,
  type ForeignChipsFile,
  type ForeignEventType,
} from '../shared/foreignChips';
import { rangeStart, type RangeKey } from '../shared/timeseries';
import { StatsRow } from './StatsRow';
import { STATE_LABEL, WARN_RATIO, ZONE_RATIO, type MarginStressFile } from '../shared/marginStress';
import type { BreadthStressFile } from '../shared/breadthStress';
import { LineLabels } from '../lib/lineLabels';
import { MarkerLabels, type MarkerLabel } from '../lib/markerLabels';
import { loadPref, savePref } from '../lib/storage';

/** 第 4 格顯示：散戶小台淨 OI／融資維持率＋融資增減（散戶籌碼），或上市漲跌停家數／漲跌家數（市場廣度），切換對照 */
export type Pane4Mode = 'retail' | 'margin' | 'limit' | 'ad';
const PANE4_KEYS = ['retail', 'margin', 'limit', 'ad'] as const;
const PANE4_MODES: { k: Pane4Mode; label: string; title: string }[] = [
  { k: 'retail', label: '散戶小台', title: '散戶的期貨部位（小台淨未平倉，法人反推）' },
  { k: 'margin', label: '融資維持率', title: '散戶的現股槓桿（融資維持率＋融資增減）' },
  { k: 'limit', label: '漲跌停', title: '上市漲停（0 以上）／跌停（0 以下）家數' },
  { k: 'ad', label: '漲跌家數', title: '上市上漲（0 以上）／下跌（0 以下）家數' },
];
const PANE4_KEY = 'fc-pane4';

/** 右側留白（像素）：讓最新一天的事件文字（如「散戶多」約 40px）不被價格軸切掉，與縮放無關 */
const FC_RIGHT_GAP_PX = 18;

/** 把像素留白換算成 K 棒數（至少 2 根）；圖寬未知時退回 2 根 */
export function rightGapBars(widthPx: number, bars: number): number {
  if (!(widthPx > 0) || bars <= 0) return 2;
  const spacing = widthPx / (bars + 2);
  return Math.max(2, FC_RIGHT_GAP_PX / spacing);
}

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
/** 四個窗格高度比例：加權／買賣超／外資期 OI／散戶小台 OI */
const FC_PANE_STRETCH = [0.34, 0.22, 0.22, 0.22] as const;
/** 第 4 格切到融資時（線＋柱兩層）略高一點，維持率線才不會被壓扁 */
const FC_PANE_STRETCH_MARGIN = [0.32, 0.2, 0.2, 0.28] as const;

/** 事件文字最少相隔幾根 K 棒（依視圖長度）：長視圖事件太密（衰竭幾乎每月都有），先稀疏再交給 MarkerLabels 防撞 */
const MARKER_GAP: Record<RangeKey, number> = { '3M': 3, '6M': 5, '1Y': 8, '5Y': 40, '10Y': 60, 'ALL': 60 };

const lots = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pctlText = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `第 ${Math.round(p * 100)} 百分位`);
/** 百分位落在極端時的樣式類別 */
const pctlClass = (p: number | null | undefined) =>
  p === null || p === undefined ? '' : p <= EXTREME_LOW || p >= EXTREME_HIGH ? 'fc-extreme' : '';

function ChipsChart({
  data,
  range,
  themeKey,
  resetKey,
  margin,
  breadth,
  pane4,
}: {
  data: ForeignChipsFile;
  range: RangeKey;
  themeKey: string;
  resetKey: number;
  margin: MarginStressFile | null;
  breadth: BreadthStressFile | null;
  pane4: Pane4Mode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const indexByDate = useMemo(() => new Map(data.rows.map((r, i) => [r[0], i])), [data]);
  // 融資資料只取外資資料也有的交易日，X 軸（邏輯索引）才不會被多出來的日期撐開
  const marginRows = useMemo(() => (margin?.rows ?? []).filter((r) => indexByDate.has(r[0])), [margin, indexByDate]);
  const marginByDate = useMemo(() => new Map((margin?.rows ?? []).map((r, k) => [r[0], { row: r, state: margin!.states[k] }])), [margin]);
  const showMargin = pane4 === 'margin' && marginRows.length > 0;
  // 家數資料同樣只取外資資料也有的交易日；恐慌日旗標要跟著列一起過濾
  const breadthRows = useMemo(
    () => (breadth?.rows ?? []).flatMap((r, k) => (indexByDate.has(r[0]) ? [{ row: r, panic: breadth!.panic[k] ?? false, downPct: breadth!.downPct[k] ?? null, adRatio10: breadth!.adRatio10[k] ?? null }] : [])),
    [breadth, indexByDate],
  );
  const breadthByDate = useMemo(() => new Map(breadthRows.map((b) => [b.row[0], b])), [breadthRows]);
  const breadthMode: 'limit' | 'ad' | null = (pane4 === 'limit' || pane4 === 'ad') && breadthRows.length > 0 ? pane4 : null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd' },
      timeScale: { ...TIME_AXIS, rightOffset: 2, fixLeftEdge: true, fixRightEdge: false, minBarSpacing: 0.1 },
      ...CHART_INTERACTION,
    });
    attachTimeAxis(chart);
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

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
        panes: { separatorColor: cssVar('--border') },
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid },
    });
    const up = cssVar('--up');
    const down = cssVar('--down');
    const accent = cssVar('--accent');
    const warn = cssVar('--warn');
    const text1 = cssVar('--text-1');
    const lotsFmt = { type: 'price', precision: 0, minMove: 1 } as const;
    const all: ISeriesApi<SeriesType>[] = [];
    const add = <T extends ISeriesApi<SeriesType>>(s: T): T => {
      all.push(s);
      return s;
    };

    // 上：加權指數＋事件標記
    const taiex = add(chart.addSeries(LineSeries, { color: text1, lineWidth: 2, priceFormat: lotsFmt }, 0));
    taiex.setData(data.rows.map((r) => ({ time: r[0] as Time, value: r[1] })));
    // 圖表庫預設上 20%／下 10% 留白，加上事件標記再多留一層，加權窗格上面會空一大塊；收到 6%（與融資面板一致）
    taiex.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });
    const markerColor: Record<ForeignEventType, string> = {
      oi_short: down,
      oi_long: up,
      sell_extreme: down,
      buy_extreme: up,
      retail_long: warn,
      sell_no_fall: accent,
      sell_exhaust: up,
    };
    // 同日事件合併成一個點（文字以「／」相連）；marker 只畫點，文字由 MarkerLabels 自繪、互相閃避並避開折線
    const byDate = new Map<string, ForeignEventType[]>();
    for (const e of data.events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e.type]);
    const markers: SeriesMarker<Time>[] = [];
    const labels: MarkerLabel[] = [];
    let lastTextIdx = -Infinity;
    for (const [date, types] of byDate) {
      const idx = indexByDate.get(date);
      const above = types.some((t) => t === 'oi_long' || t === 'buy_extreme' || t === 'retail_long');
      markers.push({ time: date as Time, position: above ? 'aboveBar' : 'belowBar', shape: 'circle', color: markerColor[types[0]!] });
      const withText = idx !== undefined && idx - lastTextIdx > MARKER_GAP[range];
      if (withText) lastTextIdx = idx;
      if (idx !== undefined && withText) {
        labels.push({ time: date as Time, value: data.rows[idx]![1], text: types.map((t) => FOREIGN_MARKER_TEXT[t]).join('／'), color: markerColor[types[0]!], above });
      }
    }
    // 同一波內再創極端：小一號、不帶文字（圖例會顯示）
    for (const m of data.deeper) {
      markers.push({
        time: m.date as Time,
        position: m.kind === 'oi_long' ? 'aboveBar' : 'belowBar',
        shape: 'circle',
        color: m.kind === 'oi_long' ? up : down,
        size: 0.6,
      });
    }
    markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    createSeriesMarkers(taiex, markers);
    taiex.attachPrimitive(new MarkerLabels(labels, { background: cssVar('--surface'), fontSize: 11, fontFamily: getComputedStyle(document.body).fontFamily }));

    // 中：外資買賣超柱＋5／20 日累計線
    // 單日柱用獨立刻度貼在窗格底部，否則被 ±數千億的累計線壓得看不見
    const net = add(chart.addSeries(HistogramSeries, { priceFormat: lotsFmt, priceScaleId: 'net', priceLineVisible: false, lastValueVisible: false }, 1));
    net.priceScale().applyOptions({ scaleMargins: { top: 0.55, bottom: 0 } });
    net.setData(data.rows.filter((r) => r[2] !== null).map((r) => ({ time: r[0] as Time, value: r[2]!, color: r[2]! >= 0 ? up : down })));
    const cum5 = add(chart.addSeries(LineSeries, { color: warn, lineWidth: 1, priceFormat: lotsFmt, priceLineVisible: false, lastValueVisible: false }, 1));
    cum5.setData(data.rows.filter((r) => r[3] !== null).map((r) => ({ time: r[0] as Time, value: r[3]! })));
    const cum20 = add(chart.addSeries(LineSeries, { color: accent, lineWidth: 2, priceFormat: lotsFmt }, 1));
    cum20.setData(data.rows.filter((r) => r[4] !== null).map((r) => ({ time: r[0] as Time, value: r[4]! })));
    // 累計線與 5 日線共用右軸：留白一樣收到 6%（單日柱在獨立刻度，不受影響）
    cum20.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });

    // 下兩格：淨未平倉（0 軸填色）＋日增減柱（獨立小刻度，貼在窗格底部）
    const oiPane = (pane: number, oi: (r: ForeignChipsFile['rows'][number]) => number | null, chg: (r: ForeignChipsFile['rows'][number]) => number | null) => {
      const s = add(
        chart.addSeries(
          BaselineSeries,
          {
            baseValue: { type: 'price', price: 0 },
            topLineColor: up,
            topFillColor1: 'rgba(214, 58, 58, 0.22)',
            topFillColor2: 'rgba(214, 58, 58, 0.02)',
            bottomLineColor: down,
            bottomFillColor1: 'rgba(0, 0, 0, 0.02)',
            bottomFillColor2: 'rgba(34, 150, 94, 0.22)',
            lineWidth: 2,
            priceFormat: lotsFmt,
          },
          pane,
        ),
      );
      s.setData(data.rows.filter((r) => oi(r) !== null).map((r) => ({ time: r[0] as Time, value: oi(r)! })));
      s.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.3 } }); // 下方 28% 給日增減柱，上方不留大空白
      const h = add(
        chart.addSeries(HistogramSeries, { priceFormat: lotsFmt, priceScaleId: `chg-${pane}`, lastValueVisible: false, priceLineVisible: false }, pane),
      );
      h.priceScale().applyOptions({ scaleMargins: { top: 0.72, bottom: 0 } });
      h.setData(
        data.rows
          .filter((r) => chg(r) !== null)
          .map((r) => ({ time: r[0] as Time, value: chg(r)!, color: chg(r)! >= 0 ? `${up}99` : `${down}99` })),
      );
    };
    oiPane(2, (r) => r[5], (r) => r[6]);
    if (showMargin) {
      // 第 4 格：融資維持率（線，上方 2/3）＋融資增減（柱，下方 30%），比照融資斷頭監測的版型
      const inWarn = (marginRows.at(-1)?.[2] ?? Infinity) < WARN_RATIO;
      const ratio = add(
        chart.addSeries(
          LineSeries,
          {
            color: accent,
            lineWidth: 2,
            priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
            autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
              const info = original();
              if (!inWarn || !info?.priceRange) return info;
              return { ...info, priceRange: { minValue: Math.min(info.priceRange.minValue, ZONE_RATIO), maxValue: info.priceRange.maxValue } };
            },
          },
          3,
        ),
      );
      ratio.setData(marginRows.map((r) => ({ time: r[0] as Time, value: r[2] })));
      ratio.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.36 } });
      const thresholds = [
        { price: WARN_RATIO, text: `警戒 ${WARN_RATIO}` },
        { price: ZONE_RATIO, text: `斷頭區 ${ZONE_RATIO}` },
        { price: 130, text: '追繳 130' },
      ];
      const lineColor = cssVar('--text-3');
      for (const t of thresholds) {
        ratio.createPriceLine({ price: t.price, color: lineColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      }
      ratio.attachPrimitive(
        new LineLabels(thresholds, {
          color: cssVar('--text-2'),
          background: cssVar('--surface'),
          border: lineColor,
          fontSize: 11,
          fontFamily: getComputedStyle(document.body).fontFamily,
          maxYFrac: 0.74,
        }),
      );
      const mchg = add(
        chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 0, minMove: 1 }, priceScaleId: 'fc-mchg', priceLineVisible: false }, 3),
      );
      mchg.setData(marginRows.filter((r) => Number.isFinite(r[4])).map((r) => ({ time: r[0] as Time, value: r[4], color: r[4] >= 0 ? up : down })));
      mchg.priceScale().applyOptions({ scaleMargins: { top: 0.7, bottom: 0 }, visible: false });
    } else if (breadthMode) {
      // 第 4 格：上市漲停／跌停或上漲／下跌家數，0 以上為漲、0 以下為跌（鏡像柱，比照漲跌停面板）；跌的那側恐慌日加深
      const ad = breadthMode === 'ad';
      const err = cssVar('--err');
      const upBars = add(chart.addSeries(HistogramSeries, { priceFormat: lotsFmt, color: up, priceLineVisible: false }, 3));
      upBars.setData(breadthRows.map((b) => ({ time: b.row[0] as Time, value: ad ? b.row[4] : b.row[2] })));
      const downBars = add(chart.addSeries(HistogramSeries, { priceFormat: lotsFmt, priceLineVisible: false }, 3));
      downBars.setData(breadthRows.map((b) => ({ time: b.row[0] as Time, value: -(ad ? b.row[5] : b.row[3]), color: b.panic ? err : down })));
      upBars.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });
      upBars.createPriceLine({ price: 0, color: cssVar('--text-3'), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
    } else {
      oiPane(3, (r) => r[7], (r) => r[8]);
    }
    resetPaneStretch(chart, showMargin ? FC_PANE_STRETCH_MARGIN : FC_PANE_STRETCH);
    return () => {
      for (const s of all.reverse()) chart.removeSeries(s);
    };
  }, [data, themeKey, indexByDate, range, showMargin, marginRows, breadthMode, breadthRows]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = data.rows.at(-1);
    if (!chart || !last) return;
    const start = rangeStart(last[0], range);
    const from = start ? Math.max(0, data.rows.findIndex((r) => r[0] >= start)) : 0;
    const ts = chart.timeScale();
    const lastIdx = data.rows.length - 1;
    // 圖表庫的 fixRightEdge 會把右邊界卡在最後一根、吃掉留白，所以不用它，改成自己限制：
    // 右側最多留 gap 根（約 18px，讓最新事件文字完整），往左滑不會拉出更多空白
    let gap = 2;
    const clamp = (r: { from: number; to: number } | null) => {
      if (!r) return;
      const maxTo = lastIdx + gap;
      if (r.to > maxTo + 0.01) ts.setVisibleLogicalRange({ from: r.from - (r.to - maxTo), to: maxTo });
    };
    const apply = () => {
      gap = rightGapBars(ts.width(), data.rows.length - from);
      ts.applyOptions({ rightOffset: gap });
      ts.setVisibleLogicalRange({ from, to: lastIdx + gap });
      resetPriceScales(chart);
      resetPaneStretch(chart, showMargin ? FC_PANE_STRETCH_MARGIN : FC_PANE_STRETCH);
    };
    apply();
    const raf = requestAnimationFrame(apply);
    ts.subscribeVisibleLogicalRangeChange(clamp);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(clamp);
    };
  }, [data, range, themeKey, resetKey, showMargin]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (p: MouseEventParams<Time>) => {
      const t = typeof p.time === 'string' ? p.time : null;
      const i = t ? indexByDate.get(t) : undefined;
      setHoverIdx(i ?? null);
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [indexByDate]);

  const i = hoverIdx ?? data.rows.length - 1;
  const row = data.rows[i];
  const sgn = (v: number | null) => (v === null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
  const m = row && showMargin ? marginByDate.get(row[0]) : undefined;
  const b = row && breadthMode ? breadthByDate.get(row[0]) : undefined;
  const dayEvents = row
    ? [
        ...data.events.filter((e) => e.date === row[0]).map((e) => FOREIGN_EVENT_LABEL[e.type]),
        ...data.deeper.filter((m) => m.date === row[0]).map((m) => (m.kind === 'oi_long' ? '外資期多單再增' : '外資期空單再增')),
      ]
    : [];
  return (
    <div className="pricechart ms-chart">
      {row && (
        <div className="legend num fc-legend" aria-live="off">
          <span className="muted">{row[0]}</span> 加權 <b>{row[1].toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>
          {dayEvents.length > 0 && <span className="fc-day-events">● {dayEvents.join('、')}</span>}
          <br />
          外資買賣超 <b className={sgn(row[2])}>{f2(row[2], true)}</b> 億｜5日 <b className={sgn(row[3])}>{f2(row[3], true)}</b>｜20日{' '}
          <b className={sgn(row[4])}>{f2(row[4], true)}</b> <span className={`muted ${pctlClass(data.pctl.cum20[i])}`}>（{pctlText(data.pctl.cum20[i])}）</span>
          <br />
          外資期淨OI <b className={sgn(row[5])}>{lots(row[5])}</b> 口 <span className={`muted ${pctlClass(data.pctl.foreignOi[i])}`}>（{pctlText(data.pctl.foreignOi[i])}）</span>
          ｜
          {showMargin ? (
            m ? (
              <>
                維持率 <b>{f2(m.row[2])}%</b> 融資增減 <span className={sgn(m.row[4])}>{f2(m.row[4], true)} 億</span>{' '}
                {m.state && <span className={`ms-state ms-${m.state}`}>{STATE_LABEL[m.state]}</span>}
              </>
            ) : (
              <>維持率 —</>
            )
          ) : breadthMode === 'limit' ? (
            b ? (
              <>
                漲停 <b className="up">{b.row[2]}</b> 跌停 <b className="down">{b.row[3]}</b> 家{' '}
                <span className="muted">（跌停占比 {f2(b.downPct)}%）</span> {b.panic && <span className="ms-state ms-zone">恐慌日</span>}
              </>
            ) : (
              <>漲跌停 —</>
            )
          ) : breadthMode === 'ad' ? (
            b ? (
              <>
                上漲 <b className="up">{b.row[4]}</b> 下跌 <b className="down">{b.row[5]}</b> 家{' '}
                <span className="muted">（10日漲跌比 {f2(b.adRatio10)}）</span> {b.panic && <span className="ms-state ms-zone">恐慌日</span>}
              </>
            ) : (
              <>漲跌家數 —</>
            )
          ) : (
            <>
              散戶小台 <b className={sgn(row[7])}>{lots(row[7])}</b> 口{' '}
              <span className={`muted ${pctlClass(data.pctl.retailOi[i])}`}>（{pctlText(data.pctl.retailOi[i])}）</span>
            </>
          )}
        </div>
      )}
      <div ref={hostRef} className="chart-host fc-host" />
    </div>
  );
}

export function ForeignChipsPanel({
  data,
  themeKey,
  margin = null,
  breadth = null,
}: {
  data: ForeignChipsFile | null;
  themeKey: string;
  margin?: MarginStressFile | null;
  breadth?: BreadthStressFile | null;
}) {
  const [range, setRange] = useState<RangeKey>('3M');
  const [pane4, setPane4State] = useState<Pane4Mode>(() => loadPref(PANE4_KEY, PANE4_KEYS, 'retail'));
  const setPane4 = (v: Pane4Mode) => {
    setPane4State(v);
    savePref(PANE4_KEY, v);
  };
  const hasMargin = !!margin?.rows.length;
  const hasBreadth = !!breadth?.rows.length;
  // 沒有對應資料的選項不顯示；記住的選項沒資料時退回散戶小台
  const modes = PANE4_MODES.filter((o) => o.k === 'retail' || (o.k === 'margin' ? hasMargin : hasBreadth));
  const pane4Eff: Pane4Mode = modes.some((o) => o.k === pane4) ? pane4 : 'retail';
  const [resetKey, setResetKey] = useState(0);
  const [showEvents, setShowEvents] = useState(false);
  if (!data || !data.latest) return null;
  const { latest } = data;
  const years = data.start && data.end ? `${data.start}～${data.end}` : '';
  // 各欄最早有資料的日期（歷史回補進度）
  const firstOf = (k: 2 | 5) => data.rows.find((r) => r[k] !== null)?.[0] ?? null;
  const netFrom = firstOf(2);
  const oiFrom = firstOf(5);
  // 買賣超可回補到 2010、期貨淨 OI 免費來源只到 2018-06
  const shortHistory = !netFrom || netFrom > '2011-01-01' || !oiFrom || oiFrom > '2019-01-01';
  const extreme = [
    latest.foreignOiPctl !== null && latest.foreignOiPctl <= EXTREME_LOW && '外資期空單極端',
    latest.foreignOiPctl !== null && latest.foreignOiPctl >= EXTREME_HIGH && '外資期多單極端',
    latest.cum20Pctl !== null && latest.cum20Pctl <= EXTREME_LOW && '20日累計賣超極端',
    latest.cum20Pctl !== null && latest.cum20Pctl >= EXTREME_HIGH && '20日累計買超極端',
    latest.retailOiPctl !== null && latest.retailOiPctl >= EXTREME_HIGH && '散戶小台偏多極端',
  ].filter((x): x is string => typeof x === 'string');
  return (
    <section id="sec-fc" className="regime ms fc" aria-label="外資籌碼對照">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">外資籌碼對照（上市，參考）</span>
          <span className={`verdict ${extreme.length ? 'fc-extreme' : 'ms-normal'}`}>{extreme.length ? `極端 ${extreme.length}` : '無極端'}</span>
          <span className="score num">
            {extreme.length > 0 && <>{extreme.join('、')}｜</>}外資期淨OI {lots(latest.foreignOi)} 口（{pctlText(latest.foreignOiPctl)}）｜20日累計買賣超 {f2(latest.cum20, true)} 億（
            {pctlText(latest.cum20Pctl)}）｜散戶小台 {lots(latest.retailOi)} 口（{pctlText(latest.retailOiPctl)}）
          </span>
        </div>
        <span className="small muted num">資料 {latest.date}</span>
      </div>

      <PanelNote>
        <p className="small muted ms-rule">
          圖怎麼看：上格加權（● 事件、小● 再創極端，點一下看名稱）；二格外資買賣超（億，柱）＋5 日細／20 日粗累計線；三格外資期淨 OI（口，0 軸填色）＋日增減柱；四格{' '}
          {pane4Eff === 'margin'
            ? '融資維持率（%，虛線＝警戒 160／斷頭區 140／追繳 130）＋融資增減（億，紅增綠減）'
            : pane4Eff === 'limit'
              ? '上市漲停（0 以上）／跌停（0 以下，恐慌日加深）家數'
              : pane4Eff === 'ad'
                ? '上市上漲（0 以上）／下跌（0 以下，恐慌日加深）家數'
                : '散戶小台淨 OI（口）＋日增減柱'}
          ，可用區間列旁的按鈕切換（散戶小台／融資維持率／漲跌停／漲跌家數）。
        </p>
        <p className="small muted ms-rule">
        買賣超是流量、淨未平倉是部位，兩者與當日漲跌幾乎同步，單看柱子不會比看 K 棒多知道什麼；要看的是<b>累計 vs 指數的背離</b>與<b>部位極端</b>。
        百分位＝該值在近 {PCTL_WINDOW} 個交易日中的位置；事件只在首次 ≤ 第 {EXTREME_LOW * 100}／≥ 第 {EXTREME_HIGH * 100} 百分位時標一次，回到第 {RESET_PCTL * 100} 百分位另一側才算新的一波。賣超不跌：20 日累計 ≤ 第 {DIVERGE_PCTL * 100} 百分位且加權 20 日不跌。賣壓衰竭：20 日累計在 0 以下、「5 日累計 × {PACE_RATIO}」由下往上穿過 20 日累計（最近一週的賣超步調慢過整月平均），再掉回去才可再標。
        同一波內外資期淨 OI 比前次標記再多 {DEEPER_STEP * 100}% 補一個小標記「OI空↓／OI多↑」，只畫在圖上不進回測。外資期空單多為現貨避險，空單極端不等於看空；散戶小台為法人反推值。第 4 格可切換「融資維持率」：散戶小台是散戶的期貨部位、融資是散戶的現股槓桿，兩者都是散戶籌碼；外資連續賣超時看維持率是否逼近 160／140，判斷賣壓會不會擴大成斷頭（完整事件與回測在下方「融資斷頭監測」面板）。也可切到「漲跌停」「漲跌家數」：外資賣超是籌碼、家數是廣度，兩者對照看的是「外資賣超時跌停家數是否同步暴增（恐慌）」與「賣超仍在、跌停卻減半（賣壓衰竭）」；恐慌日與回測在下方「漲跌停家數監測」面板。
      </p>
      </PanelNote>

      <div className="cp-controls">
        <div className="seg" role="group" aria-label="時間區間">
          {RANGES.map((r) => (
            <button key={r.k} type="button" aria-pressed={range === r.k} onClick={() => setRange(r.k)}>
              {r.label}
            </button>
          ))}
          <button type="button" onClick={() => setResetKey((k) => k + 1)} aria-label="重設圖表縮放" title="重設縮放">
            ↺ 重設
          </button>
        </div>
        {modes.length > 1 && (
          <div className="seg" role="group" aria-label="第四格顯示">
            {modes.map((o) => (
              <button key={o.k} type="button" aria-pressed={pane4Eff === o.k} onClick={() => setPane4(o.k)} title={`切換最下方窗格：${o.title}`}>
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <ChipsChart data={data} range={range} themeKey={themeKey} resetKey={resetKey} margin={margin} breadth={breadth} pane4={pane4Eff} />

      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">
            事件發生後加權指數表現（{years}；買賣超自 {netFrom ?? '—'}、期貨自 {oiFrom ?? '—'}）
            {shortHistory && '— 歷史回補中，樣本仍少，只看方向不看數字'}
          </caption>
          <thead>
            <tr>
              <th>事件</th>
              <th className="r">次數</th>
              <th className="r">20日</th>
              <th className="r">60日</th>
              <th className="r">60日上漲</th>
              <th className="r">60日內最大跌幅</th>
            </tr>
          </thead>
          <tbody>
            {FOREIGN_EVENT_TYPES.map((t) => (
              <StatsRow key={t} label={FOREIGN_EVENT_LABEL[t]} s={data.eventStats[t]} />
            ))}
            <StatsRow label="所有交易日（基準）" s={data.baseline} hl />
          </tbody>
        </table>
      </div>

      <button type="button" className="linkbtn small" onClick={() => setShowEvents(!showEvents)} aria-expanded={showEvents}>
        {showEvents ? '收起' : `展開`}歷次事件（{data.events.length}）
      </button>
      {showEvents && (
        <div className="table-wrap">
          <table className="bt-table num">
            <thead>
              <tr>
                <th>日期</th>
                <th>事件</th>
                <th className="r">數值</th>
                <th className="r">加權</th>
                <th className="r">20日</th>
                <th className="r">60日</th>
                <th className="r">最大跌幅</th>
              </tr>
            </thead>
            <tbody>
              {[...data.events].reverse().map((e) => (
                <tr key={`${e.date}-${e.type}`}>
                  <td>{e.date}</td>
                  <td>{FOREIGN_EVENT_LABEL[e.type]}</td>
                  <td className="r">{e.type === 'sell_extreme' || e.type === 'buy_extreme' || e.type === 'sell_no_fall' || e.type === 'sell_exhaust' ? `${f2(e.value, true)} 億` : `${lots(e.value)} 口`}</td>
                  <td className="r">{e.taiex.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                  <td className="r">{pctCell(e.ret20)}</td>
                  <td className="r">{pctCell(e.ret60)}</td>
                  <td className="r">{pctCell(e.mdd60)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PanelNote label="ⓘ 用法">
        <p className="small muted ms-rule">
        用法：買賣超看「最近一週的步調 vs 這個月」而不是正負——5 日 × {PACE_RATIO} 比 20 日還低＝賣壓集中在最近幾天、還在加速；5 日拐頭往 0 收到步調慢過整月＝衰竭。三格同向不等於三個證據（外資期空單增加常伴隨賣超現貨）。有用的是「連續賣超但指數不跌」「散戶偏多極端時外資反向」這類關係斷裂；資料累積滿一年後再回測決定是否計分，目前不計分。
      </p>
      </PanelNote>
    </section>
  );
}
