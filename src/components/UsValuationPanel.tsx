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
import { useSeriesMap } from '../hooks/useData';
import { CHART_INTERACTION, attachTimeAxis, resetPaneStretch, resetPriceScales, TIME_AXIS } from '../lib/chartInteraction';
import { RiverBands, type RiverBand } from '../lib/riverBands';
import { loadPref, savePref } from '../lib/storage';
import { cssVar } from '../lib/stressFormat';
import { hexAlpha } from '../lib/zoneBands';
import { INDICATOR_MAP, zoneAt } from '../shared/indicators';
import { rangeStart, type Point, type RangeKey } from '../shared/timeseries';
import {
  PE_BASE_START,
  RIVER_MULTIPLES,
  closesOf,
  epsSeries,
  riverRows,
  rowAtOrBefore,
  spreadText,
  summarize,
  type RiverRow,
} from '../shared/usValuation';
import { PanelNote } from './PanelNote';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
const PANE_STRETCH = [0.52, 0.24, 0.24] as const;
const IDS = ['spx', 'spx_pe', 'spx_price_m', 'spx_cape', 'us10y'];
const PE_DEF = INDICATOR_MAP['spx_pe']!;
const ZONES = PE_DEF.zones ?? [];
const BASE_YEAR = PE_BASE_START.slice(0, 4);

const fin = (v: number | null | undefined) => v !== null && v !== undefined && Number.isFinite(v);
const f1 = (v: number | null | undefined) => (fin(v) ? v!.toFixed(1) : '—');
const f2 = (v: number | null | undefined) => (fin(v) ? v!.toFixed(2) : '—');
const fInt = (v: number | null | undefined) => (fin(v) ? Math.round(v!).toLocaleString('en-US') : '—');
const fpct = (v: number | null | undefined, d = 1) => (fin(v) ? `${v! > 0 ? '+' : ''}${v!.toFixed(d)}%` : '—');
const fpp = (v: number | null | undefined) => (fin(v) ? `${v! > 0 ? '+' : ''}${v!.toFixed(2)}pp` : '—');
const pctile = (v: number | null | undefined) => (fin(v) ? `第 ${Math.round(v!)} 百分位` : '—');

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

export function UsValuationPanel({ version, themeKey }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const near = useNearViewport(sectionRef);
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('uv-range', ['3M', '6M', '1Y', '5Y', '10Y', 'ALL'], '10Y'));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const files = useSeriesMap(near ? IDS : [], version);
  const data = useMemo(() => {
    const ready = (id: string): Point[] => (files[id]?.status === 'ready' ? closesOf(files[id]!.data.data) : []);
    const peMonthly = ready('spx_pe');
    const priceMonthly = ready('spx_price_m');
    const us10y = ready('us10y');
    const eps = epsSeries(peMonthly, priceMonthly);
    const rows = riverRows(ready('spx'), eps, us10y);
    return { rows, peMonthly, priceMonthly, us10y, eps, cape: ready('spx_cape') };
  }, [files]);
  const { rows } = data;
  const summary = useMemo(
    () => summarize(rows, data.peMonthly, data.eps, data.priceMonthly, data.us10y, data.cape, ZONES),
    [rows, data],
  );

  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('uv-range', r);
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
    const ppFmt = { type: 'price' as const, precision: 2, minMove: 0.01 };
    const zoneColor = (v: number) => cssVar(zoneAt(ZONES, v)?.color ?? '--text-1');
    // 色帶比景氣燈號的背景色帶再深一點：河道本身就是這張圖的主角
    const alpha = Math.min(0.35, (Number.parseFloat(cssVar('--lamp-band-alpha')) || 0.1) * 1.6);

    // 上窗格：指數（對數軸）＋ 5 條倍數線（細灰線，讓價格軸自動縮放把整條河道包進來）＋ 色帶
    const priceS = chart.addSeries(
      LineSeries,
      { color: cssVar('--text-1'), lineWidth: 2, priceFormat: ptFmt, lastValueVisible: false },
      0,
    );
    priceS.setData(rows.map((r, i) => ({ time: times[i]!, value: r.price })));
    const bandValues = RIVER_MULTIPLES.map((m) => rows.map((r) => r.eps * m));
    for (const vals of bandValues) {
      const s = chart.addSeries(
        LineSeries,
        {
          color: textColor,
          lineWidth: 1,
          priceFormat: ptFmt,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        },
        0,
      );
      s.setData(vals.map((v, i) => ({ time: times[i]!, value: v })));
    }
    const bands: RiverBand[] = [];
    for (let k = 0; k + 1 < RIVER_MULTIPLES.length; k++) {
      bands.push({ lower: bandValues[k]!, upper: bandValues[k + 1]!, color: hexAlpha(zoneColor(RIVER_MULTIPLES[k]!), alpha) });
    }
    priceS.attachPrimitive(new RiverBands(bands));
    chart.priceScale('right', 0).applyOptions({ mode: PriceScaleMode.Logarithmic });

    // 中窗格：本益比，線段依區間上色（與指標表的 S&P本益比 圖一致）；虛線＝基期中位數
    const peS = chart.addSeries(
      LineSeries,
      { color: zoneColor(summary.pe), lineWidth: 2, priceFormat: x1Fmt, lastValueVisible: false },
      1,
    );
    peS.setData(rows.map((r, i) => ({ time: times[i]!, value: r.pe, color: zoneColor(r.pe) })));
    if (summary.peStats) {
      peS.createPriceLine({ price: summary.peStats.median, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }

    // 下窗格：股債利差，0 以上股票較划算、以下債券較划算
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
        priceFormat: ppFmt,
        lastValueVisible: false,
      },
      2,
    );
    spreadS.setData(rows.map((r, i) => (r.spread === null ? { time: times[i]! } : { time: times[i]!, value: r.spread })));
    spreadS.createPriceLine({ price: 0, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });

    const wm = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) createTextWatermark(pane, { horzAlign: 'left', vertAlign: 'top', lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }] });
    };
    wm(0, `河流圖｜近12月 EPS × ${RIVER_MULTIPLES.join('／')}倍（對數軸）`);
    wm(1, `本益比（倍）｜虛線 ${BASE_YEAR} 起中位數 ${f1(summary.peStats?.median)}`);
    wm(2, '股債利差（pp）＝盈餘殖利率 − 10Y｜0 以下債券較划算');

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
  }, [loaded, rows, summary, themeKey]);

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

  // 圖例：十字線所在日期（沒有時顯示最新）
  const legend = useMemo<RiverRow | null>(() => {
    if (!loaded) return null;
    return rowAtOrBefore(rows, hoverTime ?? rows.at(-1)!.date);
  }, [loaded, hoverTime, rows]);

  const failed = IDS.flatMap((id) => (files[id]?.status === 'error' ? [`${id}：${(files[id] as { error: string }).error}`] : []));
  const bandChips = RIVER_MULTIPLES.slice(0, -1).map((m, k) => ({
    label: `${m}–${RIVER_MULTIPLES[k + 1]}倍 ${zoneAt(ZONES, m)?.label ?? ''}`,
    color: zoneAt(ZONES, m)?.color ?? '--text-3',
  }));

  return (
    <section ref={sectionRef} id="sec-uv" className="regime ms uv" aria-label="美股估值">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">美股估值（參考）</span>
        </div>
        {summary && (
          <span className="small muted num">
            S&P 500 {summary.date}｜EPS {summary.epsDate.slice(0, 7)}
          </span>
        )}
      </div>

      {summary && (
        <>
          <p className="score num uv-state">
            本益比 <b>{f1(summary.pe)}倍</b>（近12月 EPS ${f1(summary.eps)}，年增 {fpct(summary.epsYoy)}）
            {summary.zone && <>→ <b>{summary.zone}</b></>}
            {summary.peStats && (
              <>
                ｜{BASE_YEAR} 起{pctile(summary.peStats.pct)}（中位數 {f1(summary.peStats.median)}倍）
              </>
            )}
            {summary.cape !== null && (
              <>
                ｜CAPE {f1(summary.cape)}倍（1881 起{pctile(summary.capePct)}）
              </>
            )}
          </p>
          <p className="score num uv-state">
            河道位置：
            {summary.position.below !== null && summary.position.above !== null
              ? `${summary.position.below}～${summary.position.above}倍之間`
              : summary.position.above === null
                ? `高於 ${RIVER_MULTIPLES.at(-1)}倍線`
                : `低於 ${RIVER_MULTIPLES[0]}倍線`}
            {summary.position.above !== null && <>，距 {summary.position.above}倍線 {fpct(summary.position.distAbove)}</>}
            {summary.position.below !== null && <>、距 {summary.position.below}倍線 {fpct(summary.position.distBelow)}</>}
            ｜股債利差 <b>{fpp(summary.spread)}</b>
            {summary.spread !== null && (
              <>
                （盈餘殖利率 {f2(summary.earningsYield)}% − 10Y {f2(summary.y10)}%）→ {spreadText(summary.spread)}
                {summary.spreadLowestSince && <>，{summary.spreadLowestSince} 以來最低</>}
              </>
            )}
          </p>
        </>
      )}

      <PanelNote>
        <p className="small muted ms-rule">
          河流圖＝近 12 月 EPS（Shiller as-reported）× 15／19／23／27／31 倍：指數貼近上緣＝估值高、貼近下緣＝便宜；
          河道隨 EPS 上升而上移，所以指數橫盤也能從貴變合理。本益比高不等於會跌（2013–2021 都在 20 倍以上續漲，對未來一年報酬幾乎沒有預測力），
          它決定的是部位大小（跌 25% 撐不撐得住），不是進出場時機。
          股債利差＝盈餘殖利率（EPS÷指數）− 美債10Y：負值＝無風險的債券報酬已高於股票的盈餘報酬，股票沒有估值緩衝。
          百分位與中位數以 {BASE_YEAR} 年起為基期（1871 年起均值 16 倍）；預估本益比（forward P/E）沒有免費資料源，看 FactSet Earnings Insight（每週五）。
          資料：multpl.com（Shiller 月資料，最新一筆以最新收盤估計）、Yahoo ^GSPC、FRED DGS10。參考、不計分。
        </p>
      </PanelNote>

      <div className="cp-mas ma-row" role="list" aria-label="河道區間">
        {bandChips.map((c) => (
          <span key={c.label} className="ma-chip" role="listitem" aria-pressed="true" aria-disabled="true">
            <i className="swatch" style={{ background: `var(${c.color})` }} />
            {c.label}
          </span>
        ))}
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
        <p className="cp-msg warn">無法載入 S&P 500 或本益比資料</p>
      ) : (
        <div className="pricechart ms-chart">
          {legend && (
            <div className="legend num cm-legend" aria-live="off">
              <div>
                <span className="muted">{legend.date}</span> S&P <b>{fInt(legend.price)}</b> ｜ 本益比 <b>{f1(legend.pe)}倍</b>
                <span className="muted"> {zoneAt(ZONES, legend.pe)?.label}</span> ｜ EPS {f1(legend.eps)} ｜ 利差 <b>{fpp(legend.spread)}</b>
              </div>
              <div className="muted">
                河道 {RIVER_MULTIPLES.map((m) => `${m}倍 ${fInt(legend.eps * m)}`).join('｜')}
              </div>
            </div>
          )}
          <div ref={hostRef} className="chart-host uv-host" />
        </div>
      )}
    </section>
  );
}
