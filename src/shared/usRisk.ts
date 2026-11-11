import { addDays, daysBetween } from './dates';
import type { Bar } from './types';

/**
 * 美股風險溫度面板（參考、不計分）：四個日頻／週頻指標看美股目前的「風險狀態」，不是預測點位。
 *
 * 1. 信用壓力：高收益債利差（HY OAS）。FRED 只給近 3 年 → 目前讀數用 HY，回測用 Baa−10Y 代理（1986 起）
 * 2. 波動結構：VIX ÷ VIX3M，> 1（逆價差）＝市場搶短期保護
 * 3. 市場廣度：RSP ÷ SPY（等權重 ÷ 市值加權），S&P 500 創 60 日高但比值創 60 日低＝頂部背離
 * 4. 淨流動性：Fed 總資產 − TGA − RRP，4 週減少 ≥ 1,000 億美元＝估值逆風
 *
 * 回測：逐日重算四個燈號，統計亮燈／沒亮之後 20、60 個交易日的 S&P 500 報酬（另附加權指數 60 日）。
 * 防偷看：信用利差隔天才公布 → 用前一個交易日的值；Fed 週三資料週四公布 → 延後 2 天才算可用。
 */

/** 資料起點（VIX3M 2007-12 起）；刻意包含 2008 金融海嘯 */
export const RISK_START = '2008-01-01';
/** 分段點（與網站其他回測一致） */
export const RISK_SPLIT = '2018-01-01';

/** HY OAS（%）：目前讀數用 */
export const HY_WARN = 5;
export const HY_PANIC = 8;
export const HY_WIDEN_20D = 1;
/** Baa−10Y（pp）：回測代理。HY 5% ≈ Baa 2.5、HY 8% ≈ Baa 3.5（與降息性質判定同一組門檻），20 日擴大 1pp ≈ 0.3pp */
export const BAA_WARN = 2.5;
export const BAA_PANIC = 3.5;
export const BAA_WIDEN_20D = 0.3;
/** VIX ÷ VIX3M */
export const VOL_INVERT = 1;
export const VOL_CALM = 0.85;
/** 廣度背離：S&P 500 近 RECENT 日內創 WIN 日收盤新高，且 RSP÷SPY 近 RECENT 日內創 WIN 日新低 */
export const BREADTH_WIN = 60;
export const BREADTH_RECENT = 10;
/** 淨流動性 4 週變化門檻（十億美元）；1,000 億美元＝100 */
export const LIQ_4W = 100;
/** Fed 週三資料週四傍晚公布：延後 2 天才算可用 */
export const LIQ_LAG_DAYS = 2;
/** 同一波：兩次亮燈間隔不到這麼多個交易日算同一次 */
export const EPISODE_GAP = 20;

export const RISK_KEYS = ['credit', 'vol', 'breadth', 'liq'] as const;
export type RiskKey = (typeof RISK_KEYS)[number];

export const RISK_LABEL: Record<RiskKey, string> = {
  credit: '信用壓力',
  vol: '波動結構',
  breadth: '市場廣度',
  liq: '淨流動性',
};

export interface RiskInputs {
  spx: readonly Bar[];
  vix: readonly Bar[];
  vix3m: readonly Bar[];
  rsp: readonly Bar[];
  spy: readonly Bar[];
  baa: readonly Bar[];
  hy: readonly Bar[];
  walcl: readonly Bar[];
  tga: readonly Bar[];
  rrp: readonly Bar[];
  /** 加權指數（回測附帶看台股；可空） */
  taiex: readonly Bar[];
}

export interface RiskRow {
  date: string;
  spx: number;
  /** HY OAS（%），近 3 年才有 */
  hy: number | null;
  hyChg20: number | null;
  /** Baa−10Y（pp） */
  baa: number | null;
  baaChg20: number | null;
  vix: number | null;
  vix3m: number | null;
  volRatio: number | null;
  /** RSP ÷ SPY × 100 */
  breadth: number | null;
  /** S&P 500 近 10 日內創 60 日收盤新高 */
  spxHigh: boolean;
  /** RSP÷SPY 近 10 日內創 60 日新低 */
  breadthLow: boolean | null;
  /** 淨流動性（十億美元）與它的資料日（週三） */
  netLiq: number | null;
  liqChg4w: number | null;
  liqDate: string | null;
  /** 回測用燈號（信用用 Baa−10Y 代理、前一個交易日的值）；資料不足為 null */
  lit: Record<RiskKey, boolean | null>;
  /** 四項都有資料時的亮燈數 */
  count: number | null;
}

const fin = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** 對每個 dates[i]，取 bars 中日期 ≤ dates[i]（且不超過 maxStale 天前）的最後一筆收盤 */
export function alignAsOf(dates: readonly string[], bars: readonly Bar[], maxStale: number): (number | null)[] {
  const out: (number | null)[] = [];
  let j = -1;
  for (const d of dates) {
    while (j + 1 < bars.length && bars[j + 1]![0] <= d) j++;
    out.push(j >= 0 && daysBetween(bars[j]![0], d) <= maxStale ? bars[j]![4] : null);
  }
  return out;
}

export interface LiqWeek {
  date: string;
  /** 十億美元 */
  net: number;
  chg4w: number | null;
}

/** 每週三一筆：Fed 總資產 − TGA（皆百萬美元）− RRP（十億美元），換成十億美元；4 週變化＝與 4 期前相減 */
export function liquidityWeeks(walcl: readonly Bar[], tga: readonly Bar[], rrp: readonly Bar[]): LiqWeek[] {
  const dates = walcl.map((b) => b[0]);
  const tgaAt = alignAsOf(dates, tga, 7);
  // 2013 年以前逆回購只有零星操作：沒有資料就當 0
  const rrpAt = alignAsOf(dates, rrp, 10);
  const out: LiqWeek[] = [];
  walcl.forEach((b, i) => {
    const t = tgaAt[i];
    if (!fin(t)) return;
    out.push({ date: b[0], net: (b[4] - t) / 1000 - (rrpAt[i] ?? 0), chg4w: null });
  });
  for (let i = 4; i < out.length; i++) {
    const gap = daysBetween(out[i - 4]!.date, out[i]!.date);
    if (gap >= 21 && gap <= 35) out[i]!.chg4w = out[i]!.net - out[i - 4]!.net;
  }
  return out;
}

/** 回測用信用燈（Baa−10Y 代理） */
export function creditProxyLit(baa: number | null, chg20: number | null): boolean | null {
  if (!fin(baa)) return null;
  return baa >= BAA_WARN || (fin(chg20) && chg20 >= BAA_WIDEN_20D);
}

export function buildRiskRows(inp: RiskInputs): RiskRow[] {
  const spx = inp.spx.filter((b) => b[0] >= RISK_START);
  const dates = spx.map((b) => b[0]);
  const close = spx.map((b) => b[4]);
  const hy = alignAsOf(dates, inp.hy, 7);
  const baa = alignAsOf(dates, inp.baa, 7);
  const vix = alignAsOf(dates, inp.vix, 5);
  const vix3m = alignAsOf(dates, inp.vix3m, 5);
  const rsp = alignAsOf(dates, inp.rsp, 5);
  const spy = alignAsOf(dates, inp.spy, 5);
  const weeks = liquidityWeeks(inp.walcl, inp.tga, inp.rrp);
  const breadth = dates.map((_, i) => (fin(rsp[i]) && fin(spy[i]) && spy[i]! > 0 ? (rsp[i]! / spy[i]!) * 100 : null));

  /** 近 RECENT 日內是否出現 WIN 日極值（hi=true 取最高） */
  const recentExtreme = (vals: readonly (number | null)[], i: number, hi: boolean): boolean | null => {
    if (i < BREADTH_WIN - 1) return null;
    let ext = hi ? -Infinity : Infinity;
    let at = -1;
    for (let k = i - BREADTH_WIN + 1; k <= i; k++) {
      const v = vals[k];
      if (!fin(v)) return null;
      // 平手取最早的一根：持平不算「創新高／新低」
      if (hi ? v > ext : v < ext) {
        ext = v;
        at = k;
      }
    }
    return i - at < BREADTH_RECENT;
  };

  const rows: RiskRow[] = [];
  let w = -1;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]!;
    const usable = addDays(d, -LIQ_LAG_DAYS);
    while (w + 1 < weeks.length && weeks[w + 1]!.date <= usable) w++;
    const wk = w >= 0 && daysBetween(weeks[w]!.date, d) <= 16 ? weeks[w]! : null;
    const chg = (vals: readonly (number | null)[], at: number) => (at >= 20 && fin(vals[at]) && fin(vals[at - 20]) ? vals[at]! - vals[at - 20]! : null);
    const volRatio = fin(vix[i]) && fin(vix3m[i]) && vix3m[i]! > 0 ? vix[i]! / vix3m[i]! : null;
    const spxHigh = recentExtreme(close, i, true) === true;
    const breadthLow = recentExtreme(breadth, i, false);
    const lit: Record<RiskKey, boolean | null> = {
      // 信用利差隔天才公布：用前一個交易日的值
      credit: i >= 1 ? creditProxyLit(baa[i - 1] ?? null, chg(baa, i - 1)) : null,
      vol: fin(volRatio) ? volRatio > VOL_INVERT : null,
      breadth: breadthLow === null || i < BREADTH_WIN - 1 ? null : spxHigh && breadthLow,
      liq: wk && fin(wk.chg4w) ? wk.chg4w <= -LIQ_4W : null,
    };
    const known = RISK_KEYS.every((k) => lit[k] !== null);
    rows.push({
      date: d,
      spx: close[i]!,
      hy: hy[i] ?? null,
      hyChg20: chg(hy, i),
      baa: baa[i] ?? null,
      baaChg20: chg(baa, i),
      vix: vix[i] ?? null,
      vix3m: vix3m[i] ?? null,
      volRatio,
      breadth: breadth[i] ?? null,
      spxHigh,
      breadthLow,
      netLiq: wk?.net ?? null,
      liqChg4w: wk?.chg4w ?? null,
      liqDate: wk?.date ?? null,
      lit,
      count: known ? RISK_KEYS.filter((k) => lit[k]).length : null,
    });
  }
  return rows;
}

// ───────────────────────── 目前狀態 ─────────────────────────

export type RiskLevel = 'ok' | 'warn' | 'panic';

export interface RiskSignal {
  key: RiskKey;
  label: string;
  /** null＝資料不足 */
  lit: boolean | null;
  level: RiskLevel | null;
  detail: string;
}

export type RiskVerdict = 'calm' | 'watch' | 'alert';
export const VERDICT_TEXT: Record<RiskVerdict, string> = { calm: '正常', watch: '留意', alert: '警戒' };
export const VERDICT_COLOR: Record<RiskVerdict, string> = { calm: '--lamp-green', watch: '--lamp-yellowred', alert: '--lamp-red' };

const sgn = (v: number, d: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
const int = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.round(Math.abs(v)).toLocaleString('en-US')}`;

/** 目前四個燈號：信用優先用 HY OAS，沒有才退回 Baa−10Y 代理 */
export function riskSignals(row: RiskRow | undefined): RiskSignal[] {
  const out: RiskSignal[] = [];
  const push = (key: RiskKey, lit: boolean | null, level: RiskLevel | null, detail: string) => out.push({ key, label: RISK_LABEL[key], lit, level, detail });

  if (row && fin(row.hy)) {
    const widen = fin(row.hyChg20) && row.hyChg20 >= HY_WIDEN_20D;
    const level: RiskLevel = row.hy >= HY_PANIC ? 'panic' : row.hy >= HY_WARN || widen ? 'warn' : 'ok';
    const tag = row.hy >= HY_PANIC ? `≥ ${HY_PANIC}% 恐慌` : row.hy >= HY_WARN ? `≥ ${HY_WARN}% 警戒` : widen ? '快速擴大，去槓桿' : `< ${HY_WARN}% 正常`;
    push('credit', level !== 'ok', level, `高收益債利差 ${row.hy.toFixed(2)}%${fin(row.hyChg20) ? `（20 日 ${sgn(row.hyChg20, 2)}pp）` : ''} → ${tag}`);
  } else if (row && fin(row.baa)) {
    const widen = fin(row.baaChg20) && row.baaChg20 >= BAA_WIDEN_20D;
    const level: RiskLevel = row.baa >= BAA_PANIC ? 'panic' : row.baa >= BAA_WARN || widen ? 'warn' : 'ok';
    push('credit', level !== 'ok', level, `Baa−10Y ${row.baa.toFixed(2)}pp${fin(row.baaChg20) ? `（20 日 ${sgn(row.baaChg20, 2)}pp）` : ''} → ${level === 'ok' ? '正常' : level === 'panic' ? '恐慌' : '警戒'}`);
  } else push('credit', null, null, '資料不足');

  if (row && fin(row.volRatio)) {
    const inv = row.volRatio > VOL_INVERT;
    const tag = inv ? '> 1 逆價差，恐慌拋售' : row.volRatio < VOL_CALM ? `< ${VOL_CALM} 過度安逸（不亮燈）` : '正價差，正常';
    push('vol', inv, inv ? 'panic' : 'ok', `VIX ÷ VIX3M ${row.volRatio.toFixed(2)}（${row.vix!.toFixed(1)}／${row.vix3m!.toFixed(1)}）→ ${tag}`);
  } else push('vol', null, null, '資料不足');

  if (row && row.breadthLow !== null && fin(row.breadth)) {
    const lit = row.spxHigh && row.breadthLow;
    const tag = lit ? '指數創高、比值創低 → 頂部背離' : row.breadthLow ? '比值創 60 日低，但指數沒創高 → 不算背離' : row.spxHigh ? '指數創高、比值沒創低 → 漲勢有擴散' : '沒有背離';
    push('breadth', lit, lit ? 'warn' : 'ok', `RSP ÷ SPY ${row.breadth.toFixed(1)}｜${tag}`);
  } else push('breadth', null, null, '資料不足');

  if (row && fin(row.netLiq) && fin(row.liqChg4w)) {
    const lit = row.liqChg4w <= -LIQ_4W;
    const tag = lit ? '4 週減少逾 1,000 億，估值逆風' : row.liqChg4w >= LIQ_4W ? '4 週增加逾 1,000 億，順風' : '變化不大';
    push('liq', lit, lit ? 'warn' : 'ok', `${(row.netLiq / 1000).toFixed(2)} 兆美元（4 週 ${int(row.liqChg4w * 10)} 億）→ ${tag}`);
  } else push('liq', null, null, '資料不足');
  return out;
}

export function riskVerdict(signals: readonly RiskSignal[]): { verdict: RiskVerdict; on: number; known: number } {
  const known = signals.filter((s) => s.lit !== null).length;
  const on = signals.filter((s) => s.lit).length;
  return { verdict: on >= 2 ? 'alert' : on === 1 ? 'watch' : 'calm', on, known };
}

// ───────────────────────── 回測 ─────────────────────────

export interface RiskBucket {
  days: number;
  /** 占該期間有資料天數的比例（%） */
  pct: number;
  /** 幾波（間隔不到 20 個交易日算同一波） */
  episodes: number;
  /** 之後 20／60 個交易日 S&P 500 平均報酬（%） */
  avg20: number | null;
  avg60: number | null;
  /** 60 日上漲機率（%） */
  win60: number | null;
  /** 60 日報酬第 10 百分位（最差的一成有多差） */
  p10: number | null;
  /** 之後 60 個台股交易日加權指數平均報酬（%） */
  tw60: number | null;
}

export type RiskPeriod = 'full' | 'early' | 'late';
export const RISK_PERIODS: readonly RiskPeriod[] = ['full', 'early', 'late'];

export type SignalVerdict = 'weaker' | 'stronger' | 'none' | 'few';

export interface SignalBacktest {
  key: RiskKey;
  label: string;
  on: Record<RiskPeriod, RiskBucket>;
  off: Record<RiskPeriod, RiskBucket>;
  /** 亮燈後 60 日 − 全部日子 60 日（百分點） */
  edge: Record<RiskPeriod, number | null>;
  verdict: SignalVerdict;
}

export interface RiskBacktest {
  start: string;
  end: string;
  split: string;
  all: Record<RiskPeriod, RiskBucket>;
  signals: SignalBacktest[];
  /** 亮燈數 0／1／≥2 */
  count: { key: 'c0' | 'c1' | 'c2'; label: string; b: Record<RiskPeriod, RiskBucket> }[];
}

/** 判定門檻：亮燈後 60 日報酬與全部日子差 ≥ 1 個百分點，全期、前段、後段同方向，且至少 5 波 */
export const EDGE_MIN = 1;
export const EPISODES_MIN = 5;

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** 加權指數：美股日期 d 的收盤，台股要到下一個交易日才能反應 → 以第一個日期 > d 的台股收盤進場，持有 60 個台股交易日 */
export function taiexForward(dates: readonly string[], taiex: readonly Bar[], horizon = 60): (number | null)[] {
  const out: (number | null)[] = [];
  let j = 0;
  for (const d of dates) {
    while (j < taiex.length && taiex[j]![0] <= d) j++;
    const a = taiex[j];
    const b = taiex[j + horizon];
    out.push(a && b && daysBetween(d, a[0]) <= 10 ? (b[4] / a[4] - 1) * 100 : null);
  }
  return out;
}

export function backtestRisk(rows: readonly RiskRow[], taiex: readonly Bar[] = []): RiskBacktest | null {
  if (rows.length < 300) return null;
  const n = rows.length;
  const fwd = (h: number) => rows.map((r, i) => (i + h < n ? (rows[i + h]!.spx / r.spx - 1) * 100 : null));
  const f20 = fwd(20);
  const f60 = fwd(60);
  const tw = taiexForward(rows.map((r) => r.date), taiex);
  const inPeriod = (p: RiskPeriod, d: string) => (p === 'full' ? true : p === 'early' ? d < RISK_SPLIT : d >= RISK_SPLIT);

  const bucket = (sel: (r: RiskRow) => boolean | null, p: RiskPeriod): RiskBucket => {
    let days = 0;
    let base = 0;
    let episodes = 0;
    let lastOn = -Infinity;
    const a20: number[] = [];
    const a60: number[] = [];
    const t60: number[] = [];
    rows.forEach((r, i) => {
      if (!inPeriod(p, r.date)) return;
      const s = sel(r);
      if (s === null) return;
      base++;
      if (!s) return;
      days++;
      if (i - lastOn > EPISODE_GAP) episodes++;
      lastOn = i;
      if (fin(f20[i])) a20.push(f20[i]!);
      if (fin(f60[i])) a60.push(f60[i]!);
      if (fin(tw[i])) t60.push(tw[i]!);
    });
    return {
      days,
      pct: base ? (days / base) * 100 : 0,
      episodes,
      avg20: mean(a20),
      avg60: mean(a60),
      win60: a60.length ? (a60.filter((x) => x > 0).length / a60.length) * 100 : null,
      p10: quantile(a60, 0.1),
      tw60: mean(t60),
    };
  };
  const per = (sel: (r: RiskRow) => boolean | null): Record<RiskPeriod, RiskBucket> => ({ full: bucket(sel, 'full'), early: bucket(sel, 'early'), late: bucket(sel, 'late') });

  const all = per(() => true);
  const signals: SignalBacktest[] = RISK_KEYS.map((key) => {
    const on = per((r) => r.lit[key]);
    const off = per((r) => (r.lit[key] === null ? null : !r.lit[key]));
    const edge = Object.fromEntries(
      RISK_PERIODS.map((p) => [p, fin(on[p].avg60) && fin(all[p].avg60) ? on[p].avg60! - all[p].avg60! : null]),
    ) as Record<RiskPeriod, number | null>;
    const es = RISK_PERIODS.map((p) => edge[p]);
    const verdict: SignalVerdict =
      on.full.episodes < EPISODES_MIN || es.some((e) => !fin(e))
        ? 'few'
        : es.every((e) => e! <= -EDGE_MIN)
          ? 'weaker'
          : es.every((e) => e! >= EDGE_MIN)
            ? 'stronger'
            : 'none';
    return { key, label: RISK_LABEL[key], on, off, edge, verdict };
  });
  const count = [
    { key: 'c0' as const, label: '0 項亮燈', b: per((r) => (r.count === null ? null : r.count === 0)) },
    { key: 'c1' as const, label: '1 項亮燈', b: per((r) => (r.count === null ? null : r.count === 1)) },
    { key: 'c2' as const, label: '≥ 2 項亮燈', b: per((r) => (r.count === null ? null : r.count >= 2)) },
  ];
  return { start: rows[0]!.date, end: rows.at(-1)!.date, split: RISK_SPLIT, all, signals, count };
}

export const SIGNAL_VERDICT_TEXT: Record<SignalVerdict, string> = {
  weaker: '亮燈後偏弱（前後段一致）',
  stronger: '亮燈後反而偏強（前後段一致）',
  none: '沒有穩定差異',
  few: '樣本太少',
};

export interface RiskAnalysis {
  rows: RiskRow[];
  weeks: LiqWeek[];
  signals: RiskSignal[];
  verdict: { verdict: RiskVerdict; on: number; known: number };
  backtest: RiskBacktest | null;
}

export function analyzeUsRisk(inp: RiskInputs): RiskAnalysis {
  const rows = buildRiskRows(inp);
  const signals = riskSignals(rows.at(-1));
  return {
    rows,
    weeks: liquidityWeeks(inp.walcl, inp.tga, inp.rrp),
    signals,
    verdict: riskVerdict(signals),
    backtest: backtestRisk(rows, inp.taiex),
  };
}
