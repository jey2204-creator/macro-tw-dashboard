import {
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
import { CHART_INTERACTION, resetPriceScales } from '../lib/chartInteraction';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CLEAR_REBOUND,
  EVENT_LABEL,
  STATE_LABEL,
  WARN_DROP_5D,
  WARN_RATIO,
  ZONE_RATIO,
  type MarginStressFile,
  type StressEventType,
} from '../shared/marginStress';
import { rangeStart, type RangeKey } from '../shared/timeseries';
import { cssVar, f2, pctCell } from '../lib/stressFormat';
import { StatsRow } from './StatsRow';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: 'ALL', label: '全部' },
];
const EVENT_TYPES: StressEventType[] = ['below150', 'below140', 'flush', 'cleared'];
const MARKER_TEXT: Record<StressEventType, string> = { below150: '150', below140: '140', flush: '斷頭', cleared: '清洗完成' };

function StressChart({ data, range, themeKey, resetKey }: { data: MarginStressFile; range: RangeKey; themeKey: string; resetKey: number }) {
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
      timeScale: { rightOffset: 2, minBarSpacing: 0.1 },
      ...CHART_INTERACTION,
    });
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
    const color: Record<StressEventType, string> = {
      below150: cssVar('--warn'),
      below140: cssVar('--err'),
      flush: cssVar('--err'),
      cleared: cssVar('--accent'),
    };
    const markers: SeriesMarker<Time>[] = data.events.map((e) => ({
      time: e.date as Time,
      position: e.type === 'cleared' ? 'belowBar' : 'aboveBar',
      shape: e.type === 'cleared' ? 'arrowUp' : e.type === 'flush' ? 'square' : 'arrowDown',
      color: color[e.type],
      text: MARKER_TEXT[e.type],
    }));
    createSeriesMarkers(series, markers);

    const ratio = chart.addSeries(
      LineSeries,
      { color: cssVar('--accent'), lineWidth: 2, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } },
      1,
    );
    ratio.setData(data.rows.map((r) => ({ time: r[0] as Time, value: r[2] })));
    for (const [v, t] of [
      [WARN_RATIO, '警戒 160'],
      [ZONE_RATIO, '斷頭區 140'],
      [130, '追繳 130'],
    ] as const) {
      ratio.createPriceLine({ price: v, color: cssVar('--text-3'), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: t });
    }

    const up = cssVar('--up');
    const down = cssVar('--down');
    const chg = chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 2);
    chg.setData(
      data.rows.filter((r) => Number.isFinite(r[4])).map((r) => ({ time: r[0] as Time, value: r[4], color: r[4] >= 0 ? up : down })),
    );
    const panes = chart.panes();
    panes[0]?.setStretchFactor(0.45);
    panes[1]?.setStretchFactor(0.33);
    panes[2]?.setStretchFactor(0.22);
    return () => {
      chart.removeSeries(series);
      chart.removeSeries(ratio);
      chart.removeSeries(chg);
    };
  }, [data, themeKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = data.rows.at(-1);
    if (!chart || !last) return;
    // 以 K 棒索引設定可視範圍（不受圖表初次排版時寬度為 0 的影響）
    const start = rangeStart(last[0], range);
    const from = start ? Math.max(0, data.rows.findIndex((r) => r[0] >= start)) : 0;
    const apply = () => {
      chart.timeScale().setVisibleLogicalRange({ from, to: data.rows.length + 1 });
      resetPriceScales(chart);
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
  const state = data.states[i];
  return (
    <div className="pricechart ms-chart">
      {row && (
        <div className="legend num" aria-live="off">
          <span className="muted">{row[0]}</span> 加權 <b>{row[1].toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>{' '}
          維持率 <b>{f2(row[2])}%</b> 融資增減{' '}
          <span className={row[4] > 0 ? 'up' : row[4] < 0 ? 'down' : ''}>{f2(row[4], true)} 億</span>{' '}
          {state && <span className={`ms-state ms-${state}`}>{STATE_LABEL[state]}</span>}
        </div>
      )}
      <div className="ms-pane-labels small muted" aria-hidden>
        上：加權指數（▼ 跌破 150／140、■ 斷頭潮、▲ 清洗完成） ｜ 中：維持率 ｜ 下：融資增減（億）
      </div>
      <div ref={hostRef} className="chart-host ms-host" />
    </div>
  );
}

export function MarginStressPanel({ data, themeKey }: { data: MarginStressFile | null; themeKey: string }) {
  const [range, setRange] = useState<RangeKey>('5Y');
  const [resetKey, setResetKey] = useState(0);
  const [showEvents, setShowEvents] = useState(false);
  if (!data || !data.latest) return null;
  const { latest } = data;
  const years = data.start && data.end ? `${data.start}～${data.end}` : '';
  const shortHistory = !data.start || data.start > '2011-01-01';
  return (
    <section className="regime ms" aria-label="融資斷頭監測">
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

      <p className="small muted ms-rule">
        警戒：維持率 &lt; {WARN_RATIO}% 或近 5 日降 &gt; {WARN_DROP_5D}pp；斷頭區：&lt; {ZONE_RATIO}%；斷頭潮：斷頭區內融資單日減幅為近 250
        日最大 5%（且 ≥ 0.5%）；清洗完成：近 20 日曾 &lt; 140%，維持率自低點回升 ≥ {CLEAR_REBOUND}pp、近 3 日無斷頭潮、加權 3 日不破低。每一波只標一次，回到 160% 以上才算新的一波。
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
                <th className="r">20日</th>
                <th className="r">60日</th>
                <th className="r">最大跌幅</th>
              </tr>
            </thead>
            <tbody>
              {[...data.events].reverse().map((e) => (
                <tr key={`${e.date}-${e.type}`}>
                  <td>{e.date}</td>
                  <td>{EVENT_LABEL[e.type]}</td>
                  <td className="r">{e.ratio.toFixed(1)}%</td>
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
        用法：維持率低代表槓桿賣壓接近出清，不代表基本面見底；請搭配上方總經判斷。事件次數少、60 日觀察期重疊，僅供提高警覺與分批參考，不計分。
      </p>
    </section>
  );
}
