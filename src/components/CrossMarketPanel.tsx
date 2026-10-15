import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createTextWatermark,
  type IChartApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useSeriesMap } from '../hooks/useData';
import { MA_COLOR_VAR } from '../lib/chartData';
import { CHART_INTERACTION, resetPaneStretch, resetPriceScales } from '../lib/chartInteraction';
import { loadIdList, loadPref, savePref } from '../lib/storage';
import { cssVar } from '../lib/stressFormat';
import {
  alignToTwCalendar,
  COMPARE_SERIES,
  CORR_WINDOWS,
  correlationSeries,
  DEFAULT_COMPARE,
  MAX_COMPARE,
  pairedReturns,
  type CorrSeries,
  type Session,
} from '../shared/crossMarket';
import { INDICATOR_MAP } from '../shared/indicators';
import { rangeStart, sma, type RangeKey } from '../shared/timeseries';
import type { Bar } from '../shared/types';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: 'ALL', label: '全部' },
];
const COMPARE_IDS = COMPARE_SERIES.map((s) => s.id);
const TW_MAS = [60, 240] as const;
/** 上窗格（加權）較高，其餘對照窗格等高 */
const TOP_STRETCH = 1.6;

interface PaneData {
  id: string;
  label: string;
  session: Session;
  /** 顯示用 K 棒（美系序列對齊後為台股交易日） */
  bars: Bar[];
  closeOnly: boolean;
  decimals: number;
  corr: CorrSeries;
}

const fmtNum = (v: number | null | undefined, decimals: number) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? '—'
    : v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const fmtPct = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmtRho = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2));

/** ≤ date 的最後一個索引（dates 遞增） */
function indexAtOrBefore(dates: readonly string[], date: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 進入可視範圍（含前後 600px）才載入資料，避免拖慢首頁 */
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

function sessionText(session: Session, aligned: boolean): string {
  if (session === 'tw') return '同時段';
  return aligned ? '前一晚，已對齊' : '前一晚，未對齊';
}

export function CrossMarketPanel({ version, themeKey }: { version: string; themeKey: string }) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const near = useNearViewport(sectionRef);
  const [selected, setSelected] = useState<string[]>(() => loadIdList('cm-ids', COMPARE_IDS, DEFAULT_COMPARE));
  const [aligned, setAligned] = useState(() => loadPref('cm-align', ['1', '0'] as const, '1') === '1');
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('cm-range', ['3M', '6M', '1Y', '5Y', 'ALL'], '3M'));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const ids = useMemo(() => ['taiex', ...COMPARE_IDS.filter((id) => selected.includes(id))], [selected]);
  const files = useSeriesMap(near ? ids : [], version);
  const taiex = files.taiex;
  const twBars = useMemo(() => (taiex?.status === 'ready' ? taiex.data.data : []), [taiex]);

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    if (next.length > MAX_COMPARE) return;
    setSelected(next);
    savePref('cm-ids', JSON.stringify(next));
  };
  const setAlign = (v: boolean) => {
    setAligned(v);
    savePref('cm-align', v ? '1' : '0');
  };
  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('cm-range', r);
  };

  const twDates = useMemo(() => twBars.map((b) => b[0]), [twBars]);
  const twMa = useMemo(() => {
    const closes = twBars.map((b) => b[4]);
    return Object.fromEntries(TW_MAS.map((p) => [p, sma(closes, p)])) as Record<(typeof TW_MAS)[number], (number | null)[]>;
  }, [twBars]);

  const panes = useMemo<PaneData[]>(() => {
    if (twBars.length === 0) return [];
    const out: PaneData[] = [];
    for (const spec of COMPARE_SERIES) {
      if (!selected.includes(spec.id)) continue;
      const f = files[spec.id];
      if (!f || f.status !== 'ready' || f.data.data.length === 0) continue;
      const raw = f.data.data;
      const bars = spec.session === 'us' && aligned ? alignToTwCalendar(raw, twDates) : raw;
      const def = INDICATOR_MAP[spec.id];
      out.push({
        id: spec.id,
        label: def?.short ?? spec.id,
        session: spec.session,
        bars,
        closeOnly: f.data.closeOnly,
        // 指數類在對照窗格用整數，價格軸較不占寬度（匯率、利率、油價維持原精度）
        decimals: def?.unit === 'pt' ? 0 : (def?.decimals ?? 2),
        corr: correlationSeries(pairedReturns(twBars, bars)),
      });
    }
    return out;
  }, [twBars, twDates, files, selected, aligned]);

  // 圖表：窗格數會隨選擇變動，資料或選擇改變時整個重建（比逐一增刪窗格單純）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || twBars.length === 0) return;
    const grid = cssVar('--grid');
    const up = cssVar('--up');
    const down = cssVar('--down');
    const textColor = cssVar('--text-3');
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const chart = createChart(host, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd' },
      timeScale: { rightOffset: 2, fixLeftEdge: true, fixRightEdge: true, minBarSpacing: 0.2, borderColor: grid },
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
    const candleOpts = { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down };
    const watermark = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) {
        createTextWatermark(pane, {
          horzAlign: 'left',
          vertAlign: 'top',
          lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }],
        });
      }
    };

    const tw = chart.addSeries(CandlestickSeries, { ...candleOpts, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 0);
    tw.setData(twBars.map((b) => ({ time: b[0] as Time, open: b[1], high: b[2], low: b[3], close: b[4] })));
    for (const p of TW_MAS) {
      const s = chart.addSeries(
        LineSeries,
        { color: cssVar(MA_COLOR_VAR[p]), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
        0,
      );
      s.setData(twBars.flatMap((b, i) => (twMa[p][i] == null ? [] : [{ time: b[0] as Time, value: twMa[p][i]! }])));
    }
    watermark(0, '加權指數（MA60／MA240）');

    panes.forEach((p, k) => {
      const paneIndex = k + 1;
      const priceFormat = { type: 'price' as const, precision: p.decimals, minMove: 1 / 10 ** p.decimals };
      if (p.closeOnly) {
        const s = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 2, priceFormat }, paneIndex);
        s.setData(p.bars.map((b) => ({ time: b[0] as Time, value: b[4] })));
      } else {
        const s = chart.addSeries(CandlestickSeries, { ...candleOpts, priceFormat }, paneIndex);
        s.setData(p.bars.map((b) => ({ time: b[0] as Time, open: b[1], high: b[2], low: b[3], close: b[4] })));
      }
      watermark(paneIndex, `${p.label}（${sessionText(p.session, aligned)}）`);
    });

    const handler = (param: MouseEventParams<Time>) => setHoverTime(typeof param.time === 'string' ? param.time : null);
    chart.subscribeCrosshairMove(handler);
    chartRef.current = chart;
    setChartGen((g) => g + 1);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      chart.remove();
      chartRef.current = null;
    };
  }, [twBars, twMa, panes, aligned, themeKey]);

  // 時間區間與重設：每個窗格 Y 軸自動縮放、高度比例設回預設
  useEffect(() => {
    const chart = chartRef.current;
    const lastTw = twBars.at(-1);
    if (!chart || !lastTw) return;
    const lastDate = panes.reduce((m, p) => (p.bars.at(-1)?.[0] ?? '') > m ? p.bars.at(-1)![0] : m, lastTw[0]);
    const start = rangeStart(lastTw[0], range);
    const apply = () => {
      resetPriceScales(chart);
      resetPaneStretch(chart, [TOP_STRETCH, ...panes.map(() => 1)]);
      if (!start || start <= twBars[0]![0]) chart.timeScale().fitContent();
      else chart.timeScale().setVisibleRange({ from: start as Time, to: lastDate as Time });
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [chartGen, range, resetKey, twBars, panes]);

  // 圖例：十字線所在日期（沒有時各序列顯示自己最新一筆）
  const legend = useMemo(() => {
    if (twBars.length === 0) return null;
    const twIdx = hoverTime ? indexAtOrBefore(twDates, hoverTime) : twBars.length - 1;
    const twBar = hoverTime ? (twDates[twIdx] === hoverTime ? twBars[twIdx] : undefined) : twBars[twIdx];
    const twPrev = twBar && twIdx > 0 ? twBars[twIdx - 1]! : null;
    const rows = panes.map((p) => {
      const dates = p.bars.map((b) => b[0]);
      const i = hoverTime ? indexAtOrBefore(dates, hoverTime) : p.bars.length - 1;
      const bar = hoverTime ? (dates[i] === hoverTime ? p.bars[i] : undefined) : p.bars[i];
      const prev = bar && i > 0 ? p.bars[i - 1]! : null;
      const ci = Math.max(0, twIdx);
      return {
        id: p.id,
        label: p.label,
        decimals: p.decimals,
        bar,
        pct: bar && prev ? ((bar[4] - prev[4]) / Math.abs(prev[4])) * 100 : null,
        rho: Object.fromEntries(CORR_WINDOWS.map((n) => [n, p.corr[n][ci] ?? null])) as Record<(typeof CORR_WINDOWS)[number], number | null>,
      };
    });
    return {
      date: hoverTime ?? twBar?.[0] ?? '',
      twBar,
      twPct: twBar && twPrev ? ((twBar[4] - twPrev[4]) / Math.abs(twPrev[4])) * 100 : null,
      ma: Object.fromEntries(TW_MAS.map((p) => [p, twBar ? twMa[p][twIdx] : null])) as Record<(typeof TW_MAS)[number], number | null | undefined>,
      rows,
    };
  }, [twBars, twDates, twMa, panes, hoverTime]);

  const latestRho = panes.map((p) => ({ label: p.label, rho60: p.corr[60].at(-1) ?? null }));
  const failed = COMPARE_SERIES.flatMap((s) => {
    const f = files[s.id];
    return selected.includes(s.id) && f && f.status === 'error' ? [`${INDICATOR_MAP[s.id]?.short ?? s.id}：${f.error}`] : [];
  });
  const atMax = selected.length >= MAX_COMPARE;
  const hostStyle = { ['--cm-panes' as string]: String(panes.length) } as CSSProperties;

  return (
    <section ref={sectionRef} className="regime ms cm" aria-label="跨市場對照">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">跨市場對照（參考）</span>
        </div>
        {twBars.length > 0 && <span className="small muted num">加權資料 {twBars.at(-1)![0]}</span>}
      </div>
      {latestRho.length > 0 && (
        <p className="score num cm-rho">ρ60：{latestRho.map((r) => `${r.label} ${fmtRho(r.rho60)}`).join('｜')}</p>
      )}

      <p className="small muted ms-rule">
        美股、美債、美元、原油在台股開盤前收盤，是台股的「前一晚」：對齊後，同一直線上的美系 K 棒＝台股開盤時看到的那根（連假期間多根合併成一根）。
        日經、KOSPI、櫃買、USD/TWD 與台股同時段，不移。ρ20／ρ60＝日報酬 20／60 日相關係數，看背離與關係斷裂，不是預測；三張圖同向不等於三個證據。
      </p>

      <div className="cp-mas" role="group" aria-label="對照序列">
        {COMPARE_SERIES.map((s) => {
          const on = selected.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              className="ma-chip"
              aria-pressed={on}
              disabled={!on && atMax}
              title={s.session === 'us' ? '台股收盤後交易（前一晚）' : '與台股同時段'}
              onClick={() => toggle(s.id)}
            >
              {INDICATOR_MAP[s.id]?.short ?? s.id}
            </button>
          );
        })}
        <button type="button" className="ma-chip" aria-pressed={aligned} onClick={() => setAlign(!aligned)} title="美系序列往後對齊一個台股交易日">
          ⏰ 美系對齊台股交易日
        </button>
        {atMax && <span className="small muted">最多 {MAX_COMPARE} 個</span>}
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

      {!near || !taiex || taiex.status === 'loading' ? (
        <p className="cp-msg muted">載入中…</p>
      ) : taiex.status === 'error' ? (
        <p className="cp-msg warn">無法載入加權指數資料（{taiex.error}）</p>
      ) : (
        <div className="pricechart ms-chart">
          {legend && (
            <div className="legend num cm-legend" aria-live="off">
              <div>
                <span className="muted">{legend.date}</span> 加權 <b>{fmtNum(legend.twBar?.[4], 0)}</b>{' '}
                <span className={legend.twPct !== null ? (legend.twPct > 0 ? 'up' : legend.twPct < 0 ? 'down' : '') : ''}>{fmtPct(legend.twPct)}</span>{' '}
                <span className="muted">
                  MA60 {fmtNum(legend.ma[60], 0)} MA240 {fmtNum(legend.ma[240], 0)}
                </span>
              </div>
              {legend.rows.map((r) => (
                <div key={r.id}>
                  {r.label} <b>{fmtNum(r.bar?.[4], r.decimals)}</b>{' '}
                  <span className={r.pct !== null ? (r.pct > 0 ? 'up' : r.pct < 0 ? 'down' : '') : ''}>{fmtPct(r.pct)}</span>{' '}
                  <span className="muted">
                    ρ20 {fmtRho(r.rho[20])} ρ60 {fmtRho(r.rho[60])}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div ref={hostRef} className="chart-host cm-host" style={hostStyle} />
        </div>
      )}
    </section>
  );
}
