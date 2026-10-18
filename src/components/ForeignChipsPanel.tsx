import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
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

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
/** 事件文字最少相隔幾根 K 棒（依視圖長度），避免疊字 */
const MARKER_GAP: Record<RangeKey, number> = { '3M': 6, '6M': 10, '1Y': 16, '5Y': 40, '10Y': 60, 'ALL': 60 };
/** 四個窗格高度比例：加權／買賣超／外資期 OI／散戶小台 OI */
const FC_PANE_STRETCH = [0.34, 0.22, 0.22, 0.22] as const;

const lots = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pctlText = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `第 ${Math.round(p * 100)} 百分位`);
/** 百分位落在極端時的樣式類別 */
const pctlClass = (p: number | null | undefined) =>
  p === null || p === undefined ? '' : p <= EXTREME_LOW || p >= EXTREME_HIGH ? 'fc-extreme' : '';

function ChipsChart({ data, range, themeKey, resetKey }: { data: ForeignChipsFile; range: RangeKey; themeKey: string; resetKey: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const indexByDate = useMemo(() => new Map(data.rows.map((r, i) => [r[0], i])), [data]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd' },
      timeScale: { ...TIME_AXIS, rightOffset: 8, fixLeftEdge: true, fixRightEdge: false, minBarSpacing: 0.1 },
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
    const markerColor: Record<ForeignEventType, string> = {
      oi_short: down,
      oi_long: up,
      sell_extreme: down,
      buy_extreme: up,
      retail_long: warn,
      sell_no_fall: accent,
      sell_exhaust: up,
    };
    // 同日事件合併成一個點（文字以「／」相連）；相鄰 ≤ MARKER_GAP 根 K 棒的事件只有第一個帶文字
    const byDate = new Map<string, ForeignEventType[]>();
    for (const e of data.events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e.type]);
    const markers: SeriesMarker<Time>[] = [];
    let lastTextIdx = -Infinity;
    for (const [date, types] of byDate) {
      const idx = indexByDate.get(date) ?? 0;
      const above = types.some((t) => t === 'oi_long' || t === 'buy_extreme' || t === 'retail_long');
      const withText = idx - lastTextIdx > MARKER_GAP[range];
      if (withText) lastTextIdx = idx;
      markers.push({
        time: date as Time,
        position: above ? 'aboveBar' : 'belowBar',
        shape: 'circle',
        color: markerColor[types[0]!],
        text: withText ? types.map((t) => FOREIGN_MARKER_TEXT[t]).join('／') : undefined,
      });
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

    // 中：外資買賣超柱＋5／20 日累計線
    // 單日柱用獨立刻度貼在窗格底部，否則被 ±數千億的累計線壓得看不見
    const net = add(chart.addSeries(HistogramSeries, { priceFormat: lotsFmt, priceScaleId: 'net', priceLineVisible: false, lastValueVisible: false }, 1));
    net.priceScale().applyOptions({ scaleMargins: { top: 0.55, bottom: 0 } });
    net.setData(data.rows.filter((r) => r[2] !== null).map((r) => ({ time: r[0] as Time, value: r[2]!, color: r[2]! >= 0 ? up : down })));
    const cum5 = add(chart.addSeries(LineSeries, { color: warn, lineWidth: 1, priceFormat: lotsFmt, priceLineVisible: false, lastValueVisible: false }, 1));
    cum5.setData(data.rows.filter((r) => r[3] !== null).map((r) => ({ time: r[0] as Time, value: r[3]! })));
    const cum20 = add(chart.addSeries(LineSeries, { color: accent, lineWidth: 2, priceFormat: lotsFmt }, 1));
    cum20.setData(data.rows.filter((r) => r[4] !== null).map((r) => ({ time: r[0] as Time, value: r[4]! })));

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
    oiPane(3, (r) => r[7], (r) => r[8]);
    resetPaneStretch(chart, FC_PANE_STRETCH);
    return () => {
      for (const s of all.reverse()) chart.removeSeries(s);
    };
  }, [data, themeKey, indexByDate, range]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = data.rows.at(-1);
    if (!chart || !last) return;
    const start = rangeStart(last[0], range);
    const from = start ? Math.max(0, data.rows.findIndex((r) => r[0] >= start)) : 0;
    const apply = () => {
      chart.timeScale().setVisibleLogicalRange({ from, to: data.rows.length + 8 });
      resetPriceScales(chart);
      resetPaneStretch(chart, FC_PANE_STRETCH);
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
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
  const sgn = (v: number | null) => (v === null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
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
          ｜散戶小台 <b className={sgn(row[7])}>{lots(row[7])}</b> 口{' '}
          <span className={`muted ${pctlClass(data.pctl.retailOi[i])}`}>（{pctlText(data.pctl.retailOi[i])}）</span>
        </div>
      )}
      <div className="ms-pane-labels small muted" aria-hidden>
        上：加權（● 事件、小● 再創極端，點一下看名稱） ｜ 二：外資買賣超（億）＋5日細／20日粗累計 ｜ 三：外資期淨OI（口）＋日增減 ｜ 四：散戶小台淨OI（口）＋日增減
      </div>
      <div ref={hostRef} className="chart-host fc-host" />
    </div>
  );
}

export function ForeignChipsPanel({ data, themeKey }: { data: ForeignChipsFile | null; themeKey: string }) {
  const [range, setRange] = useState<RangeKey>('3M');
  const [resetKey, setResetKey] = useState(0);
  const [showEvents, setShowEvents] = useState(false);
  if (!data || !data.latest) return null;
  const { latest } = data;
  const years = data.start && data.end ? `${data.start}～${data.end}` : '';
  const extreme = [
    latest.foreignOiPctl !== null && latest.foreignOiPctl <= EXTREME_LOW && '外資期空單極端',
    latest.foreignOiPctl !== null && latest.foreignOiPctl >= EXTREME_HIGH && '外資期多單極端',
    latest.cum20Pctl !== null && latest.cum20Pctl <= EXTREME_LOW && '20日累計賣超極端',
    latest.cum20Pctl !== null && latest.cum20Pctl >= EXTREME_HIGH && '20日累計買超極端',
    latest.retailOiPctl !== null && latest.retailOiPctl >= EXTREME_HIGH && '散戶小台偏多極端',
  ].filter((x): x is string => typeof x === 'string');
  return (
    <section className="regime ms fc" aria-label="外資籌碼對照">
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

      <p className="small muted ms-rule">
        買賣超是流量、淨未平倉是部位，兩者與當日漲跌幾乎同步，單看柱子不會比看 K 棒多知道什麼；要看的是<b>累計 vs 指數的背離</b>與<b>部位極端</b>。
        百分位＝該值在近 {PCTL_WINDOW} 個交易日中的位置；事件只在首次 ≤ 第 {EXTREME_LOW * 100}／≥ 第 {EXTREME_HIGH * 100} 百分位時標一次，回到第 {RESET_PCTL * 100} 百分位另一側才算新的一波。賣超不跌：20 日累計 ≤ 第 {DIVERGE_PCTL * 100} 百分位且加權 20 日不跌。賣壓衰竭：20 日累計在 0 以下、「5 日累計 × {PACE_RATIO}」由下往上穿過 20 日累計（最近一週的賣超步調慢過整月平均），再掉回去才可再標。
        同一波內外資期淨 OI 比前次標記再多 {DEEPER_STEP * 100}% 補一個小標記「OI空↓／OI多↑」，只畫在圖上不進回測。外資期空單多為現貨避險，空單極端不等於看空；散戶小台為法人反推值。
      </p>

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
      <ChipsChart data={data} range={range} themeKey={themeKey} resetKey={resetKey} />

      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">事件發生後加權指數表現（{years}）— 買賣超資料僅自 2025-10 起、期貨自 2024-10 起，樣本仍少，只看方向不看數字</caption>
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
      <p className="small muted ms-rule">
        用法：買賣超看「最近一週的步調 vs 這個月」而不是正負——5 日 × {PACE_RATIO} 比 20 日還低＝賣壓集中在最近幾天、還在加速；5 日拐頭往 0 收到步調慢過整月＝衰竭。三格同向不等於三個證據（外資期空單增加常伴隨賣超現貨）。有用的是「連續賣超但指數不跌」「散戶偏多極端時外資反向」這類關係斷裂；資料累積滿一年後再回測決定是否計分，目前不計分。
      </p>
    </section>
  );
}
