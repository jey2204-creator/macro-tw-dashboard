import {
  type AutoscaleInfo,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { PanelNote } from './PanelNote';
import { CHART_INTERACTION, resetPaneStretch, resetPriceScales, attachTimeAxis, TIME_AXIS } from '../lib/chartInteraction';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CAUGHT_UP_MIN_DD,
  CLEAR_REBOUND,
  COMPLETION_DONE,
  COMPLETION_LABEL,
  COMPLETION_LAG,
  COMPLETION_LOOKBACK,
  COMPLETION_MIN_DD,
  DELEVER_MIN_DROP_PCT,
  EVENT_LABEL,
  EVENT_TYPES,
  STATE_LABEL,
  WARN_DROP_5D,
  WARN_RATIO,
  ZONE_RATIO,
  completionAt,
  completionSeries,
  type Completion,
  type MarginStressFile,
  SBL_BAND_DAYS,
  SBL_CHG_DAYS,
  SBL_COOLDOWN,
  sblStateAt,
  sblUnsold,
  type StressEventType,
} from '../shared/marginStress';
import { rangeStart, type RangeKey } from '../shared/timeseries';
import { cssVar, f1, f2, pctCell } from '../lib/stressFormat';
import { LineLabels } from '../lib/lineLabels';
import { MarkerLabels } from '../lib/markerLabels';
import { StatsRow } from './StatsRow';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
/** 四格：加權／維持率＋融資增減／去槓桿完成度／借券 */
const MS_STRETCH = [0.38, 0.28, 0.17, 0.17] as const;
/** 右側留白（根） */
const MS_RIGHT_GAP = 2;
const MARKER_TEXT: Record<StressEventType, string> = {
  below150: '150',
  below140: '140',
  flush: '斷頭',
  cleared: '清洗完成',
  delever: '去槓桿',
  caughtUp: '追上',
  shortBan: '限空',
  nsf: '國安',
  sblSpike: '追空',
  sblCover: '回補',
};

function StressChart({ data, range, themeKey, resetKey }: { data: MarginStressFile; range: RangeKey; themeKey: string; resetKey: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const indexByDate = useMemo(() => new Map(data.rows.map((r, i) => [r[0], i])), [data]);
  const completion = useMemo(() => completionSeries(data.rows), [data]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd' },
      // fixRightEdge 會把最後一根卡在右緣（半根在畫面外），右軸現值標籤因此停在前一天；改成自己限制右側留白
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
    const series = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 0);
    series.setData(data.rows.map((r) => ({ time: r[0] as Time, value: r[1] })));
    // 圖表庫預設上 20%／下 10% 留白，加上標記再多留一層；收到 6%，加權窗格才不會上面空一大塊
    series.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });
    const color: Record<StressEventType, string> = {
      below150: cssVar('--warn'),
      below140: cssVar('--err'),
      flush: cssVar('--err'),
      cleared: cssVar('--accent'),
      delever: cssVar('--warn'),
      caughtUp: cssVar('--accent'),
      shortBan: cssVar('--text-2'),
      nsf: cssVar('--text-2'),
      sblSpike: cssVar('--down'),
      sblCover: cssVar('--up'),
    };
    // 維持率事件在 K 棒上方（▼▼■）、清洗完成／追上與政策事件在下方（▲▲●●）、去槓桿方塊在下方
    const below = new Set<StressEventType>(['cleared', 'delever', 'caughtUp', 'shortBan', 'nsf', 'sblCover']);
    const shape = (t: StressEventType) =>
      t === 'cleared' || t === 'caughtUp'
        ? 'arrowUp'
        : t === 'flush' || t === 'delever'
          ? 'square'
          : t === 'shortBan' || t === 'nsf' || t === 'sblSpike' || t === 'sblCover'
            ? 'circle'
            : 'arrowDown';
    // marker 只畫符號；文字由 MarkerLabels 自己畫（會互相閃避，見 lib/markerLabels.ts）
    const markers: SeriesMarker<Time>[] = data.events.map((e) => ({
      time: e.date as Time,
      position: below.has(e.type) ? 'belowBar' : 'aboveBar',
      shape: shape(e.type),
      color: color[e.type],
    }));
    createSeriesMarkers(series, markers);
    series.attachPrimitive(
      new MarkerLabels(
        data.events.map((e) => ({ time: e.date as Time, value: e.taiex, text: MARKER_TEXT[e.type], color: color[e.type], above: !below.has(e.type) })),
        { background: cssVar('--surface'), fontSize: 10, fontFamily: getComputedStyle(document.body).fontFamily },
      ),
    );

    // 警戒時（最新維持率 < 160）把斷頭區 140 線納入 Y 軸自動縮放，才看得到離斷頭區多遠；平常不擴 Y 軸
    const inWarn = (data.rows.at(-1)?.[2] ?? Infinity) < WARN_RATIO;
    const ratio = chart.addSeries(
      LineSeries,
      {
        color: cssVar('--accent'),
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
          const info = original();
          if (!inWarn || !info?.priceRange) return info;
          return { ...info, priceRange: { minValue: Math.min(info.priceRange.minValue, ZONE_RATIO), maxValue: info.priceRange.maxValue } };
        },
      },
      1,
    );
    ratio.setData(data.rows.map((r) => ({ time: r[0] as Time, value: r[2] })));
    // 門檻線只畫虛線，不開軸標籤（會和右軸的現值標籤打架）；名稱用 LineLabels 畫在窗格左側線上
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
        maxYFrac: 0.74, // 下方 30% 是融資增減柱，門檻標籤落在那裡就不畫（追繳 130 通常因此不標）
      }),
    );

    const up = cssVar('--up');
    const down = cssVar('--down');
    // 融資增減柱併進維持率窗格下方 1/3（獨立隱藏軸），維持率線留在上方 2/3；少一格、手機少滑
    ratio.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.36 } });
    const chg = chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 0, minMove: 1 }, priceScaleId: 'ms-chg', priceLineVisible: false }, 1);
    chg.setData(
      data.rows.filter((r) => Number.isFinite(r[4])).map((r) => ({ time: r[0] as Time, value: r[4], color: r[4] >= 0 ? up : down })),
    );
    chart.panes()[1]?.priceScale('ms-chg')?.applyOptions({ scaleMargins: { top: 0.7, bottom: 0 }, visible: false });
    // 去槓桿完成度：第 3 格，指數自高點跌幅（黑）與融資餘額自高點減幅（藍）兩條 % 線；
    // 藍線追上黑線＝融資清洗幅度追上大盤跌幅（完成度 ≥ 1），數值列在圖例
    const pctFmt = { type: 'custom' as const, minMove: 0.1, formatter: (v: number) => `${v.toFixed(1)}%` };
    const ddLine = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: pctFmt, priceLineVisible: false }, 2);
    ddLine.setData(completion.map((c) => ({ time: c[0] as Time, value: c[1] })));
    const cutLine = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 2, priceFormat: pctFmt, priceLineVisible: false }, 2);
    cutLine.setData(completion.filter((c) => c[2] !== null).map((c) => ({ time: c[0] as Time, value: c[2] as number })));
    ddLine.createPriceLine({ price: 0, color: lineColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
    ddLine.createPriceLine({ price: -COMPLETION_MIN_DD, color: lineColor, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
    ddLine.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
    // 借券賣出（上市，萬張）：第 4 格，餘額折線 ＋ 日增減柱（增加＝空方加碼，用空方色）
    const sbl = data.sbl ?? [];
    let sblLine: ReturnType<typeof chart.addSeries> | null = null;
    let sblChg: ReturnType<typeof chart.addSeries> | null = null;
    let sblLend: ReturnType<typeof chart.addSeries> | null = null;
    if (sbl.length) {
      sblLine = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 3);
      // 餘額線依「20 日變化率 vs 3 年分位帶」上色：追空極端＝空方色、回補極端＝多方色、其餘黑
      const base = cssVar('--text-1');
      sblLine.setData(
        sbl.map((r) => {
          const st = sblStateAt(r);
          return { time: r[0] as Time, value: r[1], color: st === 'spike' ? down : st === 'cover' ? up : base };
        }),
      );
      // 已借未賣＝借券餘額（借貸系統合計）− 借券賣出餘額：藍虛線、獨立隱藏刻度（和賣出餘額同一段高度），右軸仍顯示最新值
      const unsoldRows = sbl.filter((r) => r[8] !== null);
      if (unsoldRows.length) {
        sblLend = chart.addSeries(
          LineSeries,
          {
            color: cssVar('--accent'),
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            priceFormat: { type: 'price', precision: 0, minMove: 1 },
            priceScaleId: 'sbl-unsold',
            priceLineVisible: false,
            lastValueVisible: false, // 右軸已有 1822 與日增減兩個標籤，第三個會擠到上一格；現值改畫在線尾
            crosshairMarkerVisible: false,
          },
          3,
        );
        sblLend.setData(unsoldRows.map((r) => ({ time: r[0] as Time, value: sblUnsold(r)! })));
        chart.panes()[3]?.priceScale('sbl-unsold')?.applyOptions({ scaleMargins: { top: 0.08, bottom: 0.32 }, visible: false });
        const lastUnsold = sblUnsold(unsoldRows[unsoldRows.length - 1]!)!;
        sblLend.attachPrimitive(
          new LineLabels([{ price: lastUnsold, text: `已借未賣 ${Math.round(lastUnsold)}` }], {
            color: cssVar('--accent'),
            background: cssVar('--surface'),
            border: cssVar('--accent'),
            fontSize: 11,
            fontFamily: getComputedStyle(document.body).fontFamily,
            align: 'right',
            avoid: [sblLine, sblLend], // 壓到賣出餘額黑線或自己的虛線就往上下閃
          }),
        );
      }
      sblChg = chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 1, minMove: 0.1 }, priceScaleId: 'sbl-chg', priceLineVisible: false }, 3);
      sblChg.setData(sbl.filter((r) => Number.isFinite(r[2])).map((r) => ({ time: r[0] as Time, value: r[2], color: r[2] >= 0 ? down : up })));
      // 柱子只占窗格下方 1/3、折線留在上方 2/3，兩者不重疊
      // 柱子壓到窗格下方 1/4，日增減標籤才不會蓋住右軸刻度
      chart.panes()[3]?.priceScale('sbl-chg')?.applyOptions({ scaleMargins: { top: 0.74, bottom: 0 }, visible: false });
      sblLine.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.32 } });
    }
    resetPaneStretch(chart, MS_STRETCH);
    return () => {
      chart.removeSeries(series);
      chart.removeSeries(ratio);
      chart.removeSeries(chg);
      chart.removeSeries(ddLine);
      chart.removeSeries(cutLine);
      if (sblLine) chart.removeSeries(sblLine);
      if (sblChg) chart.removeSeries(sblChg);
      if (sblLend) chart.removeSeries(sblLend);
    };
  }, [data, completion, themeKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = data.rows.at(-1);
    if (!chart || !last) return;
    // 以 K 棒索引設定可視範圍（不受圖表初次排版時寬度為 0 的影響）
    const start = rangeStart(last[0], range);
    const from = start ? Math.max(0, data.rows.findIndex((r) => r[0] >= start)) : 0;
    const ts = chart.timeScale();
    // 時間軸的邏輯索引是所有序列日期的聯集（借券有幾天融資沒有），不能直接用 rows 的索引，要換算
    const logical = (date: string, fallback: number) => ts.timeToIndex(date as Time, true) ?? fallback;
    // 右側最多留 MS_RIGHT_GAP 根空白，往左滑不會拉出更多（取代 fixRightEdge）
    let maxTo = Infinity;
    const clamp = (r: { from: number; to: number } | null) => {
      if (r && r.to > maxTo + 0.01) ts.setVisibleLogicalRange({ from: r.from - (r.to - maxTo), to: maxTo });
    };
    const apply = () => {
      maxTo = logical(last[0], data.rows.length - 1) + MS_RIGHT_GAP;
      ts.setVisibleLogicalRange({ from: logical(data.rows[from]![0], from), to: maxTo });
      resetPriceScales(chart);
      resetPaneStretch(chart, MS_STRETCH);
    };
    apply();
    const raf = requestAnimationFrame(apply);
    ts.subscribeVisibleLogicalRangeChange(clamp);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(clamp);
    };
  }, [data, range, themeKey, resetKey]);

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
  const state = data.states[i];
  const sblByDate = useMemo(() => new Map((data.sbl ?? []).map((r) => [r[0], r])), [data]);
  const sblRow = row ? sblByDate.get(row[0]) : undefined;
  const comp = completion[i];
  return (
    <div className="pricechart ms-chart">
      {row && (
        <div className="legend num" aria-live="off">
          <span className="muted">{row[0]}</span> 加權 <b>{row[1].toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>{' '}
          維持率 <b>{f2(row[2])}%</b> 融資增減{' '}
          <span className={row[4] > 0 ? 'up' : row[4] < 0 ? 'down' : ''}>{f2(row[4], true)} 億</span>{' '}
          {state && <span className={`ms-state ms-${state}`}>{STATE_LABEL[state]}</span>}
          {sblRow && (
            <>
              {' '}
              借券賣出 <b>{f1(sblRow[1])}</b>萬張{' '}
              <span className={sblRow[2] > 0 ? 'down' : sblRow[2] < 0 ? 'up' : ''}>{f1(sblRow[2], true)}</span>
              {sblRow[5] !== null && (
                <>
                  {' '}
                  20日 <span className={sblRow[5] > 0 ? 'down' : sblRow[5] < 0 ? 'up' : ''}>{f1(sblRow[5], true)}%</span>
                  {sblStateAt(sblRow) === 'spike' && <span className="ms-sbl-tag down">追空極端</span>}
                  {sblStateAt(sblRow) === 'cover' && <span className="ms-sbl-tag up">回補極端</span>}
                </>
              )}
              {sblRow[8] !== null && (
                <>
                  {' '}
                  借券餘額 <b>{f1(sblRow[8])}</b> 已借未賣 <b>{f1(sblUnsold(sblRow))}</b>
                </>
              )}
            </>
          )}
          {comp && (
            <>
              {' '}
              完成度 <b>{comp[3] === null ? '—' : comp[3].toFixed(2)}</b>
              <span className="muted">（指數 {f1(comp[1])}%／融資 {comp[2] === null ? '—' : `${f1(comp[2])}%`}）</span>
            </>
          )}
        </div>
      )}
      <div ref={hostRef} className="chart-host ms-host" />
    </div>
  );
}

/** 去槓桿完成度讀數列（最新一日） */
function CompletionLine({ c }: { c: Completion }) {
  const bal = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 0 }));
  return (
    <div className="small num ms-sbl-line">
      去槓桿完成度 <b>{c.ratio === null ? '—' : c.ratio.toFixed(2)}</b>
      {c.grade && <span className={`ms-sbl-tag ms-comp-${c.grade}`}>{COMPLETION_LABEL[c.grade]}</span>}
      ｜指數自高點 <b className={c.dd < 0 ? 'down' : ''}>{f1(c.dd)}%</b>
      <span className="muted">（{c.peakDate} {bal(c.peak)}）</span>｜融資自高點{' '}
      <b className={(c.cut ?? 0) < 0 ? 'down' : ''}>{c.cut === null ? '—' : `${f1(c.cut)}%`}</b>
      {c.balPeakDate && (
        <span className="muted">
          （{c.balPeakDate} {bal(c.balPeak)} 億）
        </span>
      )}
      {c.ratio === null && c.cut !== null && <span className="muted">｜指數回落未達 {COMPLETION_MIN_DD}%，不計</span>}
    </div>
  );
}

export function MarginStressPanel({ data, themeKey }: { data: MarginStressFile | null; themeKey: string }) {
  const [range, setRange] = useState<RangeKey>('3M');
  const [resetKey, setResetKey] = useState(0);
  const [showEvents, setShowEvents] = useState(false);
  const indexByDate = useMemo(() => new Map((data?.rows ?? []).map((r, i) => [r[0], i])), [data]);
  if (!data || !data.latest) return null;
  const { latest } = data;
  const comp = completionAt(data.rows, data.rows.length - 1);
  const years = data.start && data.end ? `${data.start}～${data.end}` : '';
  const shortHistory = !data.start || data.start > '2011-01-01';
  return (
    <section id="sec-ms" className="regime ms" aria-label="融資斷頭監測">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">融資斷頭監測（上市，參考）</span>
          <span className={`verdict ms-${latest.state}`}>{STATE_LABEL[latest.state]}</span>
          <span className="score num">
            維持率 {f2(latest.ratio)}%｜近5日 {f2(latest.drop5 === null ? null : -latest.drop5, true)}pp｜距 140% 還有{' '}
            {f2(latest.ratio - ZONE_RATIO)}pp
          </span>
        </div>
        <span className="small muted num">資料 {latest.date}</span>
      </div>
      {data.latestSbl && (
        <div className="small num ms-sbl-line">
          借券賣出餘額 <b>{f1(data.latestSbl.balance)}</b> 萬張｜近5日{' '}
          <span className={(data.latestSbl.chg5 ?? 0) > 0 ? 'down' : (data.latestSbl.chg5 ?? 0) < 0 ? 'up' : ''}>{f1(data.latestSbl.chg5, true)}</span> 萬張｜
          {data.latestSbl.streak > 0 ? `連增 ${data.latestSbl.streak} 日` : data.latestSbl.streak < 0 ? `連減 ${-data.latestSbl.streak} 日` : '持平'}
          {data.latestSbl.hi60 && <span className="ms-sbl-tag down">近 60 日新高</span>}
          {data.latestSbl.lo60 && <span className="ms-sbl-tag up">近 60 日新低</span>}
          <span className="muted">（上市，{data.latestSbl.date}）</span>
          {data.latestSbl.chg20 !== null && (
            <div>
              20日變化 <b className={data.latestSbl.chg20 > 0 ? 'down' : data.latestSbl.chg20 < 0 ? 'up' : ''}>{f1(data.latestSbl.chg20, true)}%</b>
              {data.latestSbl.p95 !== null && data.latestSbl.p05 !== null && (
                <>
                  ｜3年帶 {f1(data.latestSbl.p05, true)}%～{f1(data.latestSbl.p95, true)}%
                </>
              )}
              {data.latestSbl.pctAll !== null && <>｜全歷史第 {data.latestSbl.pctAll.toFixed(0)} 百分位</>}
              {data.latestSbl.state === 'spike' && <span className="ms-sbl-tag down">追空極端（空方加碼 20 日內最猛的 5%）</span>}
              {data.latestSbl.state === 'cover' && <span className="ms-sbl-tag up">回補極端（空方回補 20 日內最猛的 5%）</span>}
              {data.latestSbl.state === 'normal' && <span className="ms-sbl-tag muted">正常範圍</span>}
            </div>
          )}
          {data.latestSbl.lendBal !== null && data.latestSbl.unsold !== null && (
            <div>
              借券餘額 <b>{f1(data.latestSbl.lendBal)}</b> 萬張｜已借未賣 <b>{f1(data.latestSbl.unsold)}</b> 萬張
              {data.latestSbl.unsoldChg5 !== null && (
                <>
                  ｜近5日 <span className={data.latestSbl.unsoldChg5 > 0 ? 'down' : data.latestSbl.unsoldChg5 < 0 ? 'up' : ''}>{f1(data.latestSbl.unsoldChg5, true)}</span> 萬張
                </>
              )}
              <span className="muted">（已借未賣＝借券餘額 − 借券賣出餘額，借了還沒砸出來的潛在空單）</span>
            </div>
          )}
        </div>
      )}

      {comp && <CompletionLine c={comp} />}

      <PanelNote>
        <p className="small muted ms-rule">
          圖怎麼看：上格加權指數——K 棒上方 ▼ 跌破 150／140、■ 斷頭潮；下方 ■ 去槓桿、▲ 清洗完成、▲ 追上（藍，完成度 ≥ 1）、● 限空令／國安基金。中格維持率（線，警戒時 Y 軸含 140 線；門檻線在畫面外時不標）＋融資增減（下方柱，億，紅增綠減）。
          第三格去槓桿完成度：指數自高點跌幅（黑）與融資餘額自高點減幅（藍）兩條 % 線，藍線追上黑線＝完成度 ≥ 1；虛線 0、點線 −{COMPLETION_MIN_DD}%。
          {data.sbl?.length ? '下格借券賣出餘額（粗線，萬張；追空極端段紅、回補極端段綠）＋已借未賣（藍虛線，獨立刻度，現值標在線尾）＋日增減（柱，增加＝空方加碼）；K 棒上方 ● 追空（紅）、下方 ● 回補（綠）。' : ''}
        </p>
        <p className="small muted ms-rule">
        警戒：維持率 &lt; {WARN_RATIO}% 或近 5 日降 &gt; {WARN_DROP_5D}pp；斷頭區：&lt; {ZONE_RATIO}%；斷頭潮：斷頭區內融資單日減幅為近 250
        日最大 5%（且 ≥ 0.5%）；清洗完成：近 20 日曾 &lt; 140%，維持率自低點回升 ≥ {CLEAR_REBOUND}pp、近 3 日無斷頭潮、加權 3 日不破低。每一波只標一次，回到 160% 以上才算新的一波。
      </p>
      <p className="small muted ms-rule">
        融資大減（主動去槓桿）：不限斷頭區，融資單日減幅占餘額比為近 250 日最大 2% 且 ≥ {-DELEVER_MIN_DROP_PCT}%，20 個交易日內只標一次——散戶在 140% 以上就自己砍的型態，斷頭潮規則抓不到。限空令／國安基金：人工維護的政策日期表（市場首個反應交易日），回答「政府出手後到底有沒有用」；同一天兩者都有時標兩個。
      </p>
      <p className="small muted ms-rule">
        去槓桿完成度＝融資餘額自高點累計減幅 ÷ 指數自高點跌幅，高點都在近 {COMPLETION_LOOKBACK} 個交易日內找，指數回落不到 {COMPLETION_MIN_DD}% 不算。
        維持率是平均數，斷頭把最弱的戶清掉反而會把平均撐住，所以用「清洗了多少」來看：&lt; {COMPLETION_LAG} 清洗落後、{COMPLETION_LAG}～{COMPLETION_DONE} 進行中、≥ {COMPLETION_DONE} 追上大盤。
        2020-03-19、2025-04-09、2026-07-30 的 V 轉底完成度都 ≥ 1.2；2024-08-05 當天只有 0.5（兩天急跌，隔天 0.9 才追上）；≥ 1 不保證見底——2022 慢熊 7 月已 1.3 仍再跌 3 個月。歷次事件表有「完成度」欄可對照。
        事件「追上」（▲ 藍，K 棒下方）＝指數自高點跌幅 ≥ {CAUGHT_UP_MIN_DD}% 且完成度從 &lt; 1 回到 ≥ 1 的第一天，同一波只標一次（指數回到高點 {COMPLETION_MIN_DD}% 以內才重新計）；進回測表。
        2010 起 8 次：2020-03-13、2026-07-28 都比實際低點早 2 個交易日（完成度先追上、指數再殺一段），2022-04-29 之後還跌 16%——它標的是「融資該賣的賣得差不多了」，不是底部。
      </p>
      {data.sbl?.length ? (
        <p className="small muted ms-rule">
          借券賣出餘額（上市）＝證交所逐檔「借券賣出當日餘額」加總，借券放空者幾乎都是外資／法人，可視為法人空單；融資是散戶槓桿（多方）。餘額在跌勢後段暴增＝空方追空、也是反彈時的軋空燃料；餘額連續下降＝空方回補。限空令期間當日賣出會被制度性壓低，判斷看餘額增減、不看當日賣出量。
          絕對張數 2010 約 100 萬張 → 2026 約 1,800 萬張，不能跨年比，所以極端值用「餘額 {SBL_CHG_DAYS} 日變化率」對「近 3 年（{SBL_BAND_DAYS} 個交易日）同一變化率的分位數」判：&gt; p95＝追空極端、&lt; p05＝回補極端，各自 {SBL_COOLDOWN} 日內只標一次，進回測表。
          2013 年中起（分位帶要 3 年資料）追空極端 16 次（含這波 2026-11-06），已完成 60 日的 15 次平均 +6.6%、六成上漲，但分布兩極：2016-01、2020-11、2024-04、2025-06、2026-03 之後都是大反彈（軋空），2015-05／06、2022-04 之後再跌 10%～14%，2020-03-11 雖然 60 日 +6.6% 但先再跌 20%——空方追到極端代表「燃料滿了」，點不點得著要看政策與融資清洗是否同時到位。回補極端 21 次 60 日 +2.7%，和基準差不多：回補是反彈的結果，不是原因。
          借券餘額（證交所借貸系統 TWT72U 上市逐檔加總）＝所有借出去還沒還的券，包含已賣出與還沒賣出的；減掉借券賣出餘額就是藍虛線「已借未賣」——借了券、隨時可以砸出來的潛在空單。已借未賣擴大＝空方囤彈，之後若轉成賣出，借券賣出餘額會補漲；但其中也有避險、套利、ETF 申贖用途的券，不全是看空，當輔助看、不進回測。借券餘額歷史自 2010 起逐日回補中，回補完成前虛線只有最近幾天。
        </p>
      ) : null}
      </PanelNote>

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
      <StressChart data={data} range={range} themeKey={themeKey} resetKey={resetKey} />

      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">
            事件發生後加權指數表現（{years}）{shortHistory && '— 歷史回補中，樣本仍少'}
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
            {EVENT_TYPES.map((t) => (
              <StatsRow key={t} label={EVENT_LABEL[t]} s={data.eventStats[t]} />
            ))}
            <StatsRow label="所有交易日（基準）" s={data.baseline} hl />
          </tbody>
        </table>
      </div>

      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">依每日狀態分組</caption>
          <thead>
            <tr>
              <th>狀態</th>
              <th className="r">時間占比</th>
              <th className="r">20日</th>
              <th className="r">60日</th>
              <th className="r">60日上漲</th>
              <th className="r">60日內最大跌幅</th>
            </tr>
          </thead>
          <tbody>
            {(['normal', 'warn', 'zone'] as const).map((s) => {
              const b = data.stateStats[s];
              return (
                <tr key={s} className={s === latest.state ? 'hl' : ''}>
                  <td>{STATE_LABEL[s]}</td>
                  <td className="r">{b.pct.toFixed(0)}%</td>
                  <td className="r">{pctCell(b.avg20)}</td>
                  <td className="r">{pctCell(b.avg60)}</td>
                  <td className="r">{pctCell(b.win60, false)}</td>
                  <td className="r">{pctCell(b.avgMdd60)}</td>
                </tr>
              );
            })}
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
                <th className="r">維持率</th>
                <th className="r">加權</th>
                <th className="r">完成度</th>
                <th className="r">20日</th>
                <th className="r">60日</th>
                <th className="r">最大跌幅</th>
              </tr>
            </thead>
            <tbody>
              {[...data.events].reverse().map((e) => {
                const i = indexByDate.get(e.date);
                const c = i === undefined ? null : completionAt(data.rows, i);
                return (
                <tr key={`${e.date}-${e.type}`}>
                  <td>{e.date}</td>
                  <td>
                    {EVENT_LABEL[e.type]}
                    {e.note && <div className="small muted">{e.note}</div>}
                  </td>
                  <td className="r">{e.ratio.toFixed(1)}%</td>
                  <td className="r">{e.taiex.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                  <td className="r">{c?.ratio === null || c?.ratio === undefined ? '—' : c.ratio.toFixed(2)}</td>
                  <td className="r">{pctCell(e.ret20)}</td>
                  <td className="r">{pctCell(e.ret60)}</td>
                  <td className="r">{pctCell(e.mdd60)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <PanelNote label="ⓘ 用法">
        <p className="small muted ms-rule">
        用法：維持率低代表槓桿賣壓接近出清，不代表基本面見底；請搭配上方總經判斷。事件次數少、60 日觀察期重疊，僅供提高警覺與分批參考，不計分。
      </p>
      </PanelNote>
    </section>
  );
}
