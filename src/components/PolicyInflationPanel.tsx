import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  createTextWatermark,
  type IChartApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSeriesMap } from '../hooks/useData';
import { CHART_INTERACTION, resetPaneStretch, resetPriceScales, attachTimeAxis, TIME_AXIS } from '../lib/chartInteraction';
import { loadPref, savePref } from '../lib/storage';
import { cssVar } from '../lib/stressFormat';
import {
  FED_TARGET,
  REAL_RATE_STATE_TEXT,
  REAL_RATE_TIGHT,
  lastSignFlip,
  realRateSeries,
  splicePolicyRate,
  summarize,
  valueAtOrBefore,
  yoyPoints,
  type RealRateRow,
} from '../shared/policyInflation';
import { rangeStart, type Point, type RangeKey } from '../shared/timeseries';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
const PANE_STRETCH = [0.6, 0.4] as const;

/** 可切換的副線（核心 CPI 固定顯示） */
const EXTRA_LINES = [
  { id: 'cpi', label: '整體 CPI', key: 'pi-cpi', def: '1' },
  { id: 'core_pce', label: '核心 PCE', key: 'pi-pce', def: '0' },
] as const;
type ExtraId = (typeof EXTRA_LINES)[number]['id'];

const IDS = ['fed', 'fed_target_legacy', 'core_cpi', 'cpi', 'core_pce'];

const f2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2));
const f1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(1));
const fpp = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}pp`;
const ym = (d: string) => d.slice(0, 7);

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

export function PolicyInflationPanel({ version, themeKey }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const near = useNearViewport(sectionRef);
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('pi-range', ['3M', '6M', '1Y', '5Y', '10Y', 'ALL'], '5Y'));
  const [extras, setExtras] = useState<Record<ExtraId, boolean>>(() => ({
    cpi: loadPref('pi-cpi', ['1', '0'] as const, '1') === '1',
    core_pce: loadPref('pi-pce', ['1', '0'] as const, '0') === '1',
  }));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const files = useSeriesMap(near ? IDS : [], version);
  const { fed, coreCpi, cpi, corePce } = useMemo(() => {
    const ready = (id: string) => (files[id]?.status === 'ready' ? files[id]!.data.data : null);
    const upper = ready('fed');
    return {
      fed: upper ? splicePolicyRate(upper, ready('fed_target_legacy') ?? []) : ([] as Point[]),
      coreCpi: ready('core_cpi') ? yoyPoints(ready('core_cpi')!) : ([] as Point[]),
      cpi: ready('cpi') ? yoyPoints(ready('cpi')!) : ([] as Point[]),
      corePce: ready('core_pce') ? yoyPoints(ready('core_pce')!) : ([] as Point[]),
    };
  }, [files]);
  const real = useMemo<RealRateRow[]>(() => realRateSeries(fed, coreCpi), [fed, coreCpi]);
  const summary = useMemo(() => summarize(fed, coreCpi), [fed, coreCpi]);
  const flip = useMemo(() => lastSignFlip(real), [real]);

  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('pi-range', r);
  };
  const toggleExtra = (id: ExtraId) => {
    const next = { ...extras, [id]: !extras[id] };
    setExtras(next);
    savePref(EXTRA_LINES.find((e) => e.id === id)!.key, next[id] ? '1' : '0');
  };

  const loaded = fed.length > 0 && coreCpi.length > 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !loaded) return;
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
    const pct = { type: 'price' as const, precision: 2, minMove: 0.01 };
    const toData = (pts: readonly Point[]) => pts.map(([d, v]) => ({ time: d as Time, value: v }));

    // 上窗格：Fed（階梯，深色粗線）、核心 CPI（強調色）、整體 CPI（細虛線）、核心 PCE（細線）
    const fedS = chart.addSeries(
      LineSeries,
      { color: cssVar('--text-1'), lineWidth: 2, lineType: LineType.WithSteps, priceFormat: pct },
      0,
    );
    fedS.setData(toData(fed));
    const coreS = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 2, priceFormat: pct }, 0);
    coreS.setData(toData(coreCpi));
    coreS.createPriceLine({
      price: FED_TARGET,
      color: textColor,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
    });
    if (extras.cpi && cpi.length > 0) {
      const s = chart.addSeries(
        LineSeries,
        { color: cssVar('--ma60'), lineWidth: 1, lineStyle: LineStyle.Dashed, priceFormat: pct, lastValueVisible: false, priceLineVisible: false },
        0,
      );
      s.setData(toData(cpi));
    }
    if (extras.core_pce && corePce.length > 0) {
      const s = chart.addSeries(
        LineSeries,
        { color: cssVar('--ma240'), lineWidth: 1, priceFormat: pct, lastValueVisible: false, priceLineVisible: false },
        0,
      );
      s.setData(toData(corePce));
    }

    // 下窗格：實質政策利率，0 以上緊縮方向、以下寬鬆方向
    const realS = chart.addSeries(
      BaselineSeries,
      {
        baseValue: { type: 'price', price: 0 },
        topLineColor: cssVar('--text-1'),
        topFillColor1: 'rgba(120, 120, 120, 0.25)',
        topFillColor2: 'rgba(120, 120, 120, 0.02)',
        bottomLineColor: cssVar('--accent'),
        bottomFillColor1: 'rgba(0, 0, 0, 0.02)',
        bottomFillColor2: 'rgba(42, 120, 214, 0.25)',
        lineWidth: 2,
        priceFormat: pct,
      },
      1,
    );
    realS.setData(real.map((r) => ({ time: r[0] as Time, value: r[3] })));
    // 參考線只畫虛線，不加圖內文字與軸標籤（標籤會被圖表庫上下推開、蓋住最近的線），說明放在窗格標題
    for (const v of [0, REAL_RATE_TIGHT]) {
      realS.createPriceLine({ price: v, color: textColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }

    const wm = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) createTextWatermark(pane, { horzAlign: 'left', vertAlign: 'top', lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }] });
    };
    wm(0, `Fed 利率 vs 通膨年增（%）｜虛線 2% 目標`);
    wm(1, `實質政策利率＝Fed − 核心CPI（pp）｜虛線 +${REAL_RATE_TIGHT} 緊縮、0 中性`);

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
  }, [loaded, fed, coreCpi, cpi, corePce, real, extras, themeKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = fed.at(-1);
    if (!chart || !last) return;
    const start = rangeStart(last[0], range);
    const apply = () => {
      resetPriceScales(chart);
      resetPaneStretch(chart, PANE_STRETCH);
      if (!start || start <= fed[0]![0]) chart.timeScale().fitContent();
      else chart.timeScale().setVisibleRange({ from: start as Time, to: last[0] as Time });
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [chartGen, range, resetKey, fed]);

  // 圖例：十字線所在日期（沒有時顯示最新）
  const legend = useMemo(() => {
    if (!loaded) return null;
    const date = hoverTime ?? fed.at(-1)![0];
    const at = (pts: readonly Point[]) => (pts.length ? valueAtOrBefore(pts, date) : null);
    const fedV = at(fed);
    const coreV = at(coreCpi);
    return {
      date,
      fed: fedV,
      core: coreV,
      cpi: extras.cpi ? at(cpi) : null,
      pce: extras.core_pce ? at(corePce) : null,
      real: fedV !== null && coreV !== null ? fedV - coreV : null,
    };
  }, [loaded, hoverTime, fed, coreCpi, cpi, corePce, extras]);

  const failed = IDS.flatMap((id) => (files[id]?.status === 'error' ? [`${id}：${(files[id] as { error: string }).error}`] : []));

  return (
    <section ref={sectionRef} className="regime ms pi" aria-label="政策利率與通膨">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">政策利率 vs 通膨（參考）</span>
        </div>
        {summary && (
          <span className="small muted num">
            Fed {summary.fedDate}｜核心CPI {ym(summary.inflationDate)}
          </span>
        )}
      </div>

      {summary && (
        <p className={`score num pi-state pi-${summary.state}`}>
          實質政策利率 <b>{fpp(summary.real)}</b>（Fed {f2(summary.fed)}% − 核心CPI {f1(summary.inflation)}%）→ {REAL_RATE_STATE_TEXT[summary.state]}
          ｜核心CPI 距 2% 目標 {fpp(summary.gapToTarget)}
          {flip && (
            <>
              ｜實質利率 {ym(flip.date)} 轉{flip.to === 'positive' ? '正' : '負'}
            </>
          )}
        </p>
      )}

      <p className="small muted ms-rule">
        看 Fed 跟通膨的距離，不看方向：實質政策利率（Fed − 核心CPI）小於 0 是寬鬆，Fed 歷來不會在這裡停止升息；大於 +1pp 才算緊縮，才有降息空間。
        2000、2006、2019、2023 幾次升息頂點都出現在實質利率翻正之後，但翻正不等於馬上降息（2023 翻正後又撐了一年）。
        核心 CPI 是落後指標；整體 CPI 用來解釋油價飆時 Fed 為什麼不動，核心 PCE 是 Fed 正式目標但晚兩週。
        這張圖與「Fed 120 天」「核心CPI ±0.2pp」規則重疊，只用來解釋 FOMC 為什麼那樣做，不計分。2008 年前 Fed 為單一目標利率。
      </p>

      <div className="cp-mas" role="group" aria-label="通膨序列">
        <span className="ma-chip" aria-pressed="true" aria-disabled="true" title="固定顯示">
          <i className="swatch" style={{ background: 'var(--accent)' }} />
          核心 CPI
        </span>
        {EXTRA_LINES.map((e) => (
          <button key={e.id} type="button" className="ma-chip" aria-pressed={extras[e.id]} onClick={() => toggleExtra(e.id)}>
            <i className="swatch" style={{ background: e.id === 'cpi' ? 'var(--ma60)' : 'var(--ma240)' }} />
            {e.label}
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

      {failed.length > 0 && <p className="small warn">載入失敗：{failed.join('；')}</p>}

      {!near || (!loaded && failed.length === 0) ? (
        <p className="cp-msg muted">載入中…</p>
      ) : !loaded ? (
        <p className="cp-msg warn">無法載入 Fed 或核心 CPI 資料</p>
      ) : (
        <div className="pricechart ms-chart">
          {legend && (
            <div className="legend num cm-legend" aria-live="off">
              <div>
                <span className="muted">{legend.date}</span> Fed <b>{f2(legend.fed)}%</b> ｜ 核心CPI <b>{f1(legend.core)}%</b>
                {legend.cpi !== null && <> ｜ CPI {f1(legend.cpi)}%</>}
                {legend.pce !== null && <> ｜ 核心PCE {f1(legend.pce)}%</>}
              </div>
              <div>
                實質 <b>{fpp(legend.real)}</b>
                {legend.real !== null && <span className="muted"> ｜ {REAL_RATE_STATE_TEXT[legend.real < 0 ? 'loose' : legend.real >= REAL_RATE_TIGHT ? 'tight' : 'mid']}</span>}
              </div>
            </div>
          )}
          <div ref={hostRef} className="chart-host pi-host" />
        </div>
      )}
    </section>
  );
}
