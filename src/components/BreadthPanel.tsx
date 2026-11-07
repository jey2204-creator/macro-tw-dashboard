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
import { PanelNote } from './PanelNote';
import { CHART_INTERACTION, resetPaneStretch, resetPriceScales, attachTimeAxis, TIME_AXIS } from '../lib/chartInteraction';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cssVar, f2, pctCell } from '../lib/stressFormat';
import {
  BREADTH_EVENT_LABEL,
  EPISODE_GAP,
  PANIC_MIN_PCT,
  type BreadthEventType,
  type BreadthStressFile,
} from '../shared/breadthStress';
import { rangeStart, type RangeKey } from '../shared/timeseries';
import { StatsRow } from './StatsRow';
import { BREADTH_MARKET, type BreadthMarket } from '../lib/breadthMarket';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
const TYPES: BreadthEventType[] = ['panic', 'capitulate', 'divergence', 'stabilized'];
/** 中格顯示：漲停／跌停家數，或上漲／下跌家數 */
export type MidMode = 'limit' | 'ad';
const MID_MODES: { k: MidMode; label: string }[] = [
  { k: 'limit', label: '漲跌停' },
  { k: 'ad', label: '漲跌家數' },
];
const MARKER_TEXT: Record<BreadthEventType, string> = { panic: '恐慌', capitulate: '投降', divergence: '背離', stabilized: '止跌' };

function BreadthChart({
  data,
  range,
  mid,
  themeKey,
  resetKey,
  indexLabel,
}: {
  data: BreadthStressFile;
  range: RangeKey;
  mid: MidMode;
  themeKey: string;
  resetKey: number;
  indexLabel: string;
}) {
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
    const price = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 0);
    // Y 軸收緊：只依畫面內高低點縮放，上下各留約 6%（預設上方留 20%，手機上浪費一大截）
    price.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });
    price.setData(data.rows.map((r) => ({ time: r[0] as Time, value: r[1] })));
    const color: Record<BreadthEventType, string> = {
      panic: cssVar('--warn'),
      capitulate: cssVar('--err'),
      divergence: cssVar('--accent'),
      stabilized: cssVar('--accent'),
    };
    const markers: SeriesMarker<Time>[] = data.events.map((e) => ({
      time: e.date as Time,
      position: e.type === 'stabilized' || e.type === 'divergence' ? 'belowBar' : 'aboveBar',
      shape: e.type === 'stabilized' ? 'arrowUp' : e.type === 'divergence' ? 'circle' : e.type === 'capitulate' ? 'square' : 'arrowDown',
      color: color[e.type],
      text: MARKER_TEXT[e.type],
    }));
    createSeriesMarkers(price, markers);

    const up = cssVar('--up');
    const down = cssVar('--down');
    const err = cssVar('--err');
    const fmt0 = { type: 'price' as const, precision: 0, minMove: 1 };
    // 中格：漲停／跌停（0 以上／以下），或上漲／下跌家數；跌的那側恐慌日加深顏色
    const ad = mid === 'ad';
    const ul = chart.addSeries(
      HistogramSeries,
      { priceFormat: fmt0, color: up, priceLineVisible: false, lastValueVisible: ad },
      1,
    );
    ul.setData(data.rows.map((r) => ({ time: r[0] as Time, value: ad ? r[4] : r[2] })));
    const dl = chart.addSeries(HistogramSeries, { priceFormat: fmt0, priceLineVisible: false, lastValueVisible: ad }, 1);
    dl.setData(data.rows.map((r, i) => ({ time: r[0] as Time, value: -(ad ? r[5] : r[3]), color: data.panic[i] ? err : down })));
    ul.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });

    const adr = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } }, 2);
    adr.setData(data.rows.flatMap((r, i) => (data.adRatio10[i] == null ? [] : [{ time: r[0] as Time, value: data.adRatio10[i]! }])));
    adr.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
    adr.createPriceLine({ price: 1, color: cssVar('--text-3'), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '漲跌持平 1.0' });

    resetPaneStretch(chart);
    return () => {
      for (const s of [price, ul, dl, adr]) chart.removeSeries(s);
    };
  }, [data, mid, themeKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = data.rows.at(-1);
    if (!chart || !last) return;
    const start = rangeStart(last[0], range);
    const from = start ? Math.max(0, data.rows.findIndex((r) => r[0] >= start)) : 0;
    const apply = () => {
      chart.timeScale().setVisibleLogicalRange({ from, to: data.rows.length + 1 });
      resetPriceScales(chart);
      resetPaneStretch(chart);
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [data, range, mid, themeKey, resetKey]);

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
  return (
    <div className="pricechart ms-chart">
      {row && (
        <div className="legend num" aria-live="off">
          <span className="muted">{row[0]}</span> {indexLabel} <b>{row[1].toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>{' '}
          <span className="up">漲停 {row[2]}</span> <span className="down">跌停 {row[3]}</span>（占比 {f2(data.downPct[i])}%）{' '}
          <span className="up">漲 {row[4]}</span> <span className="down">跌 {row[5]}</span>{' '}
          10日漲跌比 {f2(data.adRatio10[i])} {data.panic[i] && <span className="ms-state ms-zone">恐慌日</span>}
        </div>
      )}
      <div ref={hostRef} className="chart-host ms-host br-host" />
    </div>
  );
}

/** 單一市場的讀數列（標題下方）＋回測表＋歷次事件 */
function MarketStats({ data, market, showEvents, onToggle }: { data: BreadthStressFile; market: BreadthMarket; showEvents: boolean; onToggle: () => void }) {
  const M = BREADTH_MARKET[market];
  const shortHistory = !data.start || data.start > M.historySince;
  return (
    <>
      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">
            {M.name}：事件發生後{M.index}指數表現（{data.start}～{data.end}）{shortHistory && '— 歷史回補中，樣本仍少'}
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
            {TYPES.map((t) => (
              <StatsRow key={t} label={BREADTH_EVENT_LABEL[t]} s={data.eventStats[t]} />
            ))}
            <StatsRow label={`所有恐慌日（占 ${data.dayStats.panic.pct.toFixed(1)}%）`} s={data.dayStats.panic} />
            <StatsRow label="所有交易日（基準）" s={data.baseline} hl />
          </tbody>
        </table>
      </div>
      <button type="button" className="linkbtn small" onClick={onToggle} aria-expanded={showEvents}>
        {showEvents ? '收起' : '展開'}{M.name}歷次事件（{data.events.length}）
      </button>
      {showEvents && (
        <div className="table-wrap">
          <table className="bt-table num">
            <thead>
              <tr>
                <th>日期</th>
                <th>事件</th>
                <th className="r">漲停</th>
                <th className="r">跌停</th>
                <th className="r">{M.index}</th>
                <th className="r">20日</th>
                <th className="r">60日</th>
                <th className="r">最大跌幅</th>
              </tr>
            </thead>
            <tbody>
              {[...data.events].reverse().map((e) => (
                <tr key={`${e.date}-${e.type}`}>
                  <td>{e.date}</td>
                  <td>{MARKER_TEXT[e.type]}</td>
                  <td className="r">{e.upLimit}</td>
                  <td className="r">{e.downLimit}</td>
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
    </>
  );
}

function MarketScore({ data, market }: { data: BreadthStressFile; market: BreadthMarket }) {
  const M = BREADTH_MARKET[market];
  const { latest } = data;
  if (!latest) return null;
  const state = latest.panic ? 'zone' : latest.inEpisode ? 'warn' : 'normal';
  const stateText = latest.panic ? '恐慌日' : latest.inEpisode ? '恐慌後觀察期' : '平靜';
  const lastRow = data.rows.at(-1);
  return (
    <div className="br-score num">
      <span className="br-mkt">{M.name}</span>
      <span className={`verdict ms-${state}`}>{stateText}</span>
      <span className="score">
        <span className="up">漲停 {latest.upLimit}</span>｜<span className="down">跌停 {latest.downLimit}</span>｜占比 {f2(latest.downPct)}%
        {latest.downPctile !== null && `（近一年第 ${latest.downPctile.toFixed(0)} 百分位）`}
        {lastRow && (
          <>
            ｜<span className="up">漲 {lastRow[4]}</span>｜<span className="down">跌 {lastRow[5]}</span>
          </>
        )}
        ｜10日漲跌比 {f2(latest.adRatio10)}
      </span>
    </div>
  );
}

/** 漲跌停家數監測：上市（加權）與上櫃（櫃買）同一個模組，共用時間區間、中格切換、說明；兩張圖上下排 */
export function BreadthPanel({ twse, otc, themeKey }: { twse: BreadthStressFile | null; otc?: BreadthStressFile | null; themeKey: string }) {
  const [range, setRange] = useState<RangeKey>('3M');
  const [mid, setMid] = useState<MidMode>('limit');
  const [resetKey, setResetKey] = useState(0);
  const [showEvents, setShowEvents] = useState<Record<BreadthMarket, boolean>>({ twse: false, tpex: false });
  const markets: { market: BreadthMarket; data: BreadthStressFile }[] = [];
  if (twse?.latest) markets.push({ market: 'twse', data: twse });
  if (otc?.latest) markets.push({ market: 'tpex', data: otc });
  if (!markets.length) return null;
  const latestDate = markets.map((m) => m.data.latest!.date).sort().at(-1);
  const toggle = (m: BreadthMarket) => setShowEvents((s) => ({ ...s, [m]: !s[m] }));
  return (
    <section id="sec-br" className="regime ms" aria-label="漲跌停家數監測">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">漲跌停家數監測（上市＋上櫃，參考）</span>
        </div>
        <span className="small muted num">資料 {latestDate}</span>
      </div>
      {markets.map((m) => (
        <MarketScore key={m.market} data={m.data} market={m.market} />
      ))}

      <PanelNote>
        <p className="small muted ms-rule">
          圖怎麼看（上市、上櫃兩張圖相同）：上格指數線——▼ 恐慌、■ 投降、● 背離、▲ 止跌；中格
          {mid === 'ad' ? '上漲家數（0 以上）／下跌家數（0 以下，恐慌日加深）' : '漲停（0 以上）／跌停（0 以下，恐慌日加深）'}；下格 10 日上漲÷下跌家數（虛線＝1.0 漲跌持平）。
        </p>
        <p className="small muted ms-rule">
          恐慌：跌停占比（跌停÷上漲＋下跌家數）達近 250 日第 98 百分位且 ≥ {PANIC_MIN_PCT}%；投降：連續 2 日恐慌（上市另加「恐慌日融資維持率 &lt; 140%」，上櫃沒有維持率可用）；背離：指數跌破本波低點但跌停不到本波高峰一半；止跌：漲停 &gt; 跌停連續 2 日且指數 3 日不破低。最後一個恐慌日後 {EPISODE_GAP} 個交易日內算同一波，每種事件每波只標一次。2015-06-01 前漲跌幅為 7%，因此用百分位而非固定家數。上市家數取自證交所「漲跌證券數合計」（2011 年中以前逐檔推算）；上櫃家數由櫃買中心每日收盤行情逐檔推算（只算普通股，不含 ETF、權證），歷史自 2008 年起。
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
        <div className="seg" role="group" aria-label="中格顯示">
          {MID_MODES.map((o) => (
            <button key={o.k} type="button" aria-pressed={mid === o.k} onClick={() => setMid(o.k)} title="切換兩張圖中間窗格顯示的內容">
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {markets.map((m) => (
        <BreadthChart key={m.market} data={m.data} range={range} mid={mid} themeKey={themeKey} resetKey={resetKey} indexLabel={BREADTH_MARKET[m.market].index} />
      ))}

      {markets.map((m) => (
        <MarketStats key={m.market} data={m.data} market={m.market} showEvents={showEvents[m.market]} onToggle={() => toggle(m.market)} />
      ))}
      <PanelNote label="ⓘ 用法">
        <p className="small muted ms-rule">
          用法：恐慌本身不是進場訊號（恐慌常持續 2–5 天）；背離、止跌再搭配上方「融資斷頭監測」的清洗完成與總經判斷，才考慮分批。上櫃以中小型股為主，恐慌通常比上市更早、更深；上櫃先止跌、上市還在跌，常是資金回流中小型股的開端。僅供參考，不計分。
        </p>
      </PanelNote>
    </section>
  );
}
