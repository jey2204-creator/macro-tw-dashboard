import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type IChartApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSeriesMap } from '../hooks/useData';
import { CHART_INTERACTION, attachTimeAxis, resetPaneStretch, resetPriceScales, TIME_AXIS } from '../lib/chartInteraction';
import { RiverBands, type RiverBand } from '../lib/riverBands';
import { loadPref, savePref } from '../lib/storage';
import { cssVar, pctCell } from '../lib/stressFormat';
import { hexAlpha } from '../lib/zoneBands';
import { INDICATOR_MAP, zoneAt } from '../shared/indicators';
import {
  EPS_JUMP_PCT,
  JP_BASE_START,
  JP_RIVER_MULTIPLES,
  epsJumps,
  jpRiverRows,
  jpRowAtOrBefore,
  jpValuationBacktest,
  spreadText,
  summarizeJp,
  type JpRow,
} from '../shared/jpValuation';
import { rangeStart, type Point, type RangeKey } from '../shared/timeseries';
import type { ValBucket } from '../shared/twValuation';
import { closesOf } from '../shared/usValuation';
import { PanelNote } from './PanelNote';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
const PANE_STRETCH = [0.46, 0.18, 0.18, 0.18] as const;
const IDS = ['nikkei', 'jp_fwd_pe', 'jp_fwd_pe_w', 'jp_pb', 'jp_dy', 'jp10y', 'us10y'];
const PE_ZONES = INDICATOR_MAP['jp_fwd_pe']!.zones ?? [];
const PB_ZONES = INDICATOR_MAP['jp_pb']!.zones ?? [];
const BASE_YEAR = JP_BASE_START.slice(0, 4);

const fin = (v: number | null | undefined) => v !== null && v !== undefined && Number.isFinite(v);
const f1 = (v: number | null | undefined) => (fin(v) ? v!.toFixed(1) : '—');
const f2 = (v: number | null | undefined) => (fin(v) ? v!.toFixed(2) : '—');
const fInt = (v: number | null | undefined) => (fin(v) ? Math.round(v!).toLocaleString('en-US') : '—');
const fpct = (v: number | null | undefined, d = 1) => (fin(v) ? `${v! > 0 ? '+' : ''}${v!.toFixed(d)}%` : '—');
const fpp = (v: number | null | undefined) => (fin(v) ? `${v! > 0 ? '+' : ''}${v!.toFixed(2)}pp` : '—');
const pctile = (v: number | null | undefined) => (fin(v) ? `第 ${Math.round(v!)} 百分位` : '—');
const monthLabel = (ym: string | null) => (ym ? `${Number(ym.slice(5, 7))}月` : '');
/** 2026-05-15 → 2026/5/15 */
const dLabel = (d: string) => `${d.slice(0, 4)}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

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

const pctInt = (v: number | null, sign = true) => (v === null ? '—' : `${sign && v > 0 ? '+' : ''}${Math.round(v)}%`);

function BucketRow({ b, hl }: { b: ValBucket; hl?: boolean }) {
  return (
    <tr className={hl ? 'hl' : ''}>
      <td>{b.label}</td>
      <td className="r">{b.months}</td>
      <td className="r">{pctCell(b.avg1)}</td>
      <td className="r">{pctInt(b.win1, false)}</td>
      <td className="r nowrap">
        {pctInt(b.early1)}／{pctInt(b.late1)}
      </td>
      <td className="r">{pctCell(b.avg3)}</td>
    </tr>
  );
}

export function JpValuationPanel({ version, themeKey }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const near = useNearViewport(sectionRef);
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('jv-range', ['3M', '6M', '1Y', '5Y', '10Y', 'ALL'], '10Y'));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const files = useSeriesMap(near ? IDS : [], version);
  const data = useMemo(() => {
    const ready = (id: string): Point[] => (files[id]?.status === 'ready' ? closesOf(files[id]!.data.data) : []);
    const nikkei = ready('nikkei');
    const jp10y = ready('jp10y');
    const rows = jpRiverRows(nikkei, ready('jp_fwd_pe'), ready('jp_fwd_pe_w'), ready('jp_pb'), jp10y);
    return { rows, nikkei, jp10y, dy: ready('jp_dy'), us10y: ready('us10y') };
  }, [files]);
  const { rows } = data;
  const summary = useMemo(() => summarizeJp(rows, data.dy, data.jp10y, data.us10y, PE_ZONES, PB_ZONES), [rows, data]);
  const backtest = useMemo(() => jpValuationBacktest(rows, data.nikkei, data.jp10y), [rows, data]);
  const jumps = useMemo(() => epsJumps(rows), [rows]);

  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('jv-range', r);
  };

  const loaded = rows.length > 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !loaded || !summary) return;
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
    const times = rows.map((r) => r.date as Time);
    const ptFmt = { type: 'price' as const, precision: 0, minMove: 1 };
    const x1Fmt = { type: 'price' as const, precision: 1, minMove: 0.1 };
    const x2Fmt = { type: 'price' as const, precision: 2, minMove: 0.01 };
    const peColor = (v: number) => cssVar(zoneAt(PE_ZONES, v)?.color ?? '--text-1');
    const pbColor = (v: number) => cssVar(zoneAt(PB_ZONES, v)?.color ?? '--text-1');
    const alpha = Math.min(0.35, (Number.parseFloat(cssVar('--lamp-band-alpha')) || 0.1) * 1.6);

    // 上窗格：日經 225（對數軸）＋ 6 條倍數線 ＋ 色帶
    const priceS = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: ptFmt, lastValueVisible: false }, 0);
    priceS.setData(rows.map((r, i) => ({ time: times[i]!, value: r.price })));
    const bandValues = JP_RIVER_MULTIPLES.map((m) => rows.map((r) => r.eps * m));
    for (const vals of bandValues) {
      const s = chart.addSeries(
        LineSeries,
        { color: textColor, lineWidth: 1, priceFormat: ptFmt, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
        0,
      );
      s.setData(vals.map((v, i) => ({ time: times[i]!, value: v })));
    }
    const bands: RiverBand[] = [];
    for (let k = 0; k + 1 < JP_RIVER_MULTIPLES.length; k++) {
      bands.push({ lower: bandValues[k]!, upper: bandValues[k + 1]!, color: hexAlpha(peColor(JP_RIVER_MULTIPLES[k]!), alpha) });
    }
    priceS.attachPrimitive(new RiverBands(bands));

    // 第二格：預估本益比（指數基準，依區間上色）；灰色點線＝加重平均；虛線＝基期中位數；▲／▼＝換年度或大幅修正
    const peS = chart.addSeries(LineSeries, { color: peColor(summary.pe), lineWidth: 2, priceFormat: x1Fmt, lastValueVisible: false }, 1);
    peS.setData(rows.map((r, i) => ({ time: times[i]!, value: r.pe, color: peColor(r.pe) })));
    if (summary.peStats) {
      peS.createPriceLine({ price: summary.peStats.median, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }
    const peWS = chart.addSeries(
      LineSeries,
      { color: textColor, lineWidth: 1, lineStyle: LineStyle.Dotted, priceFormat: x1Fmt, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
      1,
    );
    peWS.setData(rows.map((r, i) => (r.peW === null ? { time: times[i]! } : { time: times[i]!, value: r.peW })));
    // 只畫箭頭不標字（十年內有幾十次，標字會疊在一起）；幅度在圖例列看
    const markers: SeriesMarker<Time>[] = jumps.map((j) => ({
      time: j.date as Time,
      position: j.pct > 0 ? 'belowBar' : 'aboveBar',
      shape: j.pct > 0 ? 'arrowUp' : 'arrowDown',
      color: j.pct > 0 ? cssVar('--lamp-blue') : cssVar('--lamp-red'),
      size: 0.7,
    }));
    if (markers.length > 0) createSeriesMarkers(peS, markers);

    // 第三格：淨值比（依區間上色）；虛線＝基期中位數
    const pbS = chart.addSeries(LineSeries, { color: pbColor(summary.pb ?? 0), lineWidth: 2, priceFormat: x2Fmt, lastValueVisible: false }, 2);
    pbS.setData(rows.map((r, i) => (r.pb === null ? { time: times[i]! } : { time: times[i]!, value: r.pb, color: pbColor(r.pb) })));
    if (summary.pbStats) {
      pbS.createPriceLine({ price: summary.pbStats.median, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }

    // 第四格：股債利差（預估盈餘殖利率 − 日債 10Y）
    const spreadS = chart.addSeries(
      BaselineSeries,
      {
        baseValue: { type: 'price', price: 0 },
        topLineColor: cssVar('--lamp-blue'),
        topFillColor1: hexAlpha(cssVar('--lamp-blue'), 0.25),
        topFillColor2: hexAlpha(cssVar('--lamp-blue'), 0.02),
        bottomLineColor: cssVar('--lamp-red'),
        bottomFillColor1: hexAlpha(cssVar('--lamp-red'), 0.02),
        bottomFillColor2: hexAlpha(cssVar('--lamp-red'), 0.25),
        lineWidth: 2,
        priceFormat: x2Fmt,
        lastValueVisible: false,
      },
      3,
    );
    spreadS.setData(rows.map((r, i) => (r.spread === null ? { time: times[i]! } : { time: times[i]!, value: r.spread })));
    spreadS.createPriceLine({ price: 0, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });

    chart.priceScale('right', 0).applyOptions({ mode: PriceScaleMode.Logarithmic });
    for (const i of [1, 2, 3]) chart.priceScale('right', i).applyOptions({ mode: PriceScaleMode.Normal });

    const wm = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) createTextWatermark(pane, { horzAlign: 'left', vertAlign: 'top', lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }] });
    };
    wm(0, `河流圖｜預估 EPS × ${JP_RIVER_MULTIPLES.join('／')}倍（對數軸）`);
    wm(1, `預估本益比｜點線 加重平均｜虛線 ${BASE_YEAR} 起中位數 ${f1(summary.peStats?.median)}`);
    wm(2, `淨值比（倍）｜虛線 ${BASE_YEAR} 起中位數 ${f2(summary.pbStats?.median)}`);
    wm(3, '股債利差（pp）＝預估盈餘殖利率 − 日債10Y');

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
  }, [loaded, rows, summary, jumps, themeKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = rows.at(-1);
    if (!chart || !last) return;
    const start = rangeStart(last.date, range);
    const apply = () => {
      resetPriceScales(chart);
      resetPaneStretch(chart, PANE_STRETCH);
      if (!start || start <= rows[0]!.date) chart.timeScale().fitContent();
      else chart.timeScale().setVisibleRange({ from: start as Time, to: last.date as Time });
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [chartGen, range, resetKey, rows]);

  const jumpByDate = useMemo(() => new Map(jumps.map((j) => [j.date, j])), [jumps]);
  const jumpOn = (d: string) => jumpByDate.get(d) ?? null;
  const legend = useMemo<JpRow | null>(() => {
    if (!loaded) return null;
    return jpRowAtOrBefore(rows, hoverTime ?? rows.at(-1)!.date);
  }, [loaded, hoverTime, rows]);

  const failed = IDS.flatMap((id) => (files[id]?.status === 'error' ? [`${id}：${(files[id] as { error: string }).error}`] : []));
  const bandChips = JP_RIVER_MULTIPLES.slice(0, -1).map((m, k) => ({
    label: `${m}–${JP_RIVER_MULTIPLES[k + 1]}倍 ${zoneAt(PE_ZONES, m)?.label ?? ''}`,
    color: zoneAt(PE_ZONES, m)?.color ?? '--text-3',
  }));
  const peHit = (b: ValBucket) => !!summary && summary.pe >= b.lo && summary.pe < b.hi;
  const pbHit = (b: ValBucket) => !!summary && summary.pb !== null && summary.pb >= b.lo && summary.pb < b.hi;
  const spHit = (b: ValBucket) => !!summary && summary.spread !== null && summary.spread >= b.lo && summary.spread < b.hi;

  return (
    <section ref={sectionRef} id="sec-jv" className="regime ms tv jv" aria-label="日股估值">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">日股估值（參考）</span>
        </div>
        {summary && <span className="small muted num">日經 225 {summary.date}</span>}
      </div>

      {summary && (
        <>
          <p className="score num tv-state">
            預估本益比 <b>{f1(summary.pe)}倍</b>（預估 EPS {fInt(summary.eps)} 點，年增 {fpct(summary.epsYoy)}）
            {summary.zone && <>→ <b>{summary.zone}</b></>}
            {summary.peStats && (
              <>
                ｜{BASE_YEAR} 起{pctile(summary.peStats.pct)}（中位數 {f1(summary.peStats.median)}倍）
              </>
            )}
            {summary.peW !== null && (
              <span className="muted">
                ｜加重平均 {f1(summary.peW)}倍{summary.peWStats && <>（中位數 {f1(summary.peWStats.median)}）</>}，差 {f1(summary.peGap)}倍＝權值股集中
              </span>
            )}
          </p>
          <p className="score num tv-state">
            河道：
            {summary.position.below !== null && summary.position.above !== null
              ? `${summary.position.below}～${summary.position.above}倍之間`
              : summary.position.above === null
                ? `高於 ${JP_RIVER_MULTIPLES.at(-1)}倍線`
                : `低於 ${JP_RIVER_MULTIPLES[0]}倍線`}
            {summary.position.above !== null && <>，距 {summary.position.above}倍線 {fpct(summary.position.distAbove)}</>}
            {summary.position.below !== null && <>、距 {summary.position.below}倍線 {fpct(summary.position.distBelow)}</>}
            {summary.avg5 !== null && (
              <>
                ｜回到近 5 年均 {f1(summary.avg5)}倍：EPS 需再 <b>{fpct(summary.needGrowth, 0)}</b>，或指數 {fpct(summary.needDrop, 0)}
              </>
            )}
          </p>
          <p className="score num tv-state">
            預估 EPS 近 20 日{' '}
            {summary.epsChg20 !== null && summary.epsChg20 <= -1 ? (
              <b className="warn">⚠️ {fpct(summary.epsChg20)}（下修）</b>
            ) : (
              <b>{fpct(summary.epsChg20)}</b>
            )}
            {summary.lastJump && (
              <span className="muted">
                ｜最近一次整批變動 {dLabel(summary.lastJump.date)} {fpct(summary.lastJump.pct, 0)}
                {Number(summary.lastJump.date.slice(5, 7)) >= 4 && Number(summary.lastJump.date.slice(5, 7)) <= 6 ? '（換年度）' : ''}
              </span>
            )}
          </p>
          <p className="score num tv-state">
            淨值比 <b>{f2(summary.pb)}倍</b>
            {summary.pbZone && <>→ {summary.pbZone}</>}
            {summary.pbStats && (
              <>
                （{BASE_YEAR} 起{pctile(summary.pbStats.pct)}，中位數 {f2(summary.pbStats.median)}倍）
              </>
            )}
            {summary.dy !== null && <>｜預估殖利率 {f2(summary.dy)}%</>}
            ｜股債利差 <b>{fpp(summary.spread)}</b>
            {summary.spread !== null && (
              <>
                （預估盈餘殖利率 {f2(summary.earningsYield)}% − 日債10Y {f2(summary.y10)}%，{monthLabel(summary.y10Month)}）→ {spreadText(summary.spread)}
              </>
            )}
            {summary.usSpread !== null && <span className="muted">｜對美債10Y {fpp(summary.usSpread)}</span>}
          </p>
        </>
      )}

      <PanelNote>
        <p className="small muted ms-rule">
          日經指數官網每日公布的日經 225 本益比用「今期預估利益」（日經自家預估），所以這個面板的本益比本來就是<b>預估本益比</b>，
          不像美股、台股面板的近 12 月實績值。預估 EPS（以指數點計）＝收盤 ÷ 指數基準 PER，每天都有；
          河流圖＝預估 EPS × 11／14／17／20／23／26 倍（{BASE_YEAR} 起月底值：25 分位 16.8、中位數 18.8、75 分位 21.1、90 分位 23.8），指數貼近上緣＝估值高。
          <b>換年度</b>：日本多數公司 3 月結算，本決算公布日翌日起逐家切換到下一年度預估，所以每年 4 月底～5 月中 EPS 會整批上移、本益比跳一格，
          那是分母換了，不是估值變了；中窗格 ▲▼ 標出單日 EPS 變動 ≥{EPS_JUMP_PCT}% 的日子（4～6 月多為換年度，其他月份是大幅修正或成分股更換）。
          <b>價格加權</b>：日經 225 不是市值加權，Fast Retailing、Advantest、軟銀、東京威力科創幾檔占比極高，指數基準本益比會被它們帶著走；
          點線「加重平均」（225 檔總市值 ÷ 預估利益總額，日經新聞刊登值）不受此影響，{BASE_YEAR} 起中位數約 15 倍，兩者差距越大＝估值越集中在少數權值股。
          淨值比用最近決算（含季報）實績每股淨值，不受預估影響；2012 年底 1.1 倍、2020 年 3 月 1.0 倍是兩次谷底。
          股債利差＝預估盈餘殖利率 − 日本 10 年期公債（OECD 月均）；日債長期接近 0，利差幾乎等於盈餘殖利率，2024 年起日債升到 1% 以上才開始有意義。
          2009 年獲利崩跌時本益比曾到 45 倍以上（分母變小），和台股一樣：獲利谷底時本益比偏高、高峰時看起來便宜。
          資料：日經平均プロフィル日次投資指標（2004 年 9 月起）、Yahoo ^N225、FRED IRLTLT01JPM156N 與 DGS10。參考、不計分。
        </p>
      </PanelNote>

      <div className="cp-mas ma-row" role="list" aria-label="河道區間">
        {bandChips.map((c) => (
          <span key={c.label} className="ma-chip" role="listitem" aria-pressed="true" aria-disabled="true">
            <i className="swatch" style={{ background: `var(${c.color})` }} />
            {c.label}
          </span>
        ))}
        <span className="ma-chip" role="listitem" aria-pressed="true" aria-disabled="true">
          ▲▼ 單日預估 EPS 變動 ≥{EPS_JUMP_PCT}%
        </span>
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
        <p className="cp-msg warn">無法載入日經 225 或本益比資料</p>
      ) : (
        <div className="pricechart ms-chart">
          {legend && (
            <div className="legend num cm-legend" aria-live="off">
              <div>
                <span className="muted">{legend.date}</span> 日經 <b>{fInt(legend.price)}</b> ｜ 預估本益比 <b>{f1(legend.pe)}倍</b>
                <span className="muted"> {zoneAt(PE_ZONES, legend.pe)?.label}</span>
                {legend.peW !== null && <span className="muted">（加重 {f1(legend.peW)}）</span>} ｜ 淨值比 <b>{f2(legend.pb)}</b> ｜ 利差{' '}
                <b>{fpp(legend.spread)}</b>
              </div>
              <div className="muted">
                預估 EPS {fInt(legend.eps)}
                {jumpOn(legend.date) && <b className={jumpOn(legend.date)!.pct > 0 ? '' : 'warn'}> {fpct(jumpOn(legend.date)!.pct, 0)}</b>}｜河道 {JP_RIVER_MULTIPLES.map((m) => `${m}倍 ${fInt(legend.eps * m)}`).join('｜')}
              </div>
            </div>
          )}
          <div ref={hostRef} className="chart-host tv-host" />
        </div>
      )}

      {backtest && (
        <div className="table-wrap">
          <table className="bt-table num tv-bt">
            <caption className="small muted">
              估值區間 vs 之後日經報酬（{backtest.start}～{backtest.end} 月底，不含股息；前段／後段以 {backtest.split.slice(0, 4)} 年分）
            </caption>
            <thead>
              <tr>
                <th>區間</th>
                <th className="r">月數</th>
                <th className="r">1年後</th>
                <th className="r">上漲</th>
                <th className="r">前段／後段</th>
                <th className="r">3年年化</th>
              </tr>
            </thead>
            <tbody>
              <tr className="grp">
                <td colSpan={6}>預估本益比（倍，指數基準）</td>
              </tr>
              {backtest.pe.map((b) => (
                <BucketRow key={`pe${b.label}`} b={b} hl={peHit(b)} />
              ))}
              <tr className="grp">
                <td colSpan={6}>淨值比（倍）</td>
              </tr>
              {backtest.pb.map((b) => (
                <BucketRow key={`pb${b.label}`} b={b} hl={pbHit(b)} />
              ))}
              {backtest.spread.length > 0 && (
                <tr className="grp">
                  <td colSpan={6}>股債利差（pp）</td>
                </tr>
              )}
              {backtest.spread.map((b) => (
                <BucketRow key={`sp${b.label}`} b={b} hl={spHit(b)} />
              ))}
              <BucketRow b={backtest.base} />
            </tbody>
          </table>
        </div>
      )}

      <PanelNote label="ⓘ 用法">
        <p className="small muted ms-rule">
          和美股、台股面板一樣：估值決定部位大小，不決定進出場時機。日股的額外重點是<b>預估 EPS 的方向</b>——預估本益比變貴有兩種原因：
          指數漲（看河流圖位置）或預估 EPS 被下修（看「近 20 日」讀數與 ▼ 標記）；後者更危險，因為日經每天更新預估，下修會立刻反映。
          日圓也要一起看：日經與日圓常反向（日圓貶 → 出口股獲利上修 → 指數漲），台幣計價的日股報酬要扣掉匯率；跨市場對照面板可勾日經與 USD/JPY。
          台股連動：日經與加權同時段交易，半導體設備（東京威力科創、Advantest）與台股 AI 供應鏈同一條故事線，日股估值到昂貴區時台股通常也在高檔，可當作第二個溫度計。
        </p>
      </PanelNote>
    </section>
  );
}
