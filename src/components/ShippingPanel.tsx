import {
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createTextWatermark,
  type IChartApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSeriesMap } from '../hooks/useData';
import { CHART_INTERACTION, attachTimeAxis, resetPaneStretch, resetPriceScales, TIME_AXIS } from '../lib/chartInteraction';
import { loadPref, savePref } from '../lib/storage';
import { cssVar } from '../lib/stressFormat';
import {
  analyzeShipping,
  CYCLE_MIN_RISE,
  HORIZONS,
  idxAtOrBefore,
  MA_SLOPE_DAYS,
  REV_MOM_PCT,
  SCFI_DD_PCT,
  SCFI_DOWN_WEEKS,
  SCFI_HIGH_WEEKS,
  SHIP_STOCKS,
  VERDICT_COLOR,
  VERDICT_TEXT,
  type BucketRow,
  type ShipKey,
  type ShippingAnalysis,
} from '../shared/shipping';
import { addDays, daysBetween } from '../shared/dates';
import { rangeStart, sma, type RangeKey } from '../shared/timeseries';
import type { Bar } from '../shared/types';
import { PanelNote } from './PanelNote';

const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: 'ALL', label: '全部' },
];
const PANE_STRETCH = [0.5, 0.25, 0.25] as const;
const KEYS = SHIP_STOCKS.map((s) => s.key);
/** SCFI 相鄰兩點超過這麼多天就斷線（每週公布，連假最多隔約 2 週） */
const SCFI_GAP_DAYS = 21;

const fin = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const p1 = (v: number | null | undefined) => (fin(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%` : '—');
const p0 = (v: number | null | undefined) => (fin(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}%` : '—');
const sign = (v: number | null | undefined) => (!fin(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const n0 = (v: number | null | undefined) => (fin(v) ? Math.round(v).toLocaleString('en-US') : '—');
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const ym = (d: string) => `${d.slice(0, 4)}/${Number(d.slice(5, 7))}`;

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

/** 結論句：由回測數字自動產生 */
function findings(a: ShippingAnalysis, name: string): string[] {
  const out: string[] = [];
  const h6 = (r: BucketRow | undefined) => r?.h.m6;
  const h12 = (r: BucketRow | undefined) => r?.h.m12;
  const boom = a.yoy.rows.find((r) => r.key === 'boom');
  const bust = a.yoy.rows.find((r) => r.key === 'bust');
  if (boom && bust && fin(h12(boom)?.med) && fin(h12(bust)?.med))
    out.push(
      `營收年增 ≥ +50%（爆發期）公布後買進：6 個月中位數 ${p0(h6(boom)!.med)}，但 12 個月中位數 ${p0(h12(boom)!.med)}、上漲機率只有 ${h12(boom)!.up?.toFixed(0)}%（n=${h12(boom)!.n}）；年增 ≤ −40%（最慘時）買進，12 個月中位數 ${p0(h12(bust)!.med)}、上漲 ${h12(bust)!.up?.toFixed(0)}%（n=${h12(bust)!.n}）。全部月份 12 個月中位數 ${p0(a.yoy.base.h.m12.med)}。`,
    );
  const high = a.position.find((r) => r.key === 'high');
  const off = a.position.find((r) => r.key === 'off');
  if (high && off && fin(h12(high)?.med))
    out.push(`營收（3 個月平均）創 24 個月新高時買進，12 個月中位數 ${p0(h12(high)!.med)}、上漲 ${h12(high)!.up?.toFixed(0)}%；已從高點回落 ≥ 15% 時 ${p0(h12(off)?.med)}、上漲 ${h12(off)?.up?.toFixed(0) ?? '—'}%。`);
  const cs = a.cycles;
  if (cs.length) {
    const leads = cs.map((c) => c.leadMonths).sort((x, y) => x - y);
    const med = leads[leads.length >> 1]!;
    const dds = cs.map((c) => c.ddAtKnown);
    out.push(
      `${cs.length} 次營收循環高點中，${name}股價有 ${cs.filter((c) => c.leadMonths > 0).length} 次先見頂，領先中位數 ${med} 個月；等營收高點「公布」時，股價平均已從高點回落 ${p0(dds.reduce((s, x) => s + x, 0) / dds.length)}。`,
    );
  }
  return out;
}

interface Props {
  version: string;
  themeKey: string;
}

export function ShippingPanel({ version, themeKey }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const near = useNearViewport(sectionRef);
  const [stock, setStock] = useState<ShipKey>(() => loadPref<ShipKey>('sh-stock', KEYS, 'emc'));
  const [range, setRange] = useState<RangeKey>(() => loadPref<RangeKey>('sh-range', ['3M', '6M', '1Y', '5Y', 'ALL'], '1Y'));
  const [resetKey, setResetKey] = useState(0);
  const [hoverTime, setHoverTime] = useState<string | null>(null);
  const [chartGen, setChartGen] = useState(0);
  const [open, setOpen] = useState(false);

  const ids = useMemo(() => ['scfi', `${stock}_adj`, `${stock}_rev`], [stock]);
  const files = useSeriesMap(near ? ids : [], version);
  const get = (id: string): Bar[] => (files[id]?.status === 'ready' ? files[id]!.data.data : []);
  const scfi = get('scfi');
  const px = get(`${stock}_adj`);
  const rev = get(`${stock}_rev`);
  const ready = ids.every((id) => files[id]?.status === 'ready');
  const meta = SHIP_STOCKS.find((s) => s.key === stock)!;
  const a = useMemo(() => (ready ? analyzeShipping(scfi, px, rev, meta.revFrom) : null), [ready, scfi, px, rev, meta.revFrom]);

  const pickStock = (k: ShipKey) => {
    setStock(k);
    savePref('sh-stock', k);
  };
  const pickRange = (r: RangeKey) => {
    setRange(r);
    savePref('sh-range', r);
  };

  // 圖表：上＝還原股價＋季線／年線；中＝SCFI；下＝月營收（依年增率上色）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !a || px.length === 0) return;
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
    const f1 = { type: 'price' as const, precision: 1, minMove: 0.1 };
    const f0 = { type: 'price' as const, precision: 0, minMove: 1 };
    const closes = px.map((b) => b[4]);
    const priceS = chart.addSeries(LineSeries, { color: cssVar('--text-1'), lineWidth: 2, priceFormat: f1, lastValueVisible: true }, 0);
    priceS.setData(px.map((b) => ({ time: b[0] as Time, value: b[4] })));
    const maLine = (n: number, color: string) => {
      const vals = sma(closes, n);
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, priceFormat: f1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }, 0);
      s.setData(px.flatMap((b, i) => (vals[i] == null ? [] : [{ time: b[0] as Time, value: vals[i]! }])));
    };
    maLine(60, cssVar('--ma60'));
    maLine(240, cssVar('--ma240'));

    const scfiS = chart.addSeries(
      LineSeries,
      { color: cssVar('--accent'), lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 2, priceFormat: f0, lastValueVisible: true, priceLineVisible: false },
      1,
    );
    // 2026 以前是 Wayback 存檔拼出的稀疏點：間隔 > 21 天就斷線（插入空白點），只畫點不連線，避免看起來像連續走勢
    const scfiData: ({ time: Time; value: number } | { time: Time })[] = [];
    scfi.forEach((b, i) => {
      const prev = scfi[i - 1];
      if (prev && daysBetween(prev[0], b[0]) > SCFI_GAP_DAYS) scfiData.push({ time: addDays(prev[0], 1) as Time });
      scfiData.push({ time: b[0] as Time, value: b[4] });
    });
    scfiS.setData(scfiData);
    if (a.scfi) {
      scfiS.createPriceLine({ price: a.scfi.high * (1 + SCFI_DD_PCT / 100), color: cssVar('--lamp-red'), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${SCFI_DD_PCT}%` });
    }

    const up = cssVar('--up');
    const down = cssVar('--down');
    const revS = chart.addSeries(HistogramSeries, { priceFormat: f0, priceLineVisible: false, lastValueVisible: false }, 2);
    revS.setData(a.revRows.map((r) => ({ time: r.date as Time, value: r.value, color: r.yoy == null ? textColor : r.yoy >= 0 ? up : down })));

    const wm = (paneIndex: number, text: string) => {
      const pane = chart.panes()[paneIndex];
      if (pane) createTextWatermark(pane, { horzAlign: 'left', vertAlign: 'top', lines: [{ text, color: textColor, fontSize: 12, fontFamily, fontStyle: '' }] });
    };
    wm(0, `${meta.name}還原股價｜季線、年線`);
    wm(1, `SCFI 綜合｜2026 前為存檔稀疏點｜紅虛線＝${SCFI_HIGH_WEEKS} 週高點 ${SCFI_DD_PCT}%`);
    wm(2, '月營收（億）｜紅綠＝年增正負');

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
  }, [a, px, scfi, meta.name, themeKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const last = px.at(-1);
    if (!chart || !last) return;
    const start = rangeStart(last[0], range);
    const apply = () => {
      resetPriceScales(chart);
      resetPaneStretch(chart, PANE_STRETCH);
      if (!start || start <= px[0]![0]) chart.timeScale().fitContent();
      else chart.timeScale().setVisibleRange({ from: start as Time, to: last[0] as Time });
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [chartGen, range, resetKey, px]);

  // 圖例：十字線所在日期（沒有時顯示最新）
  const legend = useMemo(() => {
    if (!a || px.length === 0) return null;
    const d = hoverTime ?? px.at(-1)![0];
    const i = idxAtOrBefore(px, d);
    const s = idxAtOrBefore(scfi, d);
    const r = a.revRows.filter((x) => x.date <= d).at(-1) ?? null;
    return { date: px[Math.max(0, i)]![0], close: i >= 0 ? px[i]![4] : null, scfi: s >= 0 ? scfi[s]! : null, rev: r };
  }, [a, hoverTime, px, scfi]);

  const failed = ids.flatMap((id) => (files[id]?.status === 'error' ? [`${id}：${(files[id] as { error: string }).error}`] : []));
  const v = a?.verdict;

  return (
    <section ref={sectionRef} id="sec-sh" className="regime ms sh" aria-label="航運景氣">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">航運景氣（參考）</span>
        </div>
        {a?.scfi && <span className="small muted num">SCFI {a.scfi.date}</span>}
      </div>

      <div className="seg" role="group" aria-label="選擇個股">
        {SHIP_STOCKS.map((s) => (
          <button key={s.key} type="button" aria-pressed={stock === s.key} onClick={() => pickStock(s.key)}>
            {s.name} {s.code}
          </button>
        ))}
      </div>

      {a && v && (
        <>
          <p className="score num cr-verdict">
            <Lamp color={VERDICT_COLOR[v.verdict]} />
            <b>
              {meta.name}：{VERDICT_TEXT[v.verdict]}
            </b>{' '}
            <span className="muted small">
              （{v.on}／{v.known} 項亮燈；出現 2 項＝減碼訊號）
            </span>
          </p>
          <ul className="sh-sigs small num" aria-label="轉空訊號">
            {a.signals.map((s) => (
              <li key={s.key}>
                <Lamp color={s.on === null ? '--text-3' : s.on ? '--lamp-red' : '--lamp-green'} />
                <span className={s.on ? 'warn' : ''}>{s.label}</span>
                <span className="muted">：{s.detail}</span>
              </li>
            ))}
            <li className="muted">
              <Lamp color="--border" />
              未自動判斷：外資連續大賣、紅海全面復航新聞、11 月美線漲價是否落地（美西線分航線運價官網要登入）
            </li>
          </ul>
        </>
      )}

      <PanelNote>
        <div className="small muted ms-rule">
          <p>
            轉空訊號（4 項自動、出現 2 項就減碼）：① SCFI 連跌 ≥ {SCFI_DOWN_WEEKS} 週；② SCFI 距近 {SCFI_HIGH_WEEKS} 週高點 ≤ {SCFI_DD_PCT}%（圖中紅虛線）；③ 最新月營收月減 ≥{' '}
            {Math.abs(REV_MOM_PCT)}%（2 月工作天少，季節性月減要打折看）；④ 還原股價跌破季線（MA60）且季線 {MA_SLOPE_DAYS} 日下彎。
          </p>
          <p>
            回測只用月營收＋還原股價（2005 起）：運價會先反映在營收，月營收有 20 年歷史；SCFI 官網的多期、指定日期查詢都要登入，免費只公布最新兩期，所以 SCFI 只看「目前狀態」：2026-01 起是每週完整資料（第三方每週存下的官方數值，已與新聞核對），之後每週自動累積；2026 以前是 Wayback Machine 存檔的官方頁面拼出的稀疏點（每個存檔有本期＋上期，一年約十幾個點，間隔超過 3 週就斷線），只能看大致位置，不拿來回測。營收 M 月於 M+1 月 10 日前公布，回測以 11 日後第一個交易日進場，不偷看。長榮 2012 年以前公布的是母公司營收（每月約 13 億，2013 起改合併營收約 118 億），所以長榮的營收從 2013 起算、回測從 2014 起。
          </p>
          <p>
            資料：上海航運交易所 SCFI（綜合指數）、FinMind 月營收（公開資訊觀測站）、Yahoo 還原股價（除權息還原；長榮 2022–2023 配 45、70 元，不還原會把除息當成暴跌）。參考、不計分。
          </p>
        </div>
      </PanelNote>

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

      {!near || (!a && failed.length === 0) ? (
        <p className="cp-msg muted">載入中…</p>
      ) : !a ? (
        <p className="cp-msg warn">無法載入航運資料</p>
      ) : (
        <>
          <div className="pricechart ms-chart">
            {legend && (
              <div className="legend num cm-legend" aria-live="off">
                <div>
                  <span className="muted">{legend.date}</span> {meta.name} <b>{legend.close === null ? '—' : legend.close.toFixed(1)}</b>
                  {legend.scfi && (
                    <>
                      {' '}
                      ｜ SCFI <b>{n0(legend.scfi[4])}</b> <span className="muted">（{md(legend.scfi[0])}）</span>
                    </>
                  )}
                </div>
                {legend.rev && (
                  <div className="muted">
                    {ym(legend.rev.date)} 營收 {legend.rev.value.toFixed(1)} 億｜年增 <span className={sign(legend.rev.yoy)}>{p1(legend.rev.yoy)}</span>｜近 3 月年增{' '}
                    {p1(legend.rev.yoy3)}
                  </div>
                )}
              </div>
            )}
            <div ref={hostRef} className="chart-host sh-host" />
          </div>
          <ShipBacktest a={a} name={meta.name} open={open} setOpen={setOpen} />
        </>
      )}
    </section>
  );
}

function ShipBacktest({ a, name, open, setOpen }: { a: ShippingAnalysis; name: string; open: boolean; setOpen: (v: boolean) => void }) {
  const lastRev = a.revRows.at(-1);
  const nowRow = a.yoy.rows.find((r) => r.key === a.nowYoyBucket);
  const nowPos = a.position.find((r) => r.key === a.nowPosBucket);
  return (
    <div className="cr" aria-label="航運回測">
      <p className="score num cr-verdict">
        <span className="muted small">🚢 {name}：月營收 vs 還原股價（回測 {a.obs[0]?.month.slice(0, 4) ?? '—'} 起・參考、不計分）</span>
      </p>
      {lastRev && nowRow && (
        <p className="small num btc-now">
          目前：{ym(lastRev.date)} 近 3 月營收年增 <b className={sign(lastRev.yoy3)}>{p1(lastRev.yoy3)}</b>（{nowRow.label}）
          {nowPos && <>、{nowPos.label}</>} → 歷史同組公布後報酬中位數：6 個月 <b className={sign(nowRow.h.m6.med)}>{p0(nowRow.h.m6.med)}</b>、12 個月{' '}
          <b className={sign(nowRow.h.m12.med)}>{p0(nowRow.h.m12.med)}</b>（12 個月上漲機率 {nowRow.h.m12.up?.toFixed(0) ?? '—'}%，n={nowRow.h.m12.n}）
        </p>
      )}
      <ul className="small btc-find">
        {findings(a, name).map((t) => (
          <li key={t.slice(0, 8)}>{t}</li>
        ))}
      </ul>
      <button type="button" className="linkbtn small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起' : '展開'}回測表（營收年增分組、營收位置、循環高點）
      </button>
      {open && <ShipTables a={a} />}
    </div>
  );
}

function BucketTable({ caption, rows, base, now }: { caption: string; rows: BucketRow[]; base?: BucketRow; now: string | null }) {
  const all = base ? [...rows, base] : rows;
  return (
    <div className="table-wrap">
      <table className="bt-table num">
        <caption className="small muted">{caption}</caption>
        <thead>
          <tr>
            <th>條件</th>
            {HORIZONS.map((h) => (
              <th key={h.key} className="r">
                {h.label}
              </th>
            ))}
            <th className="r">上漲(12M)</th>
            <th className="r">月數</th>
          </tr>
        </thead>
        <tbody>
          {all.map((r) => (
            <tr key={r.key} className={r.key === 'all' ? 'all' : r.key === now ? 'hl' : ''}>
              <td className="nw">
                {r.label}
                {r.key === now && <span className="small"> ◀ 目前</span>}
              </td>
              {HORIZONS.map((h) => (
                <td key={h.key} className={`r ${sign(r.h[h.key].med)}`}>
                  {p0(r.h[h.key].med)}
                </td>
              ))}
              <td className="r">{r.h.m12.up === null ? '—' : `${r.h.m12.up.toFixed(0)}%`}</td>
              <td className="r">{r.h.m3.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShipTables({ a }: { a: ShippingAnalysis }) {
  return (
    <>
      <BucketTable
        caption="① 近 3 個月營收年增率分組 → 公布後買進持有的還原報酬（中位數；平均數被 2020–21 超級循環的幾倍漲幅拉高，不用）。相鄰月份互相重疊，月數不等於獨立樣本數"
        rows={a.yoy.rows}
        base={a.yoy.base}
        now={a.nowYoyBucket}
      />
      <BucketTable caption="② 營收位置（3 個月平均相對近 24 個月高點）→ 公布後報酬（中位數）" rows={a.position} now={a.nowPosBucket} />
      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">
            ③ 營收循環高點（3 個月平均為前後 12 個月最高、比前 24 個月低點高 ≥ {CYCLE_MIN_RISE}%）vs 股價頂（營收高點前 24 個月到後 6 個月內）。領先＝股價比營收早幾個月見頂；公布時＝營收高點公布時股價距頂點；後12M＝公布後 12 個月報酬
          </caption>
          <thead>
            <tr>
              <th>營收高點</th>
              <th className="r">漲幅</th>
              <th>股價頂</th>
              <th className="r">領先</th>
              <th className="r">公布時</th>
              <th className="r">後12M</th>
            </tr>
          </thead>
          <tbody>
            {a.cycles.map((c) => (
              <tr key={c.revPeak}>
                <td className="nw">{c.revPeak.replace('-', '/')}</td>
                <td className="r">{p0(c.revRise)}</td>
                <td className="nw">{c.stockPeak.slice(0, 7).replace('-', '/')}</td>
                <td className="r">{c.leadMonths > 0 ? `${c.leadMonths}月` : c.leadMonths < 0 ? `落後${-c.leadMonths}` : '同月'}</td>
                <td className={`r ${sign(c.ddAtKnown)}`}>{p0(c.ddAtKnown)}</td>
                <td className={`r ${sign(c.after12)}`}>{c.after12 === null ? '—' : p0(c.after12)}</td>
              </tr>
            ))}
            {a.cycles.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  沒有符合條件的循環高點
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        限制：樣本內結果；貨櫃航運 20 年只有幾次大循環（2010、2021–22、2024），每組月份彼此重疊，數字是方向參考不是勝率保證。營收高點要等「之後幾個月沒再創高」才確認，即時判斷時看不到，所以表 ③ 的「公布時」是事後回看。
      </p>
    </>
  );
}
