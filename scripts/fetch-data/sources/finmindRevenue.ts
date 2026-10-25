import type { Bar } from '../../../src/shared/types';
import { getJson, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * FinMind 台股月營收（TaiwanStockMonthRevenue，2002 起，匿名可用）。
 * FinMind 的 date 是「公布月」1 日（9 月營收記在 10-01），這裡改用 revenue_year／revenue_month，
 * 日期＝營收所屬月份 1 日；數值換成億元。公司每月 10 日前公布上月營收。
 * 驗證：2026-09 長榮 497.11 億、陽明 216.99 億、萬海 217.75 億，與公司公告相同。
 */
export interface FinmindRevenueRow {
  date: string;
  stock_id: string;
  revenue: number;
  revenue_month: number;
  revenue_year: number;
}

export function revenueToBars(rows: readonly FinmindRevenueRow[]): Bar[] {
  const by = new Map<string, number>();
  for (const r of rows) {
    if (!Number.isFinite(r.revenue) || r.revenue <= 0 || !r.revenue_year || !r.revenue_month) continue;
    const d = `${r.revenue_year}-${String(r.revenue_month).padStart(2, '0')}-01`;
    const v = Math.round(r.revenue / 1e6) / 100; // 億元，兩位小數
    by.set(d, v);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, v]): Bar => [d, v, v, v, v]);
}

export async function fetchFinmindRevenue(code: string, today: string, http: HttpOptions): Promise<SourceFetchResult> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=${encodeURIComponent(code)}&start_date=2002-01-01&end_date=${today}`;
  const j = await getJson<{ status?: number; msg?: string; data?: FinmindRevenueRow[] }>(url, http);
  if (j.status !== 200) throw new Error(`FinMind 月營收 ${code} status=${j.status} ${j.msg ?? ''}`);
  const bars = revenueToBars(j.data ?? []);
  // 每次整批重抓（約 300 筆、1 個請求），公司更正營收時也會跟著修正
  return { bars, closeOnly: true, partial: false, incremental: false };
}
