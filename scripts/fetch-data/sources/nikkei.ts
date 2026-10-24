import { addMonths, monthKey } from '../../../src/shared/dates';
import type { SourceSpec } from '../../../src/shared/indicators';
import type { Bar } from '../../../src/shared/types';
import { getText, sleep, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * 日經平均プロフィル（日經指數官網）「ヒストリカルデータ → 日次投資指標」：
 * 株価収益率（PER）、株価純資産倍率（PBR）、配当利回り，日資料、2004-09-30 起，免費、不需登入。
 *
 * 2026-10-24 探測（內建瀏覽器）：頁面以表單 GET 載入
 *   https://indexes.nikkei.co.jp/nkave/statistics/dataload?list=per|pbr|dividend&year=YYYY&month=M
 * 回傳一段 HTML（一個 table，每列「日付｜加重平均(倍)｜指数ベース(倍)」；配当利回り為「単純平均(%)｜指数ベース(%)」）。
 * 一次只能一個月；month 省略時等於當月。沒有資料的月份回「条件に一致する日次指標データはありません」。
 *
 * 定義（ユーザーズ・ガイド）：
 *  - PER 用「日經的預估利益」（今期預想），本決算公布日翌日起切換到下一年度預估 → 這是「預估本益比」，不是近 12 月實績
 *  - 加重平均＝時価総額合計 ÷ 預估利益合計（日經新聞朝刊刊登的值）；指数ベース＝日經平均 ÷ 日經平均 EPS（預估 EPS × 株価換算係数 ÷ 除数）
 *  - PBR 用最近決算（含季報）的實績自己資本
 *
 * 回補：沒有快取時從 2004-09 逐月抓到當月（約 266 個月）；之後每次只抓快取最後日期所在月到當月。
 * 同一次執行內，同一個 list 的同一個月只下載一次（加重平均與指數基準兩個指標共用）。
 */

export type NikkeiSymbol = Extract<SourceSpec, { provider: 'nikkei' }>['symbol'];

export const NIKKEI_FIRST_MONTH = '2004-09-01';
const MIN_INTERVAL_MS = 400;

type NikkeiList = 'per' | 'pbr' | 'dividend';

/** 指標 → 下載清單與欄位（1＝第二欄加重平均／單純平均，2＝第三欄指數基準） */
const SYMBOL_SPEC: Record<NikkeiSymbol, { list: NikkeiList; col: 1 | 2 }> = {
  PER_INDEX: { list: 'per', col: 2 },
  PER_WEIGHTED: { list: 'per', col: 1 },
  PBR_INDEX: { list: 'pbr', col: 2 },
  PBR_WEIGHTED: { list: 'pbr', col: 1 },
  DY_INDEX: { list: 'dividend', col: 2 },
};

export const nikkeiUrl = (list: NikkeiList, year: number, month: number) =>
  `https://indexes.nikkei.co.jp/nkave/statistics/dataload?list=${list}&year=${year}&month=${month}`;

export interface NikkeiRow {
  /** YYYY-MM-DD */
  date: string;
  /** 第二欄：加重平均（PER／PBR）或單純平均（配当利回り） */
  v1: number | null;
  /** 第三欄：指數基準 */
  v2: number | null;
}

const num = (s: string): number | null => {
  const t = s.replace(/[,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

/** 解析 dataload 回傳的 HTML 表格；表頭欄位名稱不同不影響（依位置取） */
export function parseNikkeiTable(html: string): NikkeiRow[] {
  const out: NikkeiRow[] = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  const cellRe = /<td>([\s\S]*?)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const cells: string[] = [];
    let c: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((c = cellRe.exec(m[1]!))) cells.push(c[1]!.replace(/<[^>]*>/g, '').trim());
    if (cells.length < 3) continue;
    const d = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(cells[0]!);
    if (!d) continue;
    out.push({ date: `${d[1]}-${d[2]}-${d[3]}`, v1: num(cells[1]!), v2: num(cells[2]!) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ── 抓取 ─────────────────────────────────────────────────────

let lastRequestAt = 0;
async function throttle(fast: boolean) {
  if (fast) return;
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/** 一次執行內同一（list, 月份）只下載一次 */
const monthCache = new Map<string, Promise<NikkeiRow[]>>();
export function clearNikkeiCache() {
  monthCache.clear();
}

function loadMonth(list: NikkeiList, ym: string, http: HttpOptions, fast: boolean): Promise<NikkeiRow[]> {
  const key = `${list}:${ym}`;
  let p = monthCache.get(key);
  if (!p) {
    p = (async () => {
      await throttle(fast);
      const html = await getText(nikkeiUrl(list, Number(ym.slice(0, 4)), Number(ym.slice(5, 7))), http);
      if (!/<table/i.test(html) && !/データはありません/.test(html)) throw new Error(`日經 ${list} ${ym} 回傳不是資料表格`);
      return parseNikkeiTable(html);
    })();
    monthCache.set(key, p);
    p.catch(() => monthCache.delete(key));
  }
  return p;
}

/** 從 from（YYYY-MM）逐月到 to（YYYY-MM）的月份鍵 */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = `${from}-01`; monthKey(d) <= to; d = addMonths(d, 1)) out.push(monthKey(d));
  return out;
}

function toBars(rows: readonly NikkeiRow[], col: 1 | 2): Bar[] {
  const out: Bar[] = [];
  for (const r of rows) {
    const v = col === 1 ? r.v1 : r.v2;
    if (v !== null && v > 0) out.push([r.date, v, v, v, v]);
  }
  return out;
}

export async function fetchNikkei(
  symbol: NikkeiSymbol,
  cached: Bar[] | null,
  today: string,
  http: HttpOptions,
  fast = false,
): Promise<SourceFetchResult> {
  const { list, col } = SYMBOL_SPEC[symbol];
  const thisMonth = monthKey(today);
  const incremental = !!cached && cached.length >= 1000;
  // 增量：快取最後一天所在月（可能有修正）到當月；回補：2004-09 起每個月
  const from = incremental ? monthKey(cached!.at(-1)![0]) : monthKey(NIKKEI_FIRST_MONTH);
  const rows: NikkeiRow[] = [];
  let empty = 0;
  for (const ym of monthsBetween(from, thisMonth)) {
    const r = await loadMonth(list, ym, http, fast);
    if (r.length === 0) empty++;
    rows.push(...r);
  }
  const bars = toBars(rows, col);
  if (!incremental && bars.length < 1000) throw new Error(`日經 ${list} 只解析到 ${bars.length} 天（空月份 ${empty} 個，格式可能改變）`);
  if (bars.length === 0) throw new Error(`日經 ${list} ${from}～${thisMonth} 沒有資料`);
  return { bars, closeOnly: true, partial: false, incremental };
}
