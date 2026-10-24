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
  KR_BASE_START,
  KR_PB_MULTIPLES,
  KR_PE_AXIS,
  epsJumps,
  krMsciSummary,
  krRiverRows,
  krRowAtOrBefore,
  krValuationBacktest,
  perShareSeries,
  spreadText,
  summarizeKr,
  type KrRow,
} from '../shared/krValuation';
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
const IDS = ['kospi', 'kr_pb', 'kr_pe', 'kr_dy', 'kr10y', 'us10y', 'kr_fwd_pe', 'kr_msci_pe', 'kr_msci_pb'];
const PB_ZONES = INDICATOR_MAP['kr_pb']!.zones ?? [];
const PE_ZONES = INDICATOR_MAP['kr_pe']!.zones ?? [];
const FWD_ZONES = INDICATOR_MAP['kr_fwd_pe']!.zones ?? [];
const BASE_YEAR = KR_BASE_START.slice(0, 4);

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

export function KrValuationPanel({ version, themeKey }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const near = useNearViewport(sectionRef);
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('kv-range', ['3M', '6M', '1Y', '5Y', '10Y', 'ALL'], '10Y'));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const files = useSeriesMap(near ? IDS : [], version);
  const data = useMemo(() => {
    const ready = (id: string): Point[] => (files[id]?.status === 'ready' ? closesOf(files[id]!.data.data) : []);
    const kospi = ready('kospi');
    const pbMonthly = ready('kr_pb');
    const peMonthly = ready('kr_pe');
    const kr10y = ready('kr10y');
    const bv = perShareSeries(pbMonthly, kospi);
    const eps = perShareSeries(peMonthly, kospi);
    const rows = krRiverRows(kospi, bv, eps, kr10y);
    return {
      rows,
      kospi,
      pbMonthly,
      peMonthly,
      dyMonthly: ready('kr_dy'),
      kr10y,
      us10y: ready('us10y'),
      bv,
      eps,
      fwd: ready('kr_fwd_pe'),
      msciPe: ready('kr_msci_pe'),
      msciPb: ready('kr_msci_pb'),
    };
  }, [files]);
  const { rows } = data;
  const summary = useMemo(
    () => summarizeKr(rows, data.pbMonthly, data.peMonthly, data.dyMonthly, data.bv, data.eps, data.kr10y, data.us10y, PB_ZONES, PE_ZONES),
    [rows, data],
  );
  const backtest = useMemo(() => krValuationBacktest(data.peMonthly, data.pbMonthly, data.kospi, data.kr10y), [data]);
  const msci = useMemo(() => krMsciSummary(data.fwd, data.msciPe, data.msciPb, rows.at(-1)?.date ?? '2000-01-01'), [data, rows]);
  const jumps = useMemo(() => epsJumps(data.eps), [data.eps]);

  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('kv-range', r);
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
    const pbColor = (v: number) => cssVar(zoneAt(PB_ZONES, v)?.color ?? '--text-1');
    const peColor = (v: number) => cssVar(zoneAt(PE_ZONES, v)?.color ?? '--text-1');
    const alpha = Math.min(0.35, (Number.parseFloat(cssVar('--lamp-band-alpha')) || 0.1) * 1.6);
    /** 月底資料日 → 圖上有的交易日（所有序列時間點相同，色帶才能用列索引畫） */
    const snap = (d: string) => {
      const row = krRowAtOrBefore(rows, d);
      return row && row.date >= rows[0]!.date ? row.date : null;
    };
    const dots = (pts: readonly Point[]) => {
      const m = new Map<string, number>();
      for (const [d, v] of pts) {
        const t = snap(d);
        if (t) m.set(t, v);
      }
      return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => ({ time: d as Time, value: v }));
    };
    const dotSeries = (pane: number, fmt: { type: 'price'; precision: number; minMove: number }, extra: object = {}) =>
      chart.addSeries(
        LineSeries,
        {
          color: cssVar('--accent'),
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          pointMarkersVisible: true,
          pointMarkersRadius: 3,
          priceFormat: fmt,
          lastValueVisible: false,
          priceLineVisible: false,
          ...extra,
        },
        pane,
      );

    // 上窗格：KOSPI（對數軸）＋ 每股淨值 × 6 條倍數線 ＋ 色帶（依淨值比區間上色）
    const priceS = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: ptFmt, lastValueVisible: false }, 0);
    priceS.setData(rows.map((r, i) => ({ time: times[i]!, value: r.price })));
    const bandValues = KR_PB_MULTIPLES.map((m) => rows.map((r) => r.bv * m));
    for (const vals of bandValues) {
      const s = chart.addSeries(
        LineSeries,
        { color: textColor, lineWidth: 1, priceFormat: ptFmt, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
        0,
      );
      s.setData(vals.map((v, i) => ({ time: times[i]!, value: v })));
    }
    const bands: RiverBand[] = [];
    for (let k = 0; k + 1 < KR_PB_MULTIPLES.length; k++) {
      bands.push({ lower: bandValues[k]!, upper: bandValues[k + 1]!, color: hexAlpha(pbColor(KR_PB_MULTIPLES[k]!), alpha) });
    }
    priceS.attachPrimitive(new RiverBands(bands));

    // 第二格：淨值比（依區間上色）；虛線＝基期中位數；藍點＝MSCI 韓國淨值比（月）
    const pbS = chart.addSeries(LineSeries, { color: pbColor(summary.pb), lineWidth: 2, priceFormat: x2Fmt, lastValueVisible: false }, 1);
    pbS.setData(rows.map((r, i) => ({ time: times[i]!, value: r.pb, color: pbColor(r.pb) })));
    if (summary.pbStats) {
      pbS.createPriceLine({ price: summary.pbStats.median, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }
    const msciPbDots = dots(data.msciPb);
    if (msciPbDots.length > 0) dotSeries(1, x2Fmt).setData(msciPbDots);

    // 第三格：本益比（依區間上色、Y 軸鎖 KR_PE_AXIS）；藍點＝MSCI 預估本益比（月）；▲▼＝年報／半年報併入（EPS 整批變動）
    const clampPe = () => ({ priceRange: { minValue: KR_PE_AXIS[0], maxValue: KR_PE_AXIS[1] } });
    const peS = chart.addSeries(
      LineSeries,
      { color: peColor(summary.pe ?? 0), lineWidth: 2, priceFormat: x1Fmt, lastValueVisible: false, autoscaleInfoProvider: clampPe },
      2,
    );
    peS.setData(rows.map((r, i) => (r.pe === null ? { time: times[i]! } : { time: times[i]!, value: r.pe, color: peColor(r.pe) })));
    if (summary.peStats) {
      peS.createPriceLine({ price: summary.peStats.median, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }
    const fwdDots = dots(data.fwd);
    if (fwdDots.length > 0) dotSeries(2, x1Fmt, { autoscaleInfoProvider: clampPe }).setData(fwdDots);
    const markers: SeriesMarker<Time>[] = [];
    for (const j of jumps) {
      const t = snap(j.date);
      if (!t) continue;
      markers.push({
        time: t as Time,
        position: j.pct > 0 ? 'belowBar' : 'aboveBar',
        shape: j.pct > 0 ? 'arrowUp' : 'arrowDown',
        color: j.pct > 0 ? cssVar('--lamp-blue') : cssVar('--lamp-red'),
        size: 0.7,
      });
    }
    if (markers.length > 0) createSeriesMarkers(peS, markers);

    // 第四格：股債利差（盈餘殖利率 − 韓債 10Y）
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
    wm(0, `淨值比河流圖｜每股淨值 × ${KR_PB_MULTIPLES.join('／')}倍（對數軸）`);
    wm(1, `淨值比（倍）｜虛線 ${BASE_YEAR} 起中位數 ${f2(summary.pbStats?.median)}｜藍點 MSCI 韓國`);
    wm(2, `本益比（倍，最近年度實績）｜虛線中位數 ${f1(summary.peStats?.median)}｜藍點 MSCI 預估本益比｜軸 ${KR_PE_AXIS[0]}～${KR_PE_AXIS[1]} 倍`);
    wm(3, '股債利差（pp）＝盈餘殖利率 − 韓債10Y');

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
  }, [loaded, rows, summary, data.fwd, data.msciPb, jumps, themeKey]);

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

  const legend = useMemo<KrRow | null>(() => {
    if (!loaded) return null;
    return krRowAtOrBefore(rows, hoverTime ?? rows.at(-1)!.date);
  }, [loaded, hoverTime, rows]);

  const failed = IDS.flatMap((id) => (files[id]?.status === 'error' ? [`${id}：${(files[id] as { error: string }).error}`] : []));
  const bandChips = KR_PB_MULTIPLES.slice(0, -1).map((m, k) => ({
    label: `${m}–${KR_PB_MULTIPLES[k + 1]}倍 ${zoneAt(PB_ZONES, m)?.label ?? ''}`,
    color: zoneAt(PB_ZONES, m)?.color ?? '--text-3',
  }));
  const pbHit = (b: ValBucket) => !!summary && summary.pb >= b.lo && summary.pb < b.hi;
  const peHit = (b: ValBucket) => !!summary && summary.pe !== null && summary.pe >= b.lo && summary.pe < b.hi;
  const spHit = (b: ValBucket) => !!summary && summary.spread !== null && summary.spread >= b.lo && summary.spread < b.hi;
  const fwdZone = msci ? zoneAt(FWD_ZONES, msci.fwdPe) : undefined;

  return (
    <section ref={sectionRef} id="sec-kv" className="regime ms tv kv" aria-label="韓股估值">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">韓股估值（參考）</span>
        </div>
        {summary && (
          <span className="small muted num">
            KOSPI {summary.date}｜月底值 {summary.dataMonth}
          </span>
        )}
      </div>

      {summary && (
        <>
          <p className="score num tv-state">
            淨值比 <b>{f2(summary.pb)}倍</b>（每股淨值 {fInt(summary.bv)} 點，年增 {fpct(summary.bvYoy)}）
            {summary.pbZone && <>→ <b>{summary.pbZone}</b></>}
            {summary.pbStats && (
              <>
                ｜{BASE_YEAR} 起{pctile(summary.pbStats.pct)}（中位數 {f2(summary.pbStats.median)}倍）
              </>
            )}
          </p>
          <p className="score num tv-state">
            河道：
            {summary.position.below !== null && summary.position.above !== null
              ? `${summary.position.below}～${summary.position.above}倍之間`
              : summary.position.above === null
                ? `高於 ${KR_PB_MULTIPLES.at(-1)}倍線`
                : `低於 ${KR_PB_MULTIPLES[0]}倍線`}
            {summary.position.above !== null && <>，距 {summary.position.above}倍線 {fpct(summary.position.distAbove)}</>}
            {summary.position.below !== null && <>、距 {summary.position.below}倍線 {fpct(summary.position.distBelow)}</>}
            {summary.pbAvg5 !== null && (
              <>
                ｜回到近 5 年均 {f2(summary.pbAvg5)}倍：淨值需再 <b>{fpct(summary.needGrowth, 0)}</b>，或指數 {fpct(summary.needDrop, 0)}
              </>
            )}
          </p>
          <p className="score num tv-state">
            本益比 <b>{f1(summary.pe)}倍</b>
            {summary.eps !== null && <>（最近年度 EPS {fInt(summary.eps)} 點，年增 {fpct(summary.epsYoy)}）</>}
            {summary.peZone && <>→ {summary.peZone}</>}
            {summary.peStats && (
              <>
                （{BASE_YEAR} 起{pctile(summary.peStats.pct)}，中位數 {f1(summary.peStats.median)}倍）
              </>
            )}
            {summary.lastJump && (
              <span className="muted">
                ｜最近換財報 {ymLabel(summary.lastJump.date)} EPS {fpct(summary.lastJump.pct, 0)}
              </span>
            )}
            {summary.dy !== null && <>｜殖利率 {f2(summary.dy)}%</>}
            ｜股債利差 <b>{fpp(summary.spread)}</b>
            {summary.spread !== null && (
              <>
                （盈餘殖利率 {f2(summary.earningsYield)}% − 韓債10Y {f2(summary.y10)}%，{monthLabel(summary.y10Month)}）→ {spreadText(summary.spread)}
              </>
            )}
            {summary.usSpread !== null && <span className="muted">｜對美債10Y {fpp(summary.usSpread)}</span>}
          </p>
          {msci && (
            <p className="score num tv-state tv-fwd">
              預估本益比 <b>{f2(msci.fwdPe)}倍</b>
              {fwdZone && <>→ <b>{fwdZone.label}</b></>}
              （MSCI 韓國 {ymLabel(msci.asOf)} 底
              {msci.impliedGrowth !== null && <>；近 12 月 {f2(msci.pe)}倍 → 隱含未來 12 月 EPS 成長 <b>{fpct(msci.impliedGrowth, 0)}</b></>}）
              {msci.prevFwdPe !== null && msci.prevAsOf && (
                <>
                  ｜比 {ymLabel(msci.prevAsOf)} 底 {f2(msci.prevFwdPe)}倍 {fpct((msci.fwdPe / msci.prevFwdPe - 1) * 100, 0)}
                </>
              )}
              {msci.pbv !== null && <>｜MSCI 淨值比 {f2(msci.pbv)}倍（KRX 全市場 {f2(summary.pb)}）</>}
              <span className="muted">
                ｜{msci.n} 期：最低 {f2(msci.min[1])}（{ymLabel(msci.min[0])}）、中位數 {f2(msci.median)}、最高 {f2(msci.max[1])}（{ymLabel(msci.max[0])}）
              </span>
              {msci.stale && <b className="warn">（超過 2 個月未更新）</b>}
            </p>
          )}
        </>
      )}

      <PanelNote>
        <p className="small muted ms-rule">
          韓股的主角是<b>淨值比</b>，本益比只是配角：KOSPI 由三星電子、SK 海力士等記憶體循環股主導，獲利高峰時本益比最低、獲利崩跌時本益比飆高
          （2009 年、2020 年底、2026 年都在 24～32 倍），單看本益比會給反向訊號；淨值比的分母是帳面淨值，不受單年獲利起伏影響，韓國在地「PBR 1 倍」是著名的底部參考
          （2008 年 11 月 0.90、2020 年 3 月 0.71、2022 年 9 月 0.83）。河流圖＝每股淨值（以指數點計：月底收盤 ÷ KRX 淨值比）× 0.7／0.9／1.1／1.3／1.6／2.0 倍，
          指數貼近上緣＝估值高；{BASE_YEAR} 起月底值 25 分位 0.98、中位數 1.13、75 分位 1.28、90 分位 1.46，2025 年以前最高 1.90（2007 年 10 月），2026 年 2 倍以上是史上第一次。
          <b>本益比口徑</b>：KRX 用「最近一期年度（含半年報）實績純益」，不是近四季滾動——年報（4 月）、半年報（9 月）併入時整批換分母，本益比會跳一格（2026 年 9 月 18.6 → 11.4 倍），
          那是分母換了，不是估值變了；第三格 ▲▼ 標出單月 EPS 變動 ≥{EPS_JUMP_PCT}% 的月份。本益比窗格 Y 軸固定 {KR_PE_AXIS[0]}～{KR_PE_AXIS[1]} 倍，超過的截在頂端，游標移過去圖例列仍顯示真實值。
          <b>預估本益比</b>＝MSCI 韓國指數（約 90 檔大中型股）÷ 分析師未來 12 個月預估 EPS（MSCI 官方 factsheet，月底值、每月初更新）；與 MSCI 近 12 月本益比的差距＝市場押注的獲利成長。
          循環股在獲利高峰時預估本益比極低（2026 年 9 月底 4.95 倍）是常態，不代表便宜——記憶體價格一反轉，預估 EPS 整批下修，預估本益比會瞬間變貴。
          股債利差＝盈餘殖利率 − 韓國 10 年期公債（月均）；2004–2011 韓債 4～6%，之後 1.5～4%，2026 年又回到 4% 以上。
          資料：韓國銀行 ECOS（KRX 本益比、殖利率、韓債 10Y，2004 年 1 月起）、KOSIS 國家統計入口網（KRX 淨值比）、MSCI 韓國指數 factsheet、Yahoo ^KS11、FRED DGS10。參考、不計分。
        </p>
      </PanelNote>

      <div className="cp-mas ma-row" role="list" aria-label="河道區間">
        {bandChips.map((c) => (
          <span key={c.label} className="ma-chip" role="listitem" aria-pressed="true" aria-disabled="true">
            <i className="swatch" style={{ background: `var(${c.color})` }} />
            {c.label}
          </span>
        ))}
        {msci && (
          <span className="ma-chip" role="listitem" aria-pressed="true" aria-disabled="true">
            <i className="swatch tv-dot" style={{ background: 'var(--accent)' }} />
            MSCI 韓國（月）
          </span>
        )}
        <span className="ma-chip" role="listitem" aria-pressed="true" aria-disabled="true">
          ▲▼ 換財報：單月 EPS 變動 ≥{EPS_JUMP_PCT}%
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
        <p className="cp-msg warn">無法載入 KOSPI 或淨值比資料</p>
      ) : (
        <div className="pricechart ms-chart">
          {legend && (
            <div className="legend num cm-legend" aria-live="off">
              <div>
                <span className="muted">{legend.date}</span> KOSPI <b>{fInt(legend.price)}</b> ｜ 淨值比 <b>{f2(legend.pb)}倍</b>
                <span className="muted"> {zoneAt(PB_ZONES, legend.pb)?.label}</span> ｜ 本益比 <b>{f1(legend.pe)}倍</b>
                <span className="muted"> {legend.pe !== null && zoneAt(PE_ZONES, legend.pe)?.label}</span> ｜ 利差 <b>{fpp(legend.spread)}</b>
              </div>
              <div className="muted">
                每股淨值 {fInt(legend.bv)}｜河道 {KR_PB_MULTIPLES.map((m) => `${m}倍 ${fInt(legend.bv * m)}`).join('｜')}
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
              估值區間 vs 之後 KOSPI 報酬（{backtest.start}～{backtest.end} 月底，公布後起算、不含股息；前段／後段以 {backtest.split.slice(0, 4)} 年分）
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
                <td colSpan={6}>淨值比（倍）</td>
              </tr>
              {backtest.pb.map((b) => (
                <BucketRow key={`pb${b.label}`} b={b} hl={pbHit(b)} />
              ))}
              <tr className="grp">
                <td colSpan={6}>本益比（倍，最近年度實績）</td>
              </tr>
              {backtest.pe.map((b) => (
                <BucketRow key={`pe${b.label}`} b={b} hl={peHit(b)} />
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
          和其他估值面板一樣：估值決定部位大小，不決定進出場時機。韓股的額外重點是<b>循環位置</b>：淨值比在歷史高檔、本益比與預估本益比卻很低，
          就是典型的獲利高峰組合（2007 年、2021 年初都出現過，之後一年 KOSPI 分別 −40%、−25%）；真正要盯的是記憶體合約價與預估 EPS 是否開始下修，
          預估 EPS 一轉向，預估本益比會從 5 倍跳回 10 倍以上。台股連動：KOSPI 與加權同時段交易、同一條 AI／記憶體故事線（華邦電、南亞科跟著海力士走），
          韓股估值到昂貴區時台股記憶體股通常也在高檔；跨市場對照面板可勾 KOSPI 看兩邊的背離。韓元也要一起看（韓元貶 → 出口股獲利上修 → KOSPI 漲），台幣計價的韓股報酬要扣匯率。
        </p>
      </PanelNote>
    </section>
  );
}
