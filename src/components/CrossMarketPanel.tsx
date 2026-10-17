import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type IChartApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
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
  COMPARE_PRESETS,
  COMPARE_SERIES,
  CORR_WINDOWS,
  correlationSeries,
  DEFAULT_COMPARE,
  MAX_COMPARE,
  pairedReturns,
  toggleCompare,
  type CorrSeries,
  type Session,
} from '../shared/crossMarket';
import type { CalendarFile } from '../shared/calendar';
import { todayInTaipei } from '../shared/dates';
import {
  EVENT_KIND_TEXT,
  eventLabel,
  eventStats,
  eventsByReactionDay,
  pastEvents,
  surprisesFor,
  type EventKind,
  type MarkedEvent,
} from '../shared/eventMarkers';
import { INDICATOR_MAP } from '../shared/indicators';
import { MA_PERIODS, rangeStart, sma, type MaPeriod, type RangeKey } from '../shared/timeseries';
import type { Bar, SummaryFile } from '../shared/types';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
  { k: 'ALL', label: '全部' },
];
const COMPARE_IDS = COMPARE_SERIES.map((s) => s.id);
/** 上窗格（加權）較高，其餘對照窗格等高 */
const TOP_STRETCH = 1.6;
/** 公布日標記顏色（CSS 變數）；只在 1 年以內的區間顯示（5 年約 180 個點會蓋住 K 線、撐開 Y 軸） */
const EVENT_COLOR_VAR: Record<EventKind, string> = { cpi: '--accent', jobs: '--warn', fomc: '--text-1' };
const EVENT_RANGES: RangeKey[] = ['3M', '6M', '1Y'];
/** 文字標籤只在半年以內顯示（1 年約 36 個標記，加文字會互相蓋住） */
const EVENT_TEXT_RANGES: RangeKey[] = ['3M', '6M'];
/** 波動統計起算日（通膨主題期） */
const STATS_SINCE = '2022-01-01';

interface PaneData {
  id: string;
  label: string;
  session: Session;
  /** 顯示用 K 棒（美系序列對齊後為台股交易日） */
  bars: Bar[];
  closeOnly: boolean;
  decimals: number;
  corr: CorrSeries;
  /** 依勾選均線週期計算（以顯示用 K 棒的收盤） */
  ma: Partial<Record<MaPeriod, (number | null)[]>>;
}

/** 依勾選的週期算均線 */
function maLines(bars: readonly Bar[], mas: readonly MaPeriod[]): Partial<Record<MaPeriod, (number | null)[]>> {
  const closes = bars.map((b) => b[4]);
  return Object.fromEntries(mas.map((p) => [p, sma(closes, p)])) as Partial<Record<MaPeriod, (number | null)[]>>;
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

interface Props {
  version: string;
  themeKey: string;
  /** 均線週期，與單一指標圖共用同一個設定 */
  mas: MaPeriod[];
  onMas: (mas: MaPeriod[]) => void;
  /** 公布日標記的市場預期與實績（選用） */
  calendar?: CalendarFile | null;
  summary?: SummaryFile | null;
  now?: Date;
}

export function CrossMarketPanel({ version, themeKey, mas, onMas, calendar = null, summary = null, now }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [showEvents, setShowEvents] = useState(() => loadPref('cm-events', ['1', '0'] as const, '1') === '1');
  const near = useNearViewport(sectionRef);
  const [selected, setSelected] = useState<string[]>(() => loadIdList('cm-ids', COMPARE_IDS, DEFAULT_COMPARE));
  const [aligned, setAligned] = useState(() => loadPref('cm-align', ['1', '0'] as const, '1') === '1');
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('cm-range', ['3M', '6M', '1Y', '5Y', '10Y', 'ALL'], '3M'));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);

  const ids = useMemo(() => ['taiex', ...COMPARE_IDS.filter((id) => selected.includes(id))], [selected]);
  const files = useSeriesMap(near ? ids : [], version);
  const taiex = files.taiex;
  const twBars = useMemo(() => (taiex?.status === 'ready' ? taiex.data.data : []), [taiex]);

  const select = (next: string[]) => {
    setSelected(next);
    savePref('cm-ids', JSON.stringify(next));
  };
  const toggle = (id: string) => select(toggleCompare(selected, id));
  const setAlign = (v: boolean) => {
    setAligned(v);
    savePref('cm-align', v ? '1' : '0');
  };
  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('cm-range', r);
  };

  const toggleMa = (p: MaPeriod) => onMas(mas.includes(p) ? mas.filter((x) => x !== p) : [...mas, p].sort((a, b) => a - b));

  const twDates = useMemo(() => twBars.map((b) => b[0]), [twBars]);
  const twMa = useMemo(() => maLines(twBars, mas), [twBars, mas]);
  const nowDate = now ?? new Date();
  const today = todayInTaipei(nowDate);
  // 公布日標記：歷史清單＋日程表已發生者 → 反應日（公布後第一個台股交易日）
  const eventsByDay = useMemo(() => (twDates.length ? eventsByReactionDay(pastEvents(today), twDates) : new Map<string, MarkedEvent[]>()), [twDates, today]);
  const stats = useMemo(() => (twBars.length ? eventStats(twBars, eventsByDay, STATS_SINCE) : null), [twBars, eventsByDay]);
  const toggleEvents = () => {
    setShowEvents(!showEvents);
    savePref('cm-events', showEvents ? '0' : '1');
  };

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
        // 數值 ≥ 1000（指數、黃金）在對照窗格用整數，價格軸較不占寬度；匯率、利率、油價、VIX 維持原精度
        decimals: (raw.at(-1)?.[4] ?? 0) >= 1000 ? 0 : (def?.decimals ?? 2),
        corr: correlationSeries(pairedReturns(twBars, bars)),
        ma: maLines(bars, mas),
      });
    }
    return out;
  }, [twBars, twDates, files, selected, aligned, mas]);

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

    // 均線：所有窗格同一組週期；不標數值（加權的數值在圖例）
    const addMas = (paneIndex: number, bars: readonly Bar[], lines: Partial<Record<MaPeriod, (number | null)[]>>) => {
      for (const p of mas) {
        const vals = lines[p];
        if (!vals) continue;
        const s = chart.addSeries(
          LineSeries,
          { color: cssVar(MA_COLOR_VAR[p]), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
          paneIndex,
        );
        s.setData(bars.flatMap((b, i) => (vals[i] == null ? [] : [{ time: b[0] as Time, value: vals[i]! }])));
      }
    };
    const maText = mas.length > 0 ? `（MA${mas.join('／')}）` : '';

    const tw = chart.addSeries(CandlestickSeries, { ...candleOpts, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 0);
    tw.setData(twBars.map((b) => ({ time: b[0] as Time, open: b[1], high: b[2], low: b[3], close: b[4] })));
    markersRef.current = createSeriesMarkers(tw, []);
    addMas(0, twBars, twMa);
    watermark(0, `加權指數${maText}`);

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
      addMas(paneIndex, p.bars, p.ma);
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
      markersRef.current = null;
    };
  }, [twBars, twMa, panes, aligned, mas, themeKey]);

  // 公布日標記：加權 K 棒下方一個圓點＋文字（CPI 藍、非農橘、FOMC 黑）；只在 1 年以內區間顯示
  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    if (!showEvents || !EVENT_RANGES.includes(range)) {
      m.setMarkers([]);
      return;
    }
    const withText = EVENT_TEXT_RANGES.includes(range);
    const markers: SeriesMarker<Time>[] = [];
    for (const [day, evs] of eventsByDay) {
      // 同一天多個事件只畫一個點，顏色取最先的；文字合併
      const first = evs[0]!;
      markers.push({
        time: day as Time,
        position: 'belowBar',
        shape: 'circle',
        size: 0.6,
        color: cssVar(EVENT_COLOR_VAR[first.kind]),
        text: withText ? [...new Set(evs.map((e) => EVENT_KIND_TEXT[e.kind]))].join('+') : undefined,
      });
    }
    markers.sort((a, b) => (a.time as string).localeCompare(b.time as string));
    m.setMarkers(markers);
  }, [chartGen, showEvents, range, eventsByDay]);

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
    const day = hoverTime ?? twBar?.[0] ?? '';
    const events = (showEvents ? eventsByDay.get(day) ?? [] : []).map((e) => {
      const sv = surprisesFor(e, calendar, summary, nowDate).filter((v) => v.actual !== null);
      const text = sv
        .map((v) => {
          const short = INDICATOR_MAP[v.def.indicatorId]?.short ?? v.def.indicatorId;
          const name = v.def.label === short ? short : `${short} ${v.def.label}`;
          return `${name} ${v.actual}${v.def.unit === '%' ? '%' : 'k'}${v.event.forecast !== null ? `（預期 ${v.event.forecast}，${v.diff! > 0 ? '+' : ''}${v.diff}）` : ''}`;
        })
        .join('、');
      return { label: eventLabel(e), kind: e.kind, text };
    });
    return {
      date: day,
      events,
      twBar,
      twPct: twBar && twPrev ? ((twBar[4] - twPrev[4]) / Math.abs(twPrev[4])) * 100 : null,
      ma: Object.fromEntries(mas.map((p) => [p, twBar ? twMa[p]?.[twIdx] : null])) as Partial<Record<MaPeriod, number | null | undefined>>,
      rows,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twBars, twDates, twMa, panes, hoverTime, mas, showEvents, eventsByDay, calendar, summary]);

  const latestRho = panes.map((p) => ({ label: p.label, rho60: p.corr[60].at(-1) ?? null }));
  const failed = COMPARE_SERIES.flatMap((s) => {
    const f = files[s.id];
    return selected.includes(s.id) && f && f.status === 'error' ? [`${INDICATOR_MAP[s.id]?.short ?? s.id}：${f.error}`] : [];
  });
  const atMax = selected.length >= MAX_COMPARE;
  const oldest = atMax ? INDICATOR_MAP[selected[0]!]?.short ?? selected[0] : null;
  const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
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
        黃金、VIX 用來分辨今天是哪種行情（黃金↑油↑殖利率↓＝地緣避險；黃金↑美元↑殖利率↑＝通膨），不是預測戰爭。
        TLT 是美債價格，與 10Y 殖利率鏡像（殖利率 +10bp ≈ TLT −1.6%），兩張圖是同一件事，不算兩個證據；用途是比 FRED 早 1–2 天看到昨晚美債走勢。
        加權 K 棒下方的圓點是 CPI（藍）、就業報告（橘）、FOMC（黑）公布後台股第一個交易日：美東 08:30／14:00 公布時台股已收盤，反應落在隔天。
        動市場的是「實績 vs 預期」不是年增率本身，所以用標記不畫月線；2026-10 起有市場預期，點到該日圖例會列出驚喜值。標記只在 1 年以內的區間顯示（半年以內才附文字）。
      </p>
      {stats && Number.isFinite(stats.normal.meanAbs) && (
        <p className="small muted num cm-stats">
          {STATS_SINCE.slice(0, 4)} 年起加權反應日 |漲跌| 均值：平常日 {stats.normal.meanAbs.toFixed(2)}%（≥1.5% 佔 {stats.normal.bigPct.toFixed(0)}%）｜
          {(['cpi', 'jobs', 'fomc'] as const)
            .map((k) => `${EVENT_KIND_TEXT[k]} ${stats.kinds[k].meanAbs.toFixed(2)}%（${stats.kinds[k].bigPct.toFixed(0)}%，n=${stats.kinds[k].n}）`)
            .join('｜')}
        </p>
      )}

      <div className="cp-mas" role="group" aria-label="對照組合">
        <div className="seg" role="group" aria-label="一鍵切換組合">
          {COMPARE_PRESETS.map((g) => (
            <button key={g.key} type="button" aria-pressed={sameSet(selected, g.ids)} onClick={() => select(g.ids)}>
              {g.label}
            </button>
          ))}
        </div>
        <button type="button" className="ma-chip" aria-pressed={aligned} onClick={() => setAlign(!aligned)} title="美系序列往後對齊一個台股交易日">
          ⏰ 美系對齊台股交易日
        </button>
        <button type="button" className="ma-chip" aria-pressed={showEvents} onClick={toggleEvents} title="CPI／就業報告／FOMC 公布後台股第一個交易日">
          📌 公布日標記
        </button>
      </div>

      <div className="cp-mas" role="group" aria-label="對照序列">
        {COMPARE_SERIES.map((s) => {
          const on = selected.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              className="ma-chip"
              aria-pressed={on}
              title={s.session === 'us' ? '台股收盤後交易（前一晚）' : '與台股同時段'}
              onClick={() => toggle(s.id)}
            >
              {INDICATOR_MAP[s.id]?.short ?? s.id}
            </button>
          );
        })}
        {atMax && <span className="small muted">已滿 {MAX_COMPARE} 個，再選會換掉最早選的（{oldest}）</span>}
      </div>

      <div className="cp-mas" role="group" aria-label="均線">
        {MA_PERIODS.map((p) => (
          <button key={p} type="button" className="ma-chip" aria-pressed={mas.includes(p)} onClick={() => toggleMa(p)}>
            <i className="swatch" style={{ background: `var(${MA_COLOR_VAR[p]})` }} />
            MA{p}
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
                <span className={legend.twPct !== null ? (legend.twPct > 0 ? 'up' : legend.twPct < 0 ? 'down' : '') : ''}>{fmtPct(legend.twPct)}</span>
              </div>
              {legend.events.map((e) => (
                <div key={e.label} className="cm-event">
                  <i className="swatch" style={{ background: `var(${EVENT_COLOR_VAR[e.kind]})` }} />
                  {e.label}
                  {e.text && <span className="muted">：{e.text}</span>}
                </div>
              ))}
              {mas.length > 0 && (
                <div className="ma-legend">
                  {mas.map((p) => (
                    <span key={p}>
                      <i className="swatch" style={{ background: `var(${MA_COLOR_VAR[p]})` }} />
                      MA{p} {fmtNum(legend.ma[p], 0)}
                    </span>
                  ))}
                </div>
              )}
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
