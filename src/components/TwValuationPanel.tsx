import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createTextWatermark,
  type IChartApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMsciTw, useSeriesMap } from '../hooks/useData';
import { CHART_INTERACTION, attachTimeAxis, resetPaneStretch, resetPriceScales, TIME_AXIS } from '../lib/chartInteraction';
import { RiverBands, type RiverBand } from '../lib/riverBands';
import { loadPref, savePref } from '../lib/storage';
import { cssVar, pctCell } from '../lib/stressFormat';
import { hexAlpha } from '../lib/zoneBands';
import { INDICATOR_MAP, zoneAt } from '../shared/indicators';
import { msciSummary } from '../shared/msciTw';
import { rangeStart, type Point, type RangeKey } from '../shared/timeseries';
import {
  TW_BASE_START,
  TW_RIVER_MULTIPLES,
  perShareSeries,
  spreadText,
  summarizeTw,
  twRiverRows,
  twRowAtOrBefore,
  valuationBacktest,
  type TwRow,
  type ValBucket,
} from '../shared/twValuation';
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
const IDS = ['taiex', 'tw_pe', 'tw_pb', 'tw_dy', 'tw10y', 'us10y', 'usdtwd'];
const PE_ZONES = INDICATOR_MAP['tw_pe']!.zones ?? [];
const PB_ZONES = INDICATOR_MAP['tw_pb']!.zones ?? [];
const FWD_ZONES = INDICATOR_MAP['tw_fwd_pe']!.zones ?? [];
const BASE_YEAR = TW_BASE_START.slice(0, 4);

const fin = (v: number | null | undefined) => v !== null && v !== undefined && Number.isFinite(v);
const f1 = (v: number | null | undefined) => (fin(v) ? v!.toFixed(1) : '—');
const f2 = (v: number | null | undefined) => (fin(v) ? v!.toFixed(2) : '—');
const fInt = (v: number | null | undefined) => (fin(v) ? Math.round(v!).toLocaleString('en-US') : '—');
const fpct = (v: number | null | undefined, d = 1) => (fin(v) ? `${v! > 0 ? '+' : ''}${v!.toFixed(d)}%` : '—');
const fpp = (v: number | null | undefined) => (fin(v) ? `${v! > 0 ? '+' : ''}${v!.toFixed(2)}pp` : '—');
const pctile = (v: number | null | undefined) => (fin(v) ? `第 ${Math.round(v!)} 百分位` : '—');
const monthLabel = (ym: string | null) => (ym ? `${Number(ym.slice(5, 7))}月` : '');
/** 2026-09-30 → 2026/9 */
const ymLabel = (d: string) => `${d.slice(0, 4)}/${Number(d.slice(5, 7))}`;

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

/** 整數百分比（手機上「前段／後段」一格放得下） */
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

export function TwValuationPanel({ version, themeKey }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const near = useNearViewport(sectionRef);
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('tv-range', ['3M', '6M', '1Y', '5Y', '10Y', 'ALL'], '10Y'));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const files = useSeriesMap(near ? IDS : [], version);
  const msci = useMsciTw(near ? version : null);
  const data = useMemo(() => {
    const ready = (id: string): Point[] => (files[id]?.status === 'ready' ? closesOf(files[id]!.data.data) : []);
    const taiex = ready('taiex');
    const peMonthly = ready('tw_pe');
    const pbMonthly = ready('tw_pb');
    const tw10y = ready('tw10y');
    const eps = perShareSeries(peMonthly, taiex);
    const bv = perShareSeries(pbMonthly, taiex);
    const rows = twRiverRows(taiex, eps, bv, tw10y);
    return { rows, taiex, peMonthly, pbMonthly, dyMonthly: ready('tw_dy'), tw10y, us10y: ready('us10y'), usdTwd: ready('usdtwd'), eps };
  }, [files]);
  const { rows } = data;
  const summary = useMemo(
    () => summarizeTw(rows, data.peMonthly, data.pbMonthly, data.dyMonthly, data.eps, data.tw10y, data.us10y, PE_ZONES, PB_ZONES),
    [rows, data],
  );
  const backtest = useMemo(() => valuationBacktest(data.peMonthly, data.pbMonthly, data.taiex, data.tw10y), [data]);
  // MSCI 台灣預估本益比（月）：讀數＋本益比窗格的點
  const fwd = useMemo(() => msciSummary(msci, data.usdTwd, rows.at(-1)?.date ?? '2000-01-01'), [msci, data.usdTwd, rows]);

  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('tv-range', r);
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

    // 上窗格：加權（對數軸）＋ 6 條倍數線 ＋ 色帶
    const priceS = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: ptFmt, lastValueVisible: false }, 0);
    priceS.setData(rows.map((r, i) => ({ time: times[i]!, value: r.price })));
    const bandValues = TW_RIVER_MULTIPLES.map((m) => rows.map((r) => r.eps * m));
    for (const vals of bandValues) {
      const s = chart.addSeries(
        LineSeries,
        { color: textColor, lineWidth: 1, priceFormat: ptFmt, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
        0,
      );
      s.setData(vals.map((v, i) => ({ time: times[i]!, value: v })));
    }
    const bands: RiverBand[] = [];
    for (let k = 0; k + 1 < TW_RIVER_MULTIPLES.length; k++) {
      bands.push({ lower: bandValues[k]!, upper: bandValues[k + 1]!, color: hexAlpha(peColor(TW_RIVER_MULTIPLES[k]!), alpha) });
    }
    priceS.attachPrimitive(new RiverBands(bands));

    // 第二格：本益比（依區間上色）；虛線＝基期中位數
    const peS = chart.addSeries(LineSeries, { color: peColor(summary.pe), lineWidth: 2, priceFormat: x1Fmt, lastValueVisible: false }, 1);
    peS.setData(rows.map((r, i) => ({ time: times[i]!, value: r.pe, color: peColor(r.pe) })));
    if (summary.peStats) {
      peS.createPriceLine({ price: summary.peStats.median, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }
    // 預估本益比（MSCI 每月一點）：日期貼到 ≤ 資料日的交易日（所有序列時間點相同，色帶才能用列索引畫）
    const fwdPts = new Map<string, number>();
    for (const r of msci?.records ?? []) {
      const row = twRowAtOrBefore(rows, r.asOf);
      if (row && row.date >= rows[0]!.date) fwdPts.set(row.date, r.fwdPe);
    }
    if (fwdPts.size > 0) {
      const fwdS = chart.addSeries(
        LineSeries,
        {
          color: cssVar('--accent'),
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          pointMarkersVisible: true,
          pointMarkersRadius: 3,
          priceFormat: x1Fmt,
          lastValueVisible: false,
          priceLineVisible: false,
        },
        1,
      );
      fwdS.setData([...fwdPts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => ({ time: d as Time, value: v })));
    }

    // 第三格：淨值比（依區間上色）；虛線＝基期中位數
    const pbS = chart.addSeries(LineSeries, { color: pbColor(summary.pb ?? 0), lineWidth: 2, priceFormat: x2Fmt, lastValueVisible: false }, 2);
    pbS.setData(rows.map((r, i) => (r.pb === null ? { time: times[i]! } : { time: times[i]!, value: r.pb, color: pbColor(r.pb) })));
    if (summary.pbStats) {
      pbS.createPriceLine({ price: summary.pbStats.median, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }

    // 第四格：股債利差（盈餘殖利率 − 台債 10Y），0 以上股票較划算
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

    // 對數軸只給河流圖那一格；要在所有窗格都建好之後才設（priceScale('right', i).applyOptions 會改圖表層級預設）
    chart.priceScale('right', 0).applyOptions({ mode: PriceScaleMode.Logarithmic });
    for (const i of [1, 2, 3]) chart.priceScale('right', i).applyOptions({ mode: PriceScaleMode.Normal });

    const wm = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) createTextWatermark(pane, { horzAlign: 'left', vertAlign: 'top', lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }] });
    };
    wm(0, `河流圖｜近四季 EPS × ${TW_RIVER_MULTIPLES.join('／')}倍（對數軸）`);
    wm(1, `本益比（倍）｜虛線 ${BASE_YEAR} 起中位數 ${f1(summary.peStats?.median)}`);
    wm(2, `淨值比（倍）｜虛線 ${BASE_YEAR} 起中位數 ${f2(summary.pbStats?.median)}`);
    wm(3, '股債利差（pp）＝盈餘殖利率 − 台債10Y');

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
  }, [loaded, rows, summary, msci, themeKey]);

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

  const legend = useMemo<TwRow | null>(() => {
    if (!loaded) return null;
    return twRowAtOrBefore(rows, hoverTime ?? rows.at(-1)!.date);
  }, [loaded, hoverTime, rows]);

  const failed = IDS.flatMap((id) => (files[id]?.status === 'error' ? [`${id}：${(files[id] as { error: string }).error}`] : []));
  const bandChips = TW_RIVER_MULTIPLES.slice(0, -1).map((m, k) => ({
    label: `${m}–${TW_RIVER_MULTIPLES[k + 1]}倍 ${zoneAt(PE_ZONES, m)?.label ?? ''}`,
    color: zoneAt(PE_ZONES, m)?.color ?? '--text-3',
  }));
  const peHit = (b: ValBucket) => !!summary && summary.pe >= b.lo && summary.pe < b.hi;
  const pbHit = (b: ValBucket) => !!summary && summary.pb !== null && summary.pb >= b.lo && summary.pb < b.hi;
  const spHit = (b: ValBucket) => !!summary && summary.spread !== null && summary.spread >= b.lo && summary.spread < b.hi;

  return (
    <section ref={sectionRef} id="sec-tv" className="regime ms tv" aria-label="台股估值">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">台股估值（參考）</span>
        </div>
        {summary && (
          <span className="small muted num">
            加權 {summary.date}｜月報 {summary.epsMonth}
          </span>
        )}
      </div>

      {summary && (
        <>
          <p className="score num tv-state">
            本益比 <b>{f1(summary.pe)}倍</b>（近四季 EPS {fInt(summary.eps)} 點，年增 {fpct(summary.epsYoy)}）
            {summary.zone && <>→ <b>{summary.zone}</b></>}
            {summary.peStats && (
              <>
                ｜{BASE_YEAR} 起{pctile(summary.peStats.pct)}（中位數 {f1(summary.peStats.median)}倍）
              </>
            )}
          </p>
          <p className="score num tv-state">
            河道：
            {summary.position.below !== null && summary.position.above !== null
              ? `${summary.position.below}～${summary.position.above}倍之間`
              : summary.position.above === null
                ? `高於 ${TW_RIVER_MULTIPLES.at(-1)}倍線`
                : `低於 ${TW_RIVER_MULTIPLES[0]}倍線`}
            {summary.position.above !== null && <>，距 {summary.position.above}倍線 {fpct(summary.position.distAbove)}</>}
            {summary.position.below !== null && <>、距 {summary.position.below}倍線 {fpct(summary.position.distBelow)}</>}
            {summary.avg5 !== null && (
              <>
                ｜回到近 5 年均 {f1(summary.avg5)}倍：EPS 需再 <b>{fpct(summary.needGrowth, 0)}</b>，或指數 {fpct(summary.needDrop, 0)}
              </>
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
            {summary.dy !== null && <>｜殖利率 {f2(summary.dy)}%</>}
            ｜股債利差 <b>{fpp(summary.spread)}</b>
            {summary.spread !== null && (
              <>
                （盈餘殖利率 {f2(summary.earningsYield)}% − 台債10Y {f2(summary.y10)}%，{monthLabel(summary.y10Month)}）→ {spreadText(summary.spread)}
              </>
            )}
            {summary.usSpread !== null && <span className="muted">｜對美債10Y {fpp(summary.usSpread)}</span>}
          </p>
          {fwd && (
            <p className="score num tv-state tv-fwd">
              預估本益比 <b>{f2(fwd.latest.fwdPe)}倍</b>
              {zoneAt(FWD_ZONES, fwd.latest.fwdPe) && <>→ <b>{zoneAt(FWD_ZONES, fwd.latest.fwdPe)!.label}</b></>}
              （MSCI 台灣 {ymLabel(fwd.latest.asOf)} 底
              {fwd.impliedGrowth !== null && <>；近 12 月 {f2(fwd.latest.pe)}倍 → 隱含 EPS 成長 {fpct(fwd.impliedGrowth, 0)}</>}）
              {fwd.premium !== null && <>｜對全球 {f2(fwd.latest.acwiFwdPe)}倍 {fpct(fwd.premium, 0)}</>}
              {fwd.epsChg !== null && fwd.prevAsOf && (
                fwd.cut ? (
                  <b className="warn">
                    {' '}⚠️ 未來 12 月 EPS 預估比 {ymLabel(fwd.prevAsOf)} 底 {fpct(fwd.epsChg)}（下修）
                  </b>
                ) : (
                  <>
                    ｜未來 12 月 EPS 預估比 {ymLabel(fwd.prevAsOf)} 底 <b>{fpct(fwd.epsChg)}</b>
                    {fwd.epsMonths !== null && fwd.epsMonths > 1 && <span className="muted">（{fwd.epsMonths} 個月）</span>}
                  </>
                )
              )}
              <span className="muted">
                ｜2021 起 {fwd.n} 期：最低 {f2(fwd.min.fwdPe)}（{ymLabel(fwd.min.asOf)}）、中位數 {f2(fwd.median)}、最高 {f2(fwd.max.fwdPe)}（{ymLabel(fwd.max.asOf)}）
              </span>
              {fwd.stale && <b className="warn">（超過 2 個月未更新）</b>}
            </p>
          )}
        </>
      )}

      <PanelNote>
        <p className="small muted ms-rule">
          河流圖＝近四季 EPS（以指數點計：月底收盤 ÷ 證交所大盤本益比）× 11／15／19／23／27／31 倍，倍數線與美股估值面板相同、多一條 11 倍（2009、2022 年谷底約 9 倍）。
          指數貼近上緣＝估值高；河道隨 EPS 上升而上移，所以指數橫盤也能從貴變合理（2026 年 6 月底與 8 月底都在 46,100 點附近，Q2 財報後本益比從 31.8 倍降到 25.6 倍）。
          台股獲利循環大：獲利谷底時本益比會飆高（2009 年底 110 倍以上、2010 年 1 月 125 倍），高峰時反而看起來便宜，所以加看淨值比（不受單季獲利起伏影響），
          但 AI 循環把權值股 ROE 拉高，淨值比的天花板也跟著上移。股債利差＝盈餘殖利率 − 台灣 10 年期公債（月均）；外資比較的是美債，另列在讀數末。
          百分位與中位數以 {BASE_YEAR} 年起為基期（證交所自 2005 年起總市值改以發行股數計算）。
          預估本益比＝MSCI 台灣指數（74 檔大中型股，台積電約占 54%）÷ 分析師未來 12 個月預估 EPS（MSCI 官方 factsheet，月底值、每月初更新）；
          中窗格藍點即是。與近 12 月本益比的差距＝市場押注的成長。「未來 12 月 EPS 預估」由 factsheet 的美元含息報酬、殖利率與美元兌台幣推算（台幣計）：
          這個窗格每月往後滾一個月，成長期每月本來就會上升，所以持平或下降都標 ⚠️ 下修。口徑與加權指數不同（彭博的加權預估本益比通常較低），只跟自己的歷史比；
          2021 起只有 Wayback 存檔的 14 個月份，之後每月累積。
          資料：證交所「證券市場統計概要」月報（1999 年起，月底值、每月第 7 個營業日左右公布）、MSCI 台灣指數 factsheet、Yahoo ^TWII 與 TWD=X、央行資本市場利率、FRED DGS10。參考、不計分。
        </p>
      </PanelNote>

      <div className="cp-mas ma-row" role="list" aria-label="河道區間">
        {bandChips.map((c) => (
          <span key={c.label} className="ma-chip" role="listitem" aria-pressed="true" aria-disabled="true">
            <i className="swatch" style={{ background: `var(${c.color})` }} />
            {c.label}
          </span>
        ))}
        {fwd && (
          <span className="ma-chip" role="listitem" aria-pressed="true" aria-disabled="true">
            <i className="swatch tv-dot" style={{ background: 'var(--accent)' }} />
            預估本益比（MSCI 月）
          </span>
        )}
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
        <p className="cp-msg warn">無法載入加權指數或本益比資料</p>
      ) : (
        <div className="pricechart ms-chart">
          {legend && (
            <div className="legend num cm-legend" aria-live="off">
              <div>
                <span className="muted">{legend.date}</span> 加權 <b>{fInt(legend.price)}</b> ｜ 本益比 <b>{f1(legend.pe)}倍</b>
                <span className="muted"> {zoneAt(PE_ZONES, legend.pe)?.label}</span> ｜ 淨值比 <b>{f2(legend.pb)}</b> ｜ 利差 <b>{fpp(legend.spread)}</b>
              </div>
              <div className="muted">
                河道 {TW_RIVER_MULTIPLES.map((m) => `${m}倍 ${fInt(legend.eps * m)}`).join('｜')}
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
              估值區間 vs 之後加權報酬（{backtest.start}～{backtest.end} 月底，公布後起算、不含股息；前段／後段以 {backtest.split.slice(0, 4)} 年分）
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
                <td colSpan={6}>本益比（倍）</td>
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
          估值決定部位大小，不決定進出場時機：同一個區間前後兩段的一年報酬常常方向相反（例如淨值比 2.0–2.5），高估值也可能再漲一年。
          貴的時候：不加槓桿、不追高加碼，新資金等融資斷頭、漲跌停「投降」這類壓力訊號再分批；進出場仍用均線停損與籌碼。
          真正要盯的是獲利：EPS 年增轉弱、出口與外銷訂單連續減速，「貴但有成長撐」就會變成「貴」。
        </p>
      </PanelNote>
    </section>
  );
}
