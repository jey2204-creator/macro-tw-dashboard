import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type AutoscaleInfo,
  type IChartApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSeriesMap } from '../hooks/useData';
import { CHART_INTERACTION, attachTimeAxis, resetPaneStretch, resetPriceScales, TIME_AXIS } from '../lib/chartInteraction';
import { loadPref, savePref } from '../lib/storage';
import { cssVar } from '../lib/stressFormat';
import { rangeStart, type RangeKey } from '../shared/timeseries';
import type { Bar } from '../shared/types';
import {
  analyzeUsRisk,
  BAA_WARN,
  BAA_WIDEN_20D,
  BREADTH_RECENT,
  BREADTH_WIN,
  EDGE_MIN,
  EPISODE_GAP,
  EPISODES_MIN,
  HY_PANIC,
  HY_WARN,
  HY_WIDEN_20D,
  RISK_KEYS,
  RISK_LABEL,
  SIGNAL_VERDICT_TEXT,
  VERDICT_COLOR,
  VERDICT_TEXT,
  VOL_CALM,
  VOL_INVERT,
  type RiskAnalysis,
  type RiskBacktest,
  type RiskBucket,
  type RiskKey,
  type RiskRow,
} from '../shared/usRisk';
import { PanelNote } from './PanelNote';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: 'ALL', label: '全部' },
];
const PANE_STRETCH = [0.55, 0.45] as const;
const IDS = ['spx', 'vix', 'vix3m', 'rsp', 'spy', 'baa10y', 'hy_oas', 'fed_assets', 'tga', 'rrp', 'taiex'] as const;
const MODE_SHORT: Record<RiskKey, string> = { credit: '信用', vol: '波動', breadth: '廣度', liq: '流動性' };

const fin = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const p1 = (v: number | null | undefined) => (fin(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%` : '—');
const sign = (v: number | null | undefined) => (!fin(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const sg = (v: number, d: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** #rrggbb → rgba()；不是 hex 就原樣回傳 */
function alpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function Lamp({ color }: { color: string }) {
  return <i className="lamp" style={{ background: `var(${color})` }} aria-hidden="true" />;
}

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

/** 每一波亮燈的第一天（間隔不到 EPISODE_GAP 個交易日算同一波） */
function episodeStarts(rows: readonly RiskRow[], key: RiskKey): string[] {
  const out: string[] = [];
  let last = -Infinity;
  rows.forEach((r, i) => {
    if (!r.lit[key]) return;
    if (i - last > EPISODE_GAP) out.push(r.date);
    last = i;
  });
  return out;
}

/** 結論句：由回測數字自動產生 */
function findings(bt: RiskBacktest): string[] {
  const out: string[] = [];
  const all = bt.all.full;
  const weaker = bt.signals.filter((s) => s.verdict === 'weaker');
  const stronger = bt.signals.filter((s) => s.verdict === 'stronger');
  if (weaker.length === 0)
    out.push(
      `四個燈都沒有通過「亮燈後 60 日報酬穩定偏弱」的檢驗（要比全部日子差 ≥ ${EDGE_MIN} 個百分點，且 ${bt.split.slice(0, 4)} 年前後兩段同方向）→ 亮燈不是賣出訊號，只能當風險狀態看。`,
    );
  else out.push(`通過檢驗（亮燈後 60 日報酬穩定偏弱）的只有：${weaker.map((s) => s.label).join('、')}。`);
  if (stronger.length)
    out.push(`${stronger.map((s) => s.label).join('、')}亮燈後 60 日報酬反而比平常高（前後兩段一致）：恐慌時賣出，歷史上多半賣在相對低點。`);
  for (const s of bt.signals) {
    const b = s.on.full;
    if (b.days === 0) {
      out.push(s.off.full.days === 0 ? `${s.label}：資料不足，沒有回測。` : `${s.label}：${bt.start.slice(0, 4)} 年以來沒有亮過。`);
      continue;
    }
    out.push(
      `${s.label}亮燈占 ${b.pct.toFixed(0)}% 的日子（${b.episodes} 波）：之後 60 日 S&P 500 平均 ${p1(b.avg60)}（全部日子 ${p1(all.avg60)}）、上漲機率 ${b.win60?.toFixed(0) ?? '—'}%（全部 ${all.win60?.toFixed(0) ?? '—'}%）、最差一成 ${p1(b.p10)}（全部 ${p1(all.p10)}）→ ${SIGNAL_VERDICT_TEXT[s.verdict]}。`,
    );
  }
  const c2 = bt.count.find((c) => c.key === 'c2')?.b.full;
  const c0 = bt.count.find((c) => c.key === 'c0')?.b.full;
  if (c2 && c0 && c2.days > 0)
    out.push(
      `同時 ≥ 2 項亮燈占 ${c2.pct.toFixed(0)}% 的日子（${c2.episodes} 波）：60 日平均 ${p1(c2.avg60)}、最差一成 ${p1(c2.p10)}；0 項亮燈時 ${p1(c0.avg60)}、最差一成 ${p1(c0.p10)}。`,
    );
  return out;
}

interface Props {
  version: string;
  themeKey: string;
}

export function UsRiskPanel({ version, themeKey }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const near = useNearViewport(sectionRef);
  const [mode, setMode] = useState<RiskKey>(() => loadPref<RiskKey>('ur-mode', RISK_KEYS, 'credit'));
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('ur-range', ['3M', '6M', '1Y', '5Y', 'ALL'], '1Y'));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);
  const [open, setOpen] = useState(false);

  const files = useSeriesMap(near ? IDS : [], version);
  const settled = near && IDS.every((id) => files[id]?.status === 'ready' || files[id]?.status === 'error');
  const a: RiskAnalysis | null = useMemo(() => {
    if (!settled) return null;
    const get = (id: (typeof IDS)[number]): Bar[] => (files[id]?.status === 'ready' ? files[id].data.data : []);
    if (get('spx').length === 0) return null;
    return analyzeUsRisk({
      spx: get('spx'),
      vix: get('vix'),
      vix3m: get('vix3m'),
      rsp: get('rsp'),
      spy: get('spy'),
      baa: get('baa10y'),
      hy: get('hy_oas'),
      walcl: get('fed_assets'),
      tga: get('tga'),
      rrp: get('rrp'),
      taiex: get('taiex'),
    });
  }, [settled, files]);
  const rows = a?.rows;

  const pickMode = (k: RiskKey) => {
    setMode(k);
    savePref('ur-mode', k);
  };
  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('ur-range', r);
  };

  // 圖表：上＝S&P 500（● 這個燈每一波亮起的第一天）；下＝選定的指標
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !rows || rows.length === 0) return;
    const grid = cssVar('--grid');
    const textColor = cssVar('--text-3');
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const red = cssVar('--lamp-red');
    const green = cssVar('--lamp-green');
    const accent = cssVar('--accent');
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
      leftPriceScale: { visible: false },
    });
    const f0 = { type: 'price' as const, precision: 0, minMove: 1 };
    const f2 = { type: 'price' as const, precision: 2, minMove: 0.01 };
    const tight = { scaleMargins: { top: 0.08, bottom: 0.08 } };
    const pts = (pick: (r: RiskRow) => number | null) => rows.flatMap((r) => (fin(pick(r)) ? [{ time: r.date as Time, value: pick(r)! }] : []));

    const spxS = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: f0, lastValueVisible: true, priceLineVisible: false }, 0);
    spxS.setData(rows.map((r) => ({ time: r.date as Time, value: r.spx })));
    spxS.priceScale().applyOptions(tight);
    const markers: SeriesMarker<Time>[] = episodeStarts(rows, mode).map((d) => ({ time: d as Time, position: 'aboveBar', shape: 'circle', color: red, size: 0.6 }));
    if (markers.length) createSeriesMarkers(spxS, markers);

    const dash = (s: ReturnType<typeof chart.addSeries>, price: number, title: string, color = red) =>
      s.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title });

    let lower: string;
    if (mode === 'credit') {
      // Baa−10Y 全史在看不見的左軸（各自縮放）；HY 利差近 3 年在右軸
      const baaS = chart.addSeries(
        LineSeries,
        { color: textColor, lineWidth: 1, priceFormat: f2, priceScaleId: 'left', lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
        1,
      );
      baaS.setData(pts((r) => r.baa));
      // 警戒線平常離現值很遠，納入縮放會把 3% 上下的線壓成一條；利差 ≥ 4% 才把 5% 線拉進畫面（比照融資維持率 140 線的做法）
      const lastHy = rows.at(-1)?.hy;
      const pull = fin(lastHy) && lastHy >= HY_WARN - 1;
      const hyS = chart.addSeries(
        LineSeries,
        {
          color: accent,
          lineWidth: 2,
          priceFormat: f2,
          lastValueVisible: true,
          priceLineVisible: false,
          autoscaleInfoProvider: (orig: () => AutoscaleInfo | null) => {
            const info = orig();
            if (!pull || !info?.priceRange) return info;
            return { ...info, priceRange: { minValue: info.priceRange.minValue, maxValue: Math.max(info.priceRange.maxValue, HY_WARN) } };
          },
        },
        1,
      );
      hyS.setData(pts((r) => r.hy));
      hyS.priceScale().applyOptions(tight);
      dash(hyS, HY_WARN, `警戒 ${HY_WARN}%`);
      dash(hyS, HY_PANIC, `恐慌 ${HY_PANIC}%`);
      lower = '高收益債利差 %｜灰線＝Baa−10Y（獨立刻度）';
    } else if (mode === 'vol') {
      const s = chart.addSeries(
        BaselineSeries,
        {
          baseValue: { type: 'price', price: VOL_INVERT },
          topLineColor: red,
          topFillColor1: alpha(red, 0.35),
          topFillColor2: alpha(red, 0.05),
          bottomLineColor: accent,
          bottomFillColor1: alpha(accent, 0),
          bottomFillColor2: alpha(accent, 0),
          lineWidth: 2,
          priceFormat: f2,
          lastValueVisible: true,
          priceLineVisible: false,
        },
        1,
      );
      s.setData(pts((r) => r.volRatio));
      s.priceScale().applyOptions(tight);
      dash(s, VOL_INVERT, `逆價差 ${VOL_INVERT}`);
      dash(s, VOL_CALM, `安逸 ${VOL_CALM}`, textColor);
      lower = 'VIX ÷ VIX3M｜紅＝> 1 逆價差（恐慌）';
    } else if (mode === 'breadth') {
      const s = chart.addSeries(LineSeries, { color: accent, lineWidth: 2, priceFormat: f2, lastValueVisible: true, priceLineVisible: false }, 1);
      s.setData(pts((r) => r.breadth));
      s.priceScale().applyOptions(tight);
      lower = 'RSP ÷ SPY × 100｜往下＝漲勢集中在權值股';
    } else {
      const h = chart.addSeries(HistogramSeries, { priceFormat: f0, priceScaleId: 'left', priceLineVisible: false, lastValueVisible: false }, 1);
      // 每週一根：畫在這筆週資料開始可用的第一個交易日
      let prev: string | null = null;
      h.setData(
        rows.flatMap((r) => {
          if (!fin(r.liqChg4w) || r.liqDate === prev) return [];
          prev = r.liqDate;
          return [{ time: r.date as Time, value: r.liqChg4w * 10, color: r.liqChg4w <= -100 ? red : r.liqChg4w >= 100 ? green : alpha(textColor, 0.6) }];
        }),
      );
      chart.priceScale('left', 1).applyOptions({ scaleMargins: { top: 0.55, bottom: 0 } });
      const s = chart.addSeries(LineSeries, { color: accent, lineWidth: 2, priceFormat: f2, lastValueVisible: true, priceLineVisible: false }, 1);
      s.setData(pts((r) => (fin(r.netLiq) ? r.netLiq / 1000 : null)));
      s.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.3 } });
      lower = '淨流動性（兆美元）｜柱＝4 週變化，紅＝減逾 1,000 億';
    }

    const wm = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) createTextWatermark(pane, { horzAlign: 'left', vertAlign: 'top', lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }] });
    };
    wm(0, `S&P 500｜● ${RISK_LABEL[mode]}每波亮燈首日`);
    wm(1, lower);

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
  }, [rows, mode, themeKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = rows?.at(-1);
    if (!chart || !rows || !last) return;
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
  const legendRow = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    if (!hoverTime) return rows.at(-1)!;
    return rows.findLast((r) => r.date <= hoverTime) ?? rows[0]!;
  }, [rows, hoverTime]);

  const failed = IDS.flatMap((id) => (files[id]?.status === 'error' ? [id] : []));
  const v = a?.verdict;
  const lastRow = rows?.at(-1);

  return (
    <section ref={sectionRef} id="sec-ur" className="regime ms ur" aria-label="美股風險溫度">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">美股風險溫度（參考，不計分）</span>
        </div>
        {lastRow && <span className="small muted num">資料到 {lastRow.date}</span>}
      </div>

      {a && v && (
        <>
          <p className="score num cr-verdict">
            <Lamp color={VERDICT_COLOR[v.verdict]} />
            <b>{VERDICT_TEXT[v.verdict]}</b>{' '}
            <span className="muted small">
              （{v.on}／{v.known} 項亮燈；0 項正常、1 項留意、≥ 2 項警戒）
            </span>
          </p>
          <ul className="sh-sigs small num" aria-label="風險燈號">
            {a.signals.map((s) => (
              <li key={s.key}>
                <Lamp color={s.lit === null ? '--text-3' : s.level === 'panic' ? '--lamp-red' : s.lit ? '--lamp-yellowred' : '--lamp-green'} />
                <span className={s.lit ? 'warn' : ''}>{s.label}</span>
                <span className="muted">：{s.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <PanelNote>
        <div className="small muted ms-rule">
          <p>
            四個燈看的是美股的「風險狀態」，不是預測點位：① 信用壓力：高收益債利差 ≥ {HY_WARN}% 警戒、≥ {HY_PANIC}% 恐慌，或 20 日擴大 ≥ {HY_WIDEN_20D} 個百分點（去槓桿啟動）；② 波動結構：VIX ÷ VIX3M &gt;{' '}
            {VOL_INVERT}（近月比三個月貴，市場搶短期保護），&lt; {VOL_CALM} 是過度安逸、只提示不亮燈；③ 市場廣度：S&P 500 近 {BREADTH_RECENT} 日內創 {BREADTH_WIN} 日新高，但 RSP ÷ SPY 近 {BREADTH_RECENT} 日內創{' '}
            {BREADTH_WIN} 日新低（只剩權值股在撐）；④ 淨流動性：Fed 總資產 − 財政部帳戶 TGA − 隔夜逆回購 RRP，4 週減少逾 1,000 億美元。
          </p>
          <p>
            門檻是市場常用的經驗值，不是從回測挑出來的最佳值。回測口徑：高收益債利差 FRED 只給近 3 年，所以回測的信用燈改用 Baa−10Y 代理（≥ {BAA_WARN}pp 或 20 日擴大 ≥ {BAA_WIDEN_20D}pp，約等於高收益債利差{' '}
            {HY_WARN}%／+{HY_WIDEN_20D}pp）；信用利差隔天才公布，用前一個交易日的值；Fed 週三的資料週四公布，延後 2 天才算可用。圖上的 ● 是回測口徑每一波亮燈的第一天。
          </p>
          <p>
            資料：FRED（高收益債利差 BAMLH0A0HYM2、BAA10Y、WALCL、WDTGAL、RRPONTSYD）、Yahoo（^VIX、^VIX3M、RSP、SPY、^GSPC）。VIX3M 自 2007-12 起，所以回測從 2008 年開始，包含金融海嘯。參考、不計分。
          </p>
        </div>
      </PanelNote>

      <div className="seg" role="group" aria-label="下方窗格">
        {RISK_KEYS.map((k) => (
          <button key={k} type="button" aria-pressed={mode === k} onClick={() => pickMode(k)}>
            {MODE_SHORT[k]}
          </button>
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

      {failed.length > 0 && <p className="small warn">載入失敗：{failed.join('、')}（對應的燈顯示資料不足）</p>}

      {!a && !(settled && failed.length > 0) ? (
        <p className="cp-msg muted">載入中…</p>
      ) : !a || !legendRow ? (
        <p className="cp-msg warn">無法載入美股風險資料</p>
      ) : (
        <>
          <div className="pricechart ms-chart">
            <div className="legend num cm-legend" aria-live="off">
              <div>
                <span className="muted">{legendRow.date}</span> S&P 500 <b>{Math.round(legendRow.spx).toLocaleString('en-US')}</b>
              </div>
              <div className="muted">
                <LegendDetail row={legendRow} mode={mode} />
              </div>
            </div>
            <div ref={hostRef} className="chart-host ur-host" />
          </div>
          {a.backtest && <RiskBacktestBlock bt={a.backtest} open={open} setOpen={setOpen} />}
        </>
      )}
    </section>
  );
}

function LegendDetail({ row, mode }: { row: RiskRow; mode: RiskKey }) {
  if (mode === 'credit')
    return (
      <>
        高收益債利差 {fin(row.hy) ? `${row.hy.toFixed(2)}%` : '—（只有近 3 年）'}
        {fin(row.hyChg20) && <>（20 日 {sg(row.hyChg20, 2)}pp）</>}｜Baa−10Y {fin(row.baa) ? `${row.baa.toFixed(2)}pp` : '—'}
      </>
    );
  if (mode === 'vol')
    return (
      <>
        VIX ÷ VIX3M {fin(row.volRatio) ? row.volRatio.toFixed(2) : '—'}｜VIX {fin(row.vix) ? row.vix.toFixed(1) : '—'}、VIX3M {fin(row.vix3m) ? row.vix3m.toFixed(1) : '—'}
      </>
    );
  if (mode === 'breadth')
    return (
      <>
        RSP ÷ SPY {fin(row.breadth) ? row.breadth.toFixed(2) : '—'}｜指數 {BREADTH_WIN} 日新高 {row.spxHigh ? '✓' : '✗'}、比值 {BREADTH_WIN} 日新低 {row.breadthLow ? '✓' : '✗'}
      </>
    );
  return (
    <>
      淨流動性 {fin(row.netLiq) ? `${(row.netLiq / 1000).toFixed(2)} 兆美元` : '—'}
      {fin(row.liqChg4w) && <>｜4 週 {sg(row.liqChg4w * 10, 0)} 億</>}
      {row.liqDate && <>（Fed {md(row.liqDate)} 週三值）</>}
    </>
  );
}

function RiskBacktestBlock({ bt, open, setOpen }: { bt: RiskBacktest; open: boolean; setOpen: (v: boolean) => void }) {
  return (
    <div className="cr" aria-label="美股風險回測">
      <p className="score num cr-verdict">
        <span className="muted small">
          🧪 回測：亮燈之後的 S&P 500（{bt.start.slice(0, 4)} 起・參考、不計分）
        </span>
      </p>
      <ul className="small btc-find">
        {findings(bt).map((t) => (
          <li key={t.slice(0, 12)}>{t}</li>
        ))}
      </ul>
      <button type="button" className="linkbtn small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起' : '展開'}回測表（各燈亮／沒亮、亮燈數）
      </button>
      {open && <RiskTable bt={bt} />}
    </div>
  );
}

function RiskTable({ bt }: { bt: RiskBacktest }) {
  const line = (key: string, label: string, b: Record<'full' | 'early' | 'late', RiskBucket>, cls = '') => (
    <tr key={key} className={cls}>
      <td className="nw">{label}</td>
      <td className="r">{b.full.pct.toFixed(0)}%</td>
      <td className="r">{b.full.episodes}</td>
      <td className={`r ${sign(b.full.avg20)}`}>{p1(b.full.avg20)}</td>
      <td className={`r ${sign(b.full.avg60)}`}>{p1(b.full.avg60)}</td>
      <td className="r">{b.full.win60 === null ? '—' : `${b.full.win60.toFixed(0)}%`}</td>
      <td className={`r ${sign(b.full.p10)}`}>{p1(b.full.p10)}</td>
      <td className={`r ${sign(b.early.avg60)}`}>{p1(b.early.avg60)}</td>
      <td className={`r ${sign(b.late.avg60)}`}>{p1(b.late.avg60)}</td>
      <td className={`r ${sign(b.full.tw60)}`}>{p1(b.full.tw60)}</td>
    </tr>
  );
  const yr = bt.split.slice(0, 4);
  return (
    <>
      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">
            {bt.start}～{bt.end}，每個交易日算一次。20日／60日＝之後 20、60 個交易日 S&P 500 平均報酬；最差一成＝60 日報酬第 10 百分位；加權60日＝隔一個台股交易日進場、之後 60 個台股交易日的加權指數平均報酬
          </caption>
          <thead>
            <tr>
              <th>條件</th>
              <th className="r">占比</th>
              <th className="r">波數</th>
              <th className="r">20日</th>
              <th className="r">60日</th>
              <th className="r">上漲</th>
              <th className="r">最差一成</th>
              <th className="r">{yr}前</th>
              <th className="r">{yr}起</th>
              <th className="r">加權60日</th>
            </tr>
          </thead>
          <tbody>
            {line('all', '全部日子', bt.all, 'all')}
            {bt.signals.flatMap((s) => [line(`${s.key}-on`, `${s.label}：亮燈`, s.on, 'hl'), line(`${s.key}-off`, `${s.label}：沒亮`, s.off)])}
            {bt.count.map((c) => line(c.key, c.label, c.b, c.key === 'c2' ? 'hl' : ''))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        限制：樣本內結果；60 日觀察期互相重疊，「波數」才接近獨立樣本數（要 ≥ {EPISODES_MIN} 波才下判定）。信用燈回測用 Baa−10Y 代理，與上方用高收益債利差的即時燈不是同一條線。{bt.start.slice(0, 4)}{' '}
        年以來美股長期上漲，任何「亮燈就賣」的規則都要先贏過這個底。
      </p>
    </>
  );
}
