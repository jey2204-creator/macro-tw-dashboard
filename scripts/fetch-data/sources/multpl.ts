import { MULTPL_PAGE, type SourceSpec } from '../../../src/shared/indicators';
import type { Bar } from '../../../src/shared/types';
import { getText, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * multpl.com：Robert Shiller 的 S&P 500 月資料（1871 年起）整理成 HTML 表格，免金鑰。
 *
 * | 代號 | 頁面 | 內容 |
 * |---|---|---|
 * | SP500_PE | /s-p-500-pe-ratio/table/by-month | 本益比＝月平均價 ÷ 近 12 月 as-reported EPS（名目） |
 * | SP500_PRICE | /s-p-500-historical-prices/table/by-month | 月平均收盤價（名目，不調整通膨） |
 * | SHILLER_PE | /shiller-pe/table/by-month | 席勒本益比 CAPE＝實質價格 ÷ 近 10 年實質 EPS 平均 |
 *
 * 近 12 月 EPS（名目）＝ 價格 ÷ 本益比，由前端推算（multpl 的「S&P 500 Earnings」頁是通膨調整後的實質值，不能直接用）。
 *
 * 表格每列 `<tr><td>Oct 1, 2026</td><td>26.29</td></tr>`：歷史列以每月 1 日標示，最上面另有一列「今天」
 * （例：Oct 16, 2026 † 26.12，† 表示以最新價與最新已公布 EPS 估計）。同一個月只留日期最晚的一列（今天那列），
 * 其餘月份保留 1 日的日期；每次整批重抓取代快取，所以「今天」那列不會累積成多筆。
 */

export type MultplSymbol = Extract<SourceSpec, { provider: 'multpl' }>['symbol'];

export function multplUrl(symbol: MultplSymbol): string {
  return `https://www.multpl.com/${MULTPL_PAGE[symbol]}/table/by-month`;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** 去掉標籤與實體（&dagger;、&#8224; 這類含數字的實體要先拿掉，否則會被當成數值） */
function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[#\w]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 「Oct 16, 2026」→ 2026-10-16；不是日期回傳 null */
export function parseMultplDate(text: string): string | null {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (!m) return null;
  const mon = MONTHS[m[1]!.toLowerCase()];
  const day = Number(m[2]);
  if (!mon || day < 1 || day > 31) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 「† (Estimate) 7,715.79」→ 7715.79；取第一個數字 */
export function parseMultplValue(text: string): number | null {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(text.replace(/\(.*?\)/g, ' '));
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

/**
 * 解析整頁 HTML → 依日期遞增的 K 棒（o=h=l=c）。
 * 同一個月有多列時只留日期最晚的（「今天」列取代當月 1 日的月均值列）。
 */
export function parseMultplTable(html: string): Bar[] {
  const byMonth = new Map<string, Bar>();
  const rows = html.split(/<tr[\s>]/i).slice(1);
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]!));
    if (cells.length < 2) continue;
    const date = parseMultplDate(cells[0]!);
    const value = parseMultplValue(cells[1]!);
    if (!date || value === null || value <= 0) continue;
    const key = date.slice(0, 7);
    const prev = byMonth.get(key);
    if (!prev || prev[0] < date) byMonth.set(key, [date, value, value, value, value]);
  }
  const bars = [...byMonth.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (bars.length < 100) throw new Error(`multpl 表格解析只得到 ${bars.length} 列（頁面格式可能改變）`);
  return bars;
}

export async function fetchMultpl(symbol: MultplSymbol, http: HttpOptions): Promise<SourceFetchResult> {
  const html = await getText(multplUrl(symbol), http, { headers: { Accept: 'text/html' } });
  return { bars: parseMultplTable(html), closeOnly: true, partial: false, incremental: false };
}
