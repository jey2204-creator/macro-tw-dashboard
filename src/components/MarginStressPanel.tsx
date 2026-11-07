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
  CLEAR_REBOUND,
  DELEVER_MIN_DROP_PCT,
  EVENT_LABEL,
  EVENT_TYPES,
  STATE_LABEL,
  WARN_DROP_5D,
  WARN_RATIO,
  ZONE_RATIO,
  type MarginStressFile,
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
/** 有借券窗格時的四格比例：加權／維持率／融資增減／借券賣出 */
const SBL_PANE_STRETCH = [0.38, 0.27, 0.15, 0.2] as const;
const MARKER_TEXT: Record<StressEventType, string> = {
  below150: '150',
  below140: '140',
  flush: '斷頭',
  cleared: '清洗完成',
  delever: '去槓桿',
  shortBan: '限空',
  nsf: '國安',
};

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
      timeScale: { ...TIME_AXIS, rightOffset: 2, fixLeftEdge: true, fixRightEdge: true, minBarSpacing: 0.1 },
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
      shortBan: cssVar('--text-2'),
      nsf: cssVar('--text-2'),
    };
    // 維持率事件在 K 棒上方（▼▼■）、清洗完成與政策事件在下方（▲●●）、去槓桿方塊在下方
    const below = new Set<StressEventType>(['cleared', 'delever', 'shortBan', 'nsf']);
    const shape = (t: StressEventType) =>
      t === 'cleared' ? 'arrowUp' : t === 'flush' || t === 'delever' ? 'square' : t === 'shortBan' || t === 'nsf' ? 'circle' : 'arrowDown';
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
    ratio.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });
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
      }),
    );

    const up = cssVar('--up');
    const down = cssVar('--down');
    const chg = chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 2);
    chg.setData(
      data.rows.filter((r) => Number.isFinite(r[4])).map((r) => ({ time: r[0] as Time, value: r[4], color: r[4] >= 0 ? up : down })),
    );
    // 借券賣出（上市，萬張）：餘額折線 ＋ 日增減柱（增加＝空方加碼，用空方色）
    const sbl = data.sbl ?? [];
    let sblLine: ReturnType<typeof chart.addSeries> | null = null;
    let sblChg: ReturnType<typeof chart.addSeries> | null = null;
    if (sbl.length) {
      sblLine = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 3);
      sblLine.setData(sbl.map((r) => ({ time: r[0] as Time, value: r[1] })));
      sblChg = chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 1, minMove: 0.1 }, priceScaleId: 'sbl-chg' }, 3);
      sblChg.setData(sbl.filter((r) => Number.isFinite(r[2])).map((r) => ({ time: r[0] as Time, value: r[2], color: r[2] >= 0 ? down : up })));
      // 柱子只占窗格下方 1/3、折線留在上方 2/3，兩者不重疊
      chart.panes()[3]?.priceScale('sbl-chg')?.applyOptions({ scaleMargins: { top: 0.68, bottom: 0 }, visible: false });
      sblLine.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.36 } });
    }
    resetPaneStretch(chart, sbl.length ? SBL_PANE_STRETCH : undefined);
    return () => {
      chart.removeSeries(series);
      chart.removeSeries(ratio);
      chart.removeSeries(chg);
      if (sblLine) chart.removeSeries(sblLine);
      if (sblChg) chart.removeSeries(sblChg);
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
      resetPaneStretch(chart, data.sbl?.length ? SBL_PANE_STRETCH : undefined);
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
  const sblByDate = useMemo(() => new Map((data.sbl ?? []).map((r) => [r[0], r])), [data]);
  const sblRow = row ? sblByDate.get(row[0]) : undefined;
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
            </>
          )}
        </div>
      )}
      <div className="ms-pane-labels small muted" aria-hidden>
        上：加權指數（上方 ▼ 跌破 150／140、■ 斷頭潮；下方 ■ 去槓桿、▲ 清洗完成、● 限空令／國安基金） ｜ 維持率（警戒時 Y 軸含 140 線；門檻線在畫面外時不標） ｜ 融資增減（億）
        {data.sbl?.length ? ' ｜ 下：借券賣出餘額（萬張，線）與日增減（柱，增加＝空方加碼）' : ''}
      </div>
      <div ref={hostRef} className={`chart-host ms-host${data.sbl?.length ? ' ms-host-4' : ''}`} />
    </div>
  );
}

export function MarginStressPanel({ data, themeKey }: { data: MarginStressFile | null; themeKey: string }) {
  const [range, setRange] = useState<RangeKey>('3M');
  const [resetKey, setResetKey] = useState(0);
  const [showEvents, setShowEvents] = useState(false);
  if (!data || !data.latest) return null;
  const { latest } = data;
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
          {data.latestSbl.hi60 && <span className="ms-sbl-tag down">近 60 日新高（空方追空）</span>}
          {data.latestSbl.lo60 && <span className="ms-sbl-tag up">近 60 日新低（空方回補）</span>}
          <span className="muted">（上市，{data.latestSbl.date}）</span>
        </div>
      )}

      <PanelNote>
        <p className="small muted ms-rule">
        警戒：維持率 &lt; {WARN_RATIO}% 或近 5 日降 &gt; {WARN_DROP_5D}pp；斷頭區：&lt; {ZONE_RATIO}%；斷頭潮：斷頭區內融資單日減幅為近 250
        日最大 5%（且 ≥ 0.5%）；清洗完成：近 20 日曾 &lt; 140%，維持率自低點回升 ≥ {CLEAR_REBOUND}pp、近 3 日無斷頭潮、加權 3 日不破低。每一波只標一次，回到 160% 以上才算新的一波。
      </p>
      <p className="small muted ms-rule">
        融資大減（主動去槓桿）：不限斷頭區，融資單日減幅占餘額比為近 250 日最大 2% 且 ≥ {-DELEVER_MIN_DROP_PCT}%，20 個交易日內只標一次——散戶在 140% 以上就自己砍的型態，斷頭潮規則抓不到。限空令／國安基金：人工維護的政策日期表（市場首個反應交易日），回答「政府出手後到底有沒有用」；同一天兩者都有時標兩個。
      </p>
      {data.sbl?.length ? (
        <p className="small muted ms-rule">
          借券賣出餘額（上市）＝證交所逐檔「借券賣出當日餘額」加總，借券放空者幾乎都是外資／法人，可視為法人空單；融資是散戶槓桿（多方）。餘額在跌勢後段暴增＝空方追空、也是反彈時的軋空燃料；餘額連續下降＝空方回補。限空令期間當日賣出會被制度性壓低，判斷看餘額增減、不看當日賣出量。只有每日排程資料（回補約半年），不進回測。
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
                <th className="r">20日</th>
                <th className="r">60日</th>
                <th className="r">最大跌幅</th>
              </tr>
            </thead>
            <tbody>
              {[...data.events].reverse().map((e) => (
                <tr key={`${e.date}-${e.type}`}>
                  <td>{e.date}</td>
                  <td>
                    {EVENT_LABEL[e.type]}
                    {e.note && <div className="small muted">{e.note}</div>}
                  </td>
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
      <PanelNote label="ⓘ 用法">
        <p className="small muted ms-rule">
        用法：維持率低代表槓桿賣壓接近出清，不代表基本面見底；請搭配上方總經判斷。事件次數少、60 日觀察期重疊，僅供提高警覺與分批參考，不計分。
      </p>
      </PanelNote>
    </section>
  );
}
