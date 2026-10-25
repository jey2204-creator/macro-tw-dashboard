import { addDays, parseDate } from './dates';
import type { Bar } from './types';

/**
 * 跨市場對照：把其他市場的 K 棒放到「台股的視角」。
 *
 * - session 'tw'：與台股同時段交易（日經、KOSPI、櫃買、USD/TWD、USD/KRW、USD/JPY），日期直接對應。
 * - session 'us'：台股收盤後才交易（美股、美債、美元、原油），是台股的「前一晚」。
 *   對齊時把日期 d 的 K 棒往後移到第一個 ≥ d+1 的台股交易日，同一直線上才是「台股開盤時看到的那根」。
 */
export type Session = 'tw' | 'us';

export interface CompareSpec {
  id: string;
  session: Session;
  /** 按鈕與窗格名稱（省略時用指標短名） */
  label?: string;
  /**
   * 流量型（外資買賣超）：換算成億美元，窗格畫每日柱＋20 日累計線；不算 ρ、不畫均線。
   * fx＝當地貨幣兌美元的序列；from＝資料來源（指標序列檔，或 foreign-chips.json 的 2010 起歷史）
   */
  flow?: { fx: string; from: 'series' | 'foreignChips' };
  /** 週末也交易（比特幣）：對齊時保留週末 K 棒，併入週一；不對齊時照樣去掉週末 */
  allWeek?: boolean;
}

/** 可選的對照序列（依顯示順序；id 對應指標註冊表） */
export const COMPARE_SERIES: CompareSpec[] = [
  { id: 'tpex', session: 'tw' },
  { id: 'sox', session: 'us' },
  { id: 'nasdaq', session: 'us' },
  { id: 'spx', session: 'us' },
  { id: 'kospi', session: 'tw' },
  { id: 'nikkei', session: 'tw' },
  { id: 'net_foreign', session: 'tw', label: '台外資', flow: { fx: 'usdtwd', from: 'foreignChips' } },
  { id: 'kr_foreign', session: 'tw', label: '韓外資', flow: { fx: 'usdkrw', from: 'series' } },
  { id: 'usdtwd', session: 'tw' },
  { id: 'usdkrw', session: 'tw' },
  { id: 'usdjpy', session: 'tw' },
  { id: 'dxy', session: 'us' },
  { id: 'us10y', session: 'us' },
  { id: 'tlt', session: 'us' },
  { id: 'us2y', session: 'us' },
  { id: 'wti', session: 'us' },
  { id: 'brent', session: 'us' },
  { id: 'gold', session: 'us' },
  { id: 'vix', session: 'us' },
  // 比特幣 UTC 日 K 收盤＝台北隔天 08:00，比照美系往後對齊；週末三根合併到週一＝台股休市期間的漲跌
  { id: 'btc', session: 'us', allWeek: true },
];

/** 預設對照：三個不同資訊來源（前一晚美國半導體、同時段亞股、資金流向），而不是三個最像的 */
export const DEFAULT_COMPARE = ['sox', 'kospi', 'usdtwd'];
/** 手機高度考量：最多同時顯示的對照窗格數（每格約 120px）；已滿時再選會換掉最早選的那個 */
export const MAX_COMPARE = 6;

/** 一鍵切換的組合（每組 ≤ MAX_COMPARE） */
export const COMPARE_PRESETS: { key: string; label: string; ids: string[] }[] = [
  { key: 'equity', label: '股市', ids: ['tpex', 'sox', 'nasdaq', 'kospi', 'nikkei'] },
  { key: 'rates', label: '匯率利率', ids: ['usdtwd', 'dxy', 'us10y', 'tlt', 'us2y'] },
  // 外資有沒有撤出：直接證據（台、韓外資買賣超）＋結果（當地貨幣）＋DXY（同步漲＝全球美元回流，不是針對亞洲）
  { key: 'asia', label: '亞洲資金', ids: ['kospi', 'net_foreign', 'kr_foreign', 'usdtwd', 'usdkrw', 'dxy'] },
  { key: 'hedge', label: '避險', ids: ['gold', 'wti', 'brent', 'vix'] },
];

/** 選取規則：已選的點一下取消；未選的加到最後，已滿 MAX_COMPARE 時換掉最早選的 */
export function toggleCompare(selected: readonly string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  const next = [...selected, id];
  return next.length > MAX_COMPARE ? next.slice(next.length - MAX_COMPARE) : next;
}

export const CORR_WINDOWS = [20, 60] as const;

/** 流量型的累計視窗（交易日） */
export const FLOW_CUM_DAYS = 20;

export const compareLabel = (spec: CompareSpec, short: string | undefined): string => spec.label ?? short ?? spec.id;

/** 已選序列需要載入的序列檔：一般序列本身；流量型另需匯率，來源為 foreign-chips.json 的不載入本身 */
export function compareFetchIds(selected: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of COMPARE_SERIES) {
    if (!selected.includes(s.id)) continue;
    if (!s.flow || s.flow.from === 'series') out.add(s.id);
    if (s.flow) out.add(s.flow.fx);
  }
  return [...out];
}

/**
 * 當地貨幣流量 → 億美元：每天除以當日（沒有則取之前最近一天）的「每 1 美元兌當地貨幣」收盤。
 * 億韓元 ÷ (韓元／美元) ＝ 億美元；匯率起點之前的日子略過。
 */
export function toUsdFlow(flows: readonly Bar[], fx: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let j = -1;
  for (const b of flows) {
    while (j + 1 < fx.length && fx[j + 1]![0] <= b[0]) j++;
    const rate = j >= 0 ? fx[j]![4] : NaN;
    if (!(rate > 0)) continue;
    const v = b[4] / rate;
    out.push([b[0], v, v, v, v]);
  }
  return out;
}

/** 最近 n 筆加總（不足 n 筆為 null） */
export function rollingSum(bars: readonly Bar[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]![4];
    if (i >= n) sum -= bars[i - n]![4];
    out.push(i >= n - 1 ? sum : null);
  }
  return out;
}

/** 下一個平日（跳過週六、日）。台灣假日未知：資料到齊後 alignToTwCalendar 會自動併入實際的下一個交易日 */
export function nextWeekday(date: string): string {
  let d = date;
  for (;;) {
    const dow = new Date(parseDate(d)).getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = addDays(d, 1);
  }
}

/**
 * 去掉週六、日的 K 棒。Yahoo 亞洲匯率（TWD=X、KRW=X）週末抓取時會多一根當日報價（OHLC 常相同），
 * 放進共用時間軸會在加權沒有 K 棒的位置多出一格。
 */
export function dropWeekendBars(bars: Bar[]): Bar[] {
  const isWeekend = (d: string) => {
    const dow = new Date(parseDate(d)).getUTCDay();
    return dow === 0 || dow === 6;
  };
  return bars.some((b) => isWeekend(b[0])) ? bars.filter((b) => !isWeekend(b[0])) : bars;
}

/**
 * 把「台股收盤後才交易」的序列往後對齊到台股下一個交易日。
 * 日期 d 的 K 棒 → 第一個 ≥ d+1 的台股交易日；超出已知台股日期時取下一個平日。
 * 多根落在同一個台股交易日（連假）→ 合併成一根：開＝第一根開、高低取極值、收＝最後一根收。
 * bars 與 twDates 皆須依日期遞增。
 */
export function alignToTwCalendar(bars: readonly Bar[], twDates: readonly string[]): Bar[] {
  const out: Bar[] = [];
  let j = 0;
  for (const b of bars) {
    const minDate = addDays(b[0], 1);
    while (j < twDates.length && twDates[j]! < minDate) j++;
    const target = j < twDates.length ? twDates[j]! : nextWeekday(minDate);
    const last = out.at(-1);
    if (last && last[0] === target) {
      out[out.length - 1] = [target, last[1], Math.max(last[2], b[2]), Math.min(last[3], b[3]), b[4]];
    } else {
      out.push([target, b[1], b[2], b[3], b[4]]);
    }
  }
  return out;
}

/** 皮爾森相關係數；資料不足或任一方無變異時回 null */
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]!;
    sy += y[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** 滾動相關：第 i 筆為最近 n 組（含第 i 組）的相關係數，不足 n 組為 null */
export function rollingCorrelation(x: readonly number[], y: readonly number[], n: number): (number | null)[] {
  const len = Math.min(x.length, y.length);
  const out: (number | null)[] = new Array(len).fill(null);
  for (let i = n - 1; i < len; i++) out[i] = pearson(x.slice(i - n + 1, i + 1), y.slice(i - n + 1, i + 1));
  return out;
}

export interface PairedReturns {
  /** 台股交易日（與 tw 相同順序） */
  dates: string[];
  /** 配對點上的台股對數報酬（自前一個配對點起算）；非配對點為 null */
  tw: (number | null)[];
  /** 配對點上的對照序列對數報酬（同一段期間）；非配對點為 null */
  cmp: (number | null)[];
}

/**
 * 以台股交易日為準配對報酬：
 * 對照序列在每個台股日取「該日（含）之前最後一筆」收盤；有新 K 棒的台股日才是配對點，
 * 兩邊的報酬都從前一個配對點起算（期間相同），所以對照序列缺資料的日子（例如美國假日）不會湊出錯配的報酬。
 * 對 'us' 序列請先 alignToTwCalendar 再傳入，才是「台股看到的」報酬；未對齊則為同日期（美股在台股收盤後才交易）的報酬。
 */
export function pairedReturns(tw: readonly Bar[], cmp: readonly Bar[]): PairedReturns {
  const dates = tw.map((b) => b[0]);
  const twRet: (number | null)[] = new Array(tw.length).fill(null);
  const cmpRet: (number | null)[] = new Array(tw.length).fill(null);
  let k = 0; // cmp 游標：第一個日期 > 目前台股日的 K 棒
  let lastTw = -1; // 前一個配對點的台股索引
  let lastIdx = -1; // 前一個配對點對應的 cmp 索引
  for (let i = 0; i < tw.length; i++) {
    const d = dates[i]!;
    while (k < cmp.length && cmp[k]![0] <= d) k++;
    const idx = k - 1; // ≤ d 的最後一筆
    if (idx < 0) continue; // 對照序列尚無資料
    if (lastTw < 0) {
      lastTw = i;
      lastIdx = idx;
      continue;
    }
    if (idx === lastIdx) continue; // 這段期間沒有新 K 棒
    const a = tw[lastTw]![4];
    const b = tw[i]![4];
    const c0 = cmp[lastIdx]![4];
    const c1 = cmp[idx]![4];
    if (a > 0 && b > 0 && c0 > 0 && c1 > 0) {
      twRet[i] = Math.log(b / a);
      cmpRet[i] = Math.log(c1 / c0);
    }
    lastTw = i;
    lastIdx = idx;
  }
  return { dates, tw: twRet, cmp: cmpRet };
}

export type CorrSeries = Record<(typeof CORR_WINDOWS)[number], (number | null)[]>;

/**
 * 每個台股交易日的 ρ20／ρ60：取最近 n 組有效配對（兩邊皆有報酬）的相關係數。
 * 沒有新配對的日子沿用前一日的值；配對不足 n 組為 null。
 */
export function correlationSeries(p: PairedReturns): CorrSeries {
  const xs: number[] = [];
  const ys: number[] = [];
  const out = Object.fromEntries(CORR_WINDOWS.map((n) => [n, new Array(p.dates.length).fill(null)])) as CorrSeries;
  const latest: Record<number, number | null> = {};
  for (const n of CORR_WINDOWS) latest[n] = null;
  for (let i = 0; i < p.dates.length; i++) {
    const x = p.tw[i];
    const y = p.cmp[i];
    if (x != null && y != null) {
      xs.push(x);
      ys.push(y);
      for (const n of CORR_WINDOWS) {
        if (xs.length >= n) latest[n] = pearson(xs.slice(-n), ys.slice(-n));
      }
    }
    for (const n of CORR_WINDOWS) out[n][i] = latest[n] ?? null;
  }
  return out;
}
