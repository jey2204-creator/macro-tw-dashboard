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

export type TaifexSymbol = 'TXF_FOREIGN_OI' | 'MXF_RETAIL_OI';

const COMMODITY: Record<TaifexSymbol, string> = { TXF_FOREIGN_OI: 'TXF', MXF_RETAIL_OI: 'MXF' };
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
  // 期交所單次查詢上限約 1 年，因此切成每段最多 300 天。
  const start = since ? addDays(since, -10) : addDays(today, -TAIFEX_BACKFILL_DAYS);
  const ranges = splitRange(start, today, 300);
  const rows: TaifexRow[] = [];
  for (const [s, e0] of ranges) {
    // 實測：結束日晚於「最新已公布日」（例如盤後資料尚未公布、週末）時，期交所回傳錯誤頁。
    // 因此查無資料時把結束日逐日往前退，最多 7 天。
    let e = e0;
    for (let tries = 0; tries < 8 && e >= s; tries++) {
      const text = await getText('https://www.taifex.com.tw/cht/3/futContractsDateDown', http, {
        method: 'POST',
        form: { queryStartDate: slash(s), queryEndDate: slash(e), commodityId: COMMODITY[symbol] },
        encoding: 'big5',
      });
      if (!fast) await sleep(500);
      const got = parseTaifexCsv(text);
      if (got.length > 0) {
        rows.push(...got);
        break;
      }
      e = addDays(e, -1);
    }
  }
  const bars = taifexToBars(rows, symbol);
  if (bars.length === 0) throw new Error('期交所沒有回傳任何資料');
  return { bars, closeOnly: true, partial: false, incremental: since !== null };
}
