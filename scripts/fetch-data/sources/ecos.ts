import { addMonths, monthKey } from '../../../src/shared/dates';
import type { SourceSpec } from '../../../src/shared/indicators';
import type { Bar } from '../../../src/shared/types';
import { getJson, sleep, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * 韓國銀行 ECOS 經濟統計系統 Open API（ecos.bok.or.kr）：
 *   /api/StatisticSearch/{key}/json/kr/{起}/{迄}/{統計表}/{週期}/{開始期}/{結束期}/{項目}
 *
 * 2026-10-24 探測（內建瀏覽器）：
 *  - 公開測試金鑰 `sample` 不必註冊即可查詢，但一次最多 10 筆（超過回 ERROR-301）→ 以 10 期為一段逐段抓
 *  - 901Y014「주식시장(월,년)」：1110000 KOSPI 주가이익비율（本益比，2004-01 起）、1100000 KOSPI 배당수익률（殖利率，2004-01 起）
 *    ——皆為韓國交易所（KRX）月底值，本益比用「最近一期年度（含半年報）實績純益」，不是預估
 *  - 721Y001「시장금리(월,분기,년)」：5050000 국고채(10년) 月平均（2000-10 起）
 *  - 月週期的期別格式 YYYYMM；回傳 DATA_VALUE 為字串
 *
 * 可用環境變數 ECOS_API_KEY 換成自己申請的金鑰（免費），一次就能拿 1000 筆。
 * 回補：沒有快取時從統計起始月抓到當月；之後只抓快取最後一月的前 2 個月到當月（月底值偶有修正）。
 */

export type EcosSymbol = Extract<SourceSpec, { provider: 'ecos' }>['symbol'];

interface EcosSpec {
  stat: string;
  item: string;
  /** 統計起始月 YYYY-MM */
  first: string;
}

export const ECOS_SPEC: Record<EcosSymbol, EcosSpec> = {
  KOSPI_PER: { stat: '901Y014', item: '1110000', first: '2004-01' },
  KOSPI_DY: { stat: '901Y014', item: '1100000', first: '2004-01' },
  KTB10Y: { stat: '721Y001', item: '5050000', first: '2000-10' },
};

const SAMPLE_KEY = 'sample';
/** sample 金鑰一次最多 10 筆；自己的金鑰上限 1000 筆 */
const PAGE_SAMPLE = 10;
const PAGE_KEYED = 1000;
const GAP_MS = 300;
/** 增量時往前重抓的月數（月底值偶有修正） */
const REFRESH_MONTHS = 2;

export function ecosKey(env: NodeJS.ProcessEnv = process.env): string {
  const k = env.ECOS_API_KEY?.trim();
  return k ? k : SAMPLE_KEY;
}

export const ecosUrl = (key: string, spec: EcosSpec, from: string, to: string, limit: number) =>
  `https://ecos.bok.or.kr/api/StatisticSearch/${key}/json/kr/1/${limit}/${spec.stat}/M/${from}/${to}/${spec.item}`;

interface EcosRow {
  TIME?: string;
  DATA_VALUE?: string;
}
interface EcosResponse {
  StatisticSearch?: { list_total_count?: number; row?: EcosRow[] };
  RESULT?: { CODE?: string; MESSAGE?: string };
}

/** 回傳 → [YYYY-MM-01, 值]；沒有資料（INFO-200）回空陣列，其他錯誤拋出 */
export function parseEcos(j: EcosResponse): Bar[] {
  if (j.RESULT) {
    if (j.RESULT.CODE === 'INFO-200') return [];
    throw new Error(`ECOS ${j.RESULT.CODE}：${j.RESULT.MESSAGE ?? ''}`.trim());
  }
  const rows = j.StatisticSearch?.row;
  if (!rows) throw new Error('ECOS 回應沒有 StatisticSearch.row');
  const out: Bar[] = [];
  for (const r of rows) {
    const t = r.TIME ?? '';
    const v = Number(r.DATA_VALUE);
    if (!/^\d{6}$/.test(t) || !Number.isFinite(v)) continue;
    out.push([`${t.slice(0, 4)}-${t.slice(4, 6)}-01`, v, v, v, v]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

const ym = (d: string) => monthKey(d).replace('-', '');

export async function fetchEcos(
  symbol: EcosSymbol,
  cached: Bar[] | null,
  today: string,
  http: HttpOptions,
  fast = false,
  key = ecosKey(),
): Promise<SourceFetchResult> {
  const spec = ECOS_SPEC[symbol];
  const incremental = !!cached && cached.length >= 12;
  const from = incremental ? monthKey(addMonths(cached!.at(-1)![0], -REFRESH_MONTHS)) : spec.first;
  const to = monthKey(today);
  const page = key === SAMPLE_KEY ? PAGE_SAMPLE : PAGE_KEYED;
  const bars: Bar[] = [];
  let first = true;
  for (let start = from; start <= to; start = monthKey(addMonths(`${start}-01`, page))) {
    const endMonth = monthKey(addMonths(`${start}-01`, page - 1));
    const end = endMonth < to ? endMonth : to;
    if (!fast && !first) await sleep(GAP_MS);
    first = false;
    bars.push(...parseEcos(await getJson<EcosResponse>(ecosUrl(key, spec, ym(`${start}-01`), ym(`${end}-01`), page), http)));
  }
  if (bars.length === 0) throw new Error(`ECOS ${spec.stat}/${spec.item} ${from}～${to} 沒有資料`);
  if (!incremental && bars.length < 24) throw new Error(`ECOS ${spec.stat}/${spec.item} 只解析到 ${bars.length} 個月（格式可能改變）`);
  return { bars, closeOnly: true, partial: false, incremental };
}
