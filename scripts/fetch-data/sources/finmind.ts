import type { Bar } from '../../../src/shared/types';
import { getJson, type HttpOptions } from '../http';

/**
 * FinMind 開放資料（https://finmind.github.io/）：期貨三大法人 TaiwanFuturesInstitutionalInvestors。
 * 期交所官方查詢只回溯約 3 年；FinMind 自 2018-06-05 起，匿名可用（有每小時請求上限，回補只用約 18 個請求）。
 * 驗證：2026-10-16 外資台指期淨 OI −93,675、散戶小台 +11,123，與期交所相同。
 */
export const FINMIND_FUTURES_START = '2018-06-05';

export interface FinmindFuturesRow {
  date: string;
  institutional_investors: string;
  long_open_interest_balance_volume: number;
  short_open_interest_balance_volume: number;
}

/** 外資：外資多空未平倉口數淨額；散戶：−（三大法人淨額合計，三者皆有才算） */
export function finmindToBars(rows: FinmindFuturesRow[], kind: 'foreign' | 'retail'): Bar[] {
  const by = new Map<string, FinmindFuturesRow[]>();
  for (const r of rows) by.set(r.date, [...(by.get(r.date) ?? []), r]);
  const net = (r: FinmindFuturesRow) => r.long_open_interest_balance_volume - r.short_open_interest_balance_volume;
  const out: Bar[] = [];
  for (const [date, list] of [...by.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    let v: number | null = null;
    if (kind === 'foreign') {
      const f = list.find((r) => r.institutional_investors.startsWith('外資'));
      v = f ? net(f) : null;
    } else if (list.length >= 3) v = -list.reduce((s, r) => s + net(r), 0);
    if (v !== null && Number.isFinite(v)) out.push([date, v, v, v, v]);
  }
  return out;
}

export async function fetchFinmindFutures(http: HttpOptions, id: 'TX' | 'MTX', start: string, end: string): Promise<FinmindFuturesRow[]> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesInstitutionalInvestors&data_id=${id}&start_date=${start}&end_date=${end}`;
  const j = await getJson<{ status?: number; msg?: string; data?: FinmindFuturesRow[] }>(url, http);
  if (j.status !== 200) throw new Error(`FinMind ${id} status=${j.status} ${j.msg ?? ''}`);
  return j.data ?? [];
}
