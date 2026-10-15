import { addDays } from '../../../src/shared/dates';
import type { Bar } from '../../../src/shared/types';
import { getText, sleep, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * 臺灣期貨交易所「三大法人－區分各期貨契約－依日期」CSV 下載（官方、免金鑰）。
 *   POST https://www.taifex.com.tw/cht/3/futContractsDateDown
 *   queryStartDate / queryEndDate（YYYY/MM/DD，單次最多約 1 年）、commodityId（TXF 大台、MXF 小台）
 *   回應為 Big5 編碼 CSV；查無資料時回傳 HTML 頁面。
 *
 * 散戶淨未平倉為「推算值」：期貨多空口數必然相等，
 * 因此 散戶（非三大法人）小台淨未平倉 ＝ −（自營商＋投信＋外資 小台淨未平倉合計）。
 */

export type TaifexSymbol = 'TXF_FOREIGN_OI' | 'MXF_RETAIL_OI' | 'TXO_FOREIGN_NET' | 'TX_TOP10_SPECIFIC';

const COMMODITY: Record<'TXF_FOREIGN_OI' | 'MXF_RETAIL_OI', string> = { TXF_FOREIGN_OI: 'TXF', MXF_RETAIL_OI: 'MXF' };
export const TAIFEX_BACKFILL_DAYS = 730;

export interface TaifexRow {
  date: string;
  identity: string;
  netOi: number;
}

/** 解析 CSV；查無資料（回傳 HTML）時回傳空陣列 */
export function parseTaifexCsv(text: string): TaifexRow[] {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (t === '' || t.startsWith('<')) return [];
  const lines = t.split(/\r?\n/);
  const header = lines[0]!.split(',');
  const iDate = header.indexOf('日期');
  const iId = header.indexOf('身份別');
  const iNet = header.indexOf('多空未平倉口數淨額');
  if (iDate < 0 || iId < 0 || iNet < 0) throw new Error(`期交所 CSV 欄位異常：${lines[0]!.slice(0, 80)}`);
  const rows: TaifexRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const date = (c[iDate] ?? '').trim().replace(/\//g, '-');
    const net = Number((c[iNet] ?? '').replace(/,/g, ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(net)) continue;
    rows.push({ date, identity: (c[iId] ?? '').trim(), netOi: net });
  }
  return rows;
}

/** 依代號把逐列資料轉成每日數值 */
export function taifexToBars(rows: TaifexRow[], symbol: TaifexSymbol): Bar[] {
  const byDate = new Map<string, TaifexRow[]>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const bars: Bar[] = [];
  for (const [date, list] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let v: number | null = null;
    if (symbol === 'TXF_FOREIGN_OI') {
      v = list.find((r) => r.identity.startsWith('外資'))?.netOi ?? null;
    } else if (list.length >= 3) {
      // 三大法人皆有資料才計算，避免缺列造成錯誤的散戶數字
      v = -list.reduce((s, r) => s + r.netOi, 0);
    }
    if (v !== null) bars.push([date, v, v, v, v]);
  }
  return bars;
}

/** 簡易 CSV 切欄（期交所 CSV 無引號欄位） */
function csvTable(text: string, need: string[], label: string): { idx: number[]; rows: string[][] } | null {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (t === '' || t.startsWith('<')) return null;
  const lines = t.split(/\r?\n/);
  const header = lines[0]!.split(',').map((h) => h.trim());
  const idx = need.map((n) => header.indexOf(n));
  if (idx.some((i) => i < 0)) throw new Error(`期交所${label} CSV 欄位異常：${lines[0]!.slice(0, 80)}`);
  return { idx, rows: lines.slice(1).map((l) => l.split(',').map((c) => c.trim())) };
}

const num = (s: string | undefined) => Number((s ?? '').replace(/,/g, ''));
const isoDate = (s: string | undefined) => (s ?? '').replace(/\//g, '-');

/**
 * 選擇權「三大法人－選擇權買賣權分計－依日期」CSV（callsAndPutsDateDown，commodityId=TXO）。
 * 外資選擇權多空淨金額（億元）＝ 外資 CALL 未平倉契約金額淨額 − 外資 PUT 未平倉契約金額淨額。
 * 買進買權／賣出賣權為偏多，買進賣權／賣出買權為偏空，因此 CALL 淨額減 PUT 淨額 > 0 代表偏多。
 * 單位：CSV 為千元，÷100,000 換成億元。CALL、PUT 兩列都有才計算。
 */
export function parseTaifexOptionsCsv(text: string): Bar[] {
  const tb = csvTable(text, ['日期', '買賣權別', '身份別', '未平倉契約金額買賣淨額(千元)'], '選擇權');
  if (!tb) return [];
  const [iDate, iCp, iId, iAmt] = tb.idx as [number, number, number, number];
  const byDate = new Map<string, { call?: number; put?: number }>();
  for (const c of tb.rows) {
    const date = isoDate(c[iDate]);
    const amt = num(c[iAmt]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amt) || !(c[iId] ?? '').startsWith('外資')) continue;
    const cp = (c[iCp] ?? '').toUpperCase();
    const o = byDate.get(date) ?? {};
    if (cp === 'CALL') o.call = amt;
    else if (cp === 'PUT') o.put = amt;
    byDate.set(date, o);
  }
  const bars: Bar[] = [];
  for (const [date, o] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (o.call === undefined || o.put === undefined) continue;
    const v = Math.round(((o.call - o.put) / 100_000) * 100) / 100;
    bars.push([date, v, v, v, v]);
  }
  return bars;
}

/**
 * 「大額交易人未沖銷部位結構表－期貨」CSV（largeTraderFutDown）。
 * 前十大特定法人台指期淨未平倉（口，大台約當）＝ 商品 TX、到期月份 999999（所有月份合計）、
 * 交易人類別 1（特定法人）的「前十大交易人買方 − 前十大交易人賣方」。
 * TX 已含小台、微台換算（TX + MTX/4 + TMF/20）。買方、賣方前十大不一定是同一批交易人。
 */
export function parseLargeTraderCsv(text: string): Bar[] {
  const tb = csvTable(
    text,
    ['日期', '商品(契約)', '到期月份(週別)', '交易人類別', '前十大交易人買方', '前十大交易人賣方'],
    '大額交易人',
  );
  if (!tb) return [];
  const [iDate, iCom, iMon, iType, iBuy, iSell] = tb.idx as [number, number, number, number, number, number];
  const out = new Map<string, number>();
  for (const c of tb.rows) {
    if (c[iCom] !== 'TX' || c[iMon] !== '999999' || c[iType] !== '1') continue;
    const date = isoDate(c[iDate]);
    const v = num(c[iBuy]) - num(c[iSell]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(v)) out.set(date, v);
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, v]): Bar => [d, v, v, v, v]);
}

interface TaifexQuery {
  url: string;
  form: (start: string, end: string) => Record<string, string>;
  /** 單次查詢最多天數（期交所限制：法人約 1 年、大額交易人 3 個月） */
  maxDays: number;
  parse: (text: string) => Bar[];
  timeoutMs?: number;
}

const BASE = 'https://www.taifex.com.tw/cht/3/';

function queryFor(symbol: TaifexSymbol): TaifexQuery {
  switch (symbol) {
    case 'TXF_FOREIGN_OI':
    case 'MXF_RETAIL_OI':
      return {
        url: `${BASE}futContractsDateDown`,
        form: (s, e) => ({ queryStartDate: slash(s), queryEndDate: slash(e), commodityId: COMMODITY[symbol] }),
        maxDays: 300,
        parse: (t) => taifexToBars(parseTaifexCsv(t), symbol),
      };
    case 'TXO_FOREIGN_NET':
      return {
        url: `${BASE}callsAndPutsDateDown`,
        form: (s, e) => ({ queryStartDate: slash(s), queryEndDate: slash(e), commodityId: 'TXO' }),
        maxDays: 300,
        parse: parseTaifexOptionsCsv,
      };
    case 'TX_TOP10_SPECIFIC':
      // 回應含所有期貨商品，3 個月約 5MB，因此放寬逾時
      return {
        url: `${BASE}largeTraderFutDown`,
        form: (s, e) => ({ queryStartDate: slash(s), queryEndDate: slash(e) }),
        maxDays: 85,
        parse: parseLargeTraderCsv,
        timeoutMs: 90_000,
      };
  }
}

const slash = (d: string) => d.replace(/-/g, '/');

/** 把 [start, end] 切成每段最多 maxDays 天，最後一段結束於 end */
export function splitRange(start: string, end: string, maxDays: number): [string, string][] {
  const out: [string, string][] = [];
  let s = start;
  while (s <= end) {
    const e = addDays(s, maxDays - 1) < end ? addDays(s, maxDays - 1) : end;
    out.push([s, e]);
    s = addDays(e, 1);
  }
  return out;
}

export async function fetchTaifex(
  symbol: TaifexSymbol,
  since: string | null,
  today: string,
  http: HttpOptions,
  fast = false,
): Promise<SourceFetchResult> {
  // 有快取：從快取最後一天前 10 天抓到今天（涵蓋修正與連假）；無快取：回補 2 年。
  // 期交所單次查詢有期間上限，因此依資料集切段。
  const q = queryFor(symbol);
  const opts: HttpOptions = q.timeoutMs ? { ...http, timeoutMs: Math.max(http.timeoutMs ?? 0, q.timeoutMs) } : http;
  const start = since ? addDays(since, -10) : addDays(today, -TAIFEX_BACKFILL_DAYS);
  const ranges = splitRange(start, today, q.maxDays);
  const byDate = new Map<string, Bar>();
  for (const [s, e0] of ranges) {
    // 實測：結束日晚於「最新已公布日」（例如盤後資料尚未公布、週末）時，期交所回傳錯誤頁。
    // 因此查無資料時把結束日逐日往前退，最多 7 天。
    let e = e0;
    for (let tries = 0; tries < 8 && e >= s; tries++) {
      const text = await getText(q.url, opts, { method: 'POST', form: q.form(s, e), encoding: 'big5' });
      if (!fast) await sleep(500);
      const got = q.parse(text);
      if (got.length > 0) {
        for (const b of got) byDate.set(b[0], b);
        break;
      }
      e = addDays(e, -1);
    }
  }
  const bars = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (bars.length === 0) throw new Error('期交所沒有回傳任何資料');
  return { bars, closeOnly: true, partial: false, incremental: since !== null };
}
