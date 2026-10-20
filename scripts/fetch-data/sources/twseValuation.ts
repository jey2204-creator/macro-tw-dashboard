import { addMonths } from '../../../src/shared/dates';
import type { SourceSpec } from '../../../src/shared/indicators';
import type { Bar } from '../../../src/shared/types';
import { getBytes, HttpError, sleep, type HttpOptions } from '../http';
import { readXls, type XlsSheet } from '../xls';
import { unzip } from './twGov';
import type { SourceFetchResult } from './types';

/**
 * 證交所「證券市場統計概要與市場總市值、投資報酬率、本益比、殖利率一覽表」月報（市場交易月報，1999 年起）：
 * 每月第 7 個營業日左右公布上月，zip 內一個 .xls；每個檔含「最近 12 個月」的月資料（最新月為初步值，同時修正前一個月）。
 *
 * 大盤（＝發行量加權股價指數採樣股票）定義，見證交所報表說明：
 *  - 本益比＝市值推計總額 ÷ 純益推計總額（近四季）
 *  - 股價淨值比＝市值推計總額 ÷ 淨值推計總額
 *  - 殖利率＝股利推計總額 ÷ 市值推計總額 × 100（含股票股利；報表另附現金殖利率）
 *
 * 2026-10-20 探測（GitHub Actions，暫時 workflow「台股估值資料源探測」，四輪）：
 *  - 下載清單 API：/rwd/zh/statistics/download?type=02&date=YYYY0101&response=json，檔案實際位置
 *    /rwd/staticFiles/inspection/inspection/02/001/YYYYMM_C02001.zip（本模組直接組網址）
 *  - 1999–2026 每年 12 月檔皆可下載；版面三種：1999 單一工作表（本益比在第二區塊）、2000–2004 本益比在 Form2、
 *    2005 起在 Form1。解析時依表頭文字找欄位，不寫死欄位位置
 *
 * 回補：沒有快取時，下載 1999–去年每年 12 月檔＋最新一期（約 29 個檔）；之後每次只在快取缺上個月時抓最新一期。
 */

export type TwseValSymbol = Extract<SourceSpec, { provider: 'twse_val' }>['symbol'];

export const TWSE_VAL_FIRST_YEAR = 1999;
const MIN_INTERVAL_MS = 2500;

export interface TwseValMonth {
  /** YYYY-MM-01 */
  month: string;
  pe: number | null;
  dy: number | null;
  pb: number | null;
}

export const twseValUrl = (yyyymm: string) =>
  `https://www.twse.com.tw/rwd/staticFiles/inspection/inspection/02/001/${yyyymm}_C02001.zip`;

const norm = (v: unknown) => String(v ?? '').replace(/[\s\u3000]/g, '');

function cellNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v ?? '').replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/**
 * 從月報各工作表找出「本益比、殖利率、股價淨值比」欄，讀出每個月份列。
 * 表頭與資料列在同一個區塊內（「證券市場統計概要（一）（二）…」標題開始新區塊）。
 */
export function parseTwseValSheets(sheets: readonly XlsSheet[]): TwseValMonth[] {
  const out = new Map<string, TwseValMonth>();
  for (const sheet of sheets) {
    let cols: { pe?: number; dy?: number; pb?: number } = {};
    let inData = false;
    let year: number | null = null;
    let prevMonth = 0;
    for (const row of sheet.rows) {
      const first = norm(row[0]);
      if (first.includes('證券市場統計概要')) {
        cols = {};
        inData = false;
        year = null;
        prevMonth = 0;
        continue;
      }
      if (!inData) {
        row.forEach((cell, c) => {
          const t = norm(cell);
          if (cols.pe === undefined && t.includes('本益比')) cols.pe = c;
          else if (cols.dy === undefined && t.includes('殖利率') && !t.includes('現金')) cols.dy = c;
          else if (cols.pb === undefined && t.includes('淨值比')) cols.pb = c;
        });
      }
      if (first.startsWith('註') || first.startsWith('Note')) {
        inData = true;
        continue;
      }
      let month: number | null = null;
      let m: RegExpExecArray | null;
      if ((m = /^(\d{2,3})年(\d{1,2})月$/.exec(first))) {
        year = Number(m[1]) + 1911;
        month = Number(m[2]);
      } else if ((m = /^\((\d{4})\)(\d{1,2})月$/.exec(first))) {
        year = Number(m[1]);
        month = Number(m[2]);
      } else if ((m = /^(\d{1,2})月$/.exec(first))) {
        month = Number(m[1]);
        if (year !== null && month <= prevMonth) year++;
      } else if (/^\d{2,3}(年)?\(/.test(first)) {
        // 年度彙總列（110(2021)、115年(1-9)月、88(1-12月)）：之後就是資料區
        inData = true;
        continue;
      }
      if (month === null || year === null || month < 1 || month > 12) continue;
      inData = true;
      prevMonth = month;
      if (cols.pe === undefined && cols.pb === undefined && cols.dy === undefined) continue;
      const key = `${year}-${String(month).padStart(2, '0')}-01`;
      const pe = cols.pe !== undefined ? cellNumber(row[cols.pe]) : null;
      const dy = cols.dy !== undefined ? cellNumber(row[cols.dy]) : null;
      const pb = cols.pb !== undefined ? cellNumber(row[cols.pb]) : null;
      if (pe === null && dy === null && pb === null) continue;
      // 同一個月份出現在多個工作表（2000–2004 年 Form1 沒有估值欄、Form2 才有）：合併非空值
      const prev = out.get(key);
      out.set(key, {
        month: key,
        pe: pe ?? prev?.pe ?? null,
        dy: dy ?? prev?.dy ?? null,
        pb: pb ?? prev?.pb ?? null,
      });
    }
  }
  return [...out.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** zip（證交所月報下載檔）→ 月資料 */
export function parseTwseValZip(buf: Uint8Array): TwseValMonth[] {
  const files = unzip(buf);
  for (const [name, data] of files) {
    if (!/\.xls$/i.test(name) && files.size > 1) continue;
    return parseTwseValSheets(readXls(data));
  }
  throw new Error('月報 zip 內沒有 xls');
}

// ── 抓取 ─────────────────────────────────────────────────────

let lastRequestAt = 0;
async function throttle(fast: boolean) {
  if (fast) return;
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/** 一次執行內，本益比／淨值比／殖利率三個指標共用下載結果；null＝該月尚未公布（404） */
const fileCache = new Map<string, Promise<TwseValMonth[] | null>>();
export function clearTwseValCache() {
  fileCache.clear();
}

function loadMonth(yyyymm: string, http: HttpOptions, fast: boolean): Promise<TwseValMonth[] | null> {
  let p = fileCache.get(yyyymm);
  if (!p) {
    p = (async () => {
      await throttle(fast);
      try {
        return parseTwseValZip(await getBytes(twseValUrl(yyyymm), http));
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    })();
    fileCache.set(yyyymm, p);
    p.catch(() => fileCache.delete(yyyymm));
  }
  return p;
}

const ym = (date: string) => date.slice(0, 7).replace('-', '');

/** 最新一期：上個月的月報（每月約第 7 個營業日公布），還沒出來就退回上上個月 */
async function latestFile(today: string, http: HttpOptions, fast: boolean): Promise<{ yyyymm: string; rows: TwseValMonth[] }> {
  for (const back of [1, 2, 3]) {
    const yyyymm = ym(addMonths(`${today.slice(0, 7)}-01`, -back));
    const rows = await loadMonth(yyyymm, http, fast);
    if (rows && rows.length > 0) return { yyyymm, rows };
  }
  throw new Error('證交所最近三個月的月報都抓不到');
}

function pick(symbol: TwseValSymbol, r: TwseValMonth): number | null {
  if (symbol === 'PE') return r.pe;
  if (symbol === 'PB') return r.pb;
  return r.dy;
}

function toBars(symbol: TwseValSymbol, rows: readonly TwseValMonth[]): Bar[] {
  const out: Bar[] = [];
  for (const r of rows) {
    const v = pick(symbol, r);
    if (v !== null && v > 0) out.push([r.month, v, v, v, v]);
  }
  return out;
}

/** 後面的檔覆蓋前面的（新檔含修正值） */
function mergeMonths(lists: readonly TwseValMonth[][]): TwseValMonth[] {
  const map = new Map<string, TwseValMonth>();
  for (const list of lists) for (const r of list) map.set(r.month, r);
  return [...map.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

export async function fetchTwseValuation(
  symbol: TwseValSymbol,
  cached: Bar[] | null,
  today: string,
  http: HttpOptions,
  fast = false,
): Promise<SourceFetchResult> {
  const prevMonth = `${addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
  // 有完整快取：上個月已在快取內就不必再抓（下一期要到下個月初才公布）
  if (cached && cached.length >= 200) {
    if (cached.at(-1)![0] >= prevMonth) return { bars: cached, closeOnly: true, partial: false, incremental: true };
    const latest = await latestFile(today, http, fast);
    return { bars: toBars(symbol, latest.rows), closeOnly: true, partial: false, incremental: true };
  }
  // 回補：每年 12 月檔（含當年 1–12 月）＋最新一期
  const latest = await latestFile(today, http, fast);
  const lastYear = Number(latest.yyyymm.slice(0, 4)) - (latest.yyyymm.endsWith('12') ? 0 : 1);
  const lists: TwseValMonth[][] = [];
  for (let y = TWSE_VAL_FIRST_YEAR; y <= lastYear; y++) {
    const rows = await loadMonth(`${y}12`, http, fast);
    if (rows) lists.push(rows);
  }
  lists.push(latest.rows);
  const bars = toBars(symbol, mergeMonths(lists));
  if (bars.length < 200) throw new Error(`證交所月報只解析到 ${bars.length} 個月（格式可能改變）`);
  return { bars, closeOnly: true, partial: false, incremental: false };
}
