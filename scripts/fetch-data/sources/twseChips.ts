import { addDays, parseDate } from '../../../src/shared/dates';
import type { Bar } from '../../../src/shared/types';
import { getJson, sleep, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * 臺灣證券交易所（上市）每日籌碼資料，官方、免金鑰，但「一次只能查一天」：
 *  - 三大法人買賣金額統計 BFI82U：外資、投信、自營商買賣超（元）
 *  - 信用交易統計 MI_MARGN（selectType=ALL）：融資金額前日／今日餘額（仟元）＋逐檔融資餘額（張）
 *  - 每日收盤行情 MI_INDEX（type=ALLBUT0999）：逐檔收盤價（計算融資維持率用）
 *
 * 大盤融資維持率（推算，上市、含 ETF）＝ Σ(逐檔融資餘額張數 × 1000 × 收盤價) ÷ 融資金額餘額 × 100%
 *   無收盤價（暫停交易等）的個股略過，影響通常 < 0.1 個百分點；
 *   2026-10-12 試算 196.16%，與愛玩股公布值一致。
 *
 * 為避免單次執行過久，採「漸進回補」：每次執行除了補最新幾天，
 * 另往前回補最多 BACKFILL_PER_RUN 個工作日，直到 BACKFILL_DAYS 天前。
 * 同一天的 BFI82U 回應由外資／投信／自營商三個指標共用（每次執行內快取）。
 */

export type TwseChipSymbol = 'FOREIGN' | 'TRUST' | 'DEALER' | 'MARGIN' | 'MARGIN_BALANCE' | 'MARGIN_RATIO';

export const TWSE_CHIPS_BACKFILL_DAYS = 365;
/** 維持率每天多一個大檔請求，回補較短 */
export const MARGIN_RATIO_BACKFILL_DAYS = 183;
export const BACKFILL_PER_RUN = 40;
/**
 * 證交所對頻繁請求會暫時封鎖 IP（實測 GitHub Actions 上每 0.7 秒一次會被擋），
 * 所有證交所籌碼請求共用節流：兩次請求至少間隔 2 秒。
 */
const MIN_INTERVAL_MS = 2000;
let lastRequestAt = 0;
async function throttle(fast: boolean): Promise<void> {
  if (fast) return;
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

const num = (s: string | undefined) => Number(String(s ?? '').replace(/,/g, ''));
const yi = (v: number) => Math.round((v / 1e8) * 100) / 100; // 元 → 億元，取 2 位

interface Bfi82u {
  stat?: string;
  fields?: string[];
  data?: string[][];
}
interface MiMargn {
  stat?: string;
  tables?: { fields?: string[]; data?: string[][] }[];
}

/** 回傳（億元）：外資＝外資及陸資＋外資自營商；自營商＝自行買賣＋避險。查無資料回傳 null */
export function parseBfi82u(json: Bfi82u): Record<'FOREIGN' | 'TRUST' | 'DEALER', number> | null {
  if (json.stat !== 'OK') return null;
  const f = json.fields ?? [];
  const iName = f.indexOf('單位名稱');
  const iNet = f.indexOf('買賣差額');
  if (iName < 0 || iNet < 0) throw new Error(`BFI82U 欄位異常：${f.join(',')}`);
  let foreign = 0;
  let trust = 0;
  let dealer = 0;
  let seen = 0;
  for (const row of json.data ?? []) {
    const name = row[iName] ?? '';
    const v = num(row[iNet]);
    if (!Number.isFinite(v)) continue;
    if (name.startsWith('外資')) foreign += v;
    else if (name === '投信') trust = v;
    else if (name.startsWith('自營商')) dealer += v;
    else continue;
    seen++;
  }
  if (seen < 3) throw new Error('BFI82U 資料列不完整');
  return { FOREIGN: yi(foreign), TRUST: yi(trust), DEALER: yi(dealer) };
}

/** 融資金額（今日餘額 − 前日餘額），億元。查無資料回傳 null */
export function parseMiMargn(json: MiMargn): number | null {
  if (json.stat !== 'OK') return null;
  const t = json.tables?.find((x) => x.fields?.includes('今日餘額'));
  if (!t) throw new Error('MI_MARGN 找不到信用交易統計表');
  const f = t.fields!;
  const iPrev = f.indexOf('前日餘額');
  const iNow = f.indexOf('今日餘額');
  const row = t.data?.find((r) => (r[0] ?? '').startsWith('融資金額'));
  if (!row || iPrev < 0 || iNow < 0) throw new Error('MI_MARGN 找不到融資金額列');
  return yi((num(row[iNow]) - num(row[iPrev])) * 1000);
}

export interface MarginDay {
  /** 融資金額增減（億） */
  change: number;
  /** 融資金額今日餘額（億） */
  balance: number;
  /** 融資金額今日餘額（元） */
  loanYuan: number;
  /** 逐檔融資今日餘額（張） */
  lots: Map<string, number>;
}

/** 解析 MI_MARGN（ALL）：彙總＋逐檔。查無資料回傳 null */
export function parseMiMargnAll(json: MiMargn): MarginDay | null {
  if (json.stat !== 'OK') return null;
  const summary = json.tables?.find((t) => t.data?.some((r) => (r[0] ?? '').startsWith('融資金額')));
  if (!summary) throw new Error('MI_MARGN 找不到信用交易統計表');
  const f = summary.fields ?? [];
  const iPrev = f.indexOf('前日餘額');
  const iNow = f.indexOf('今日餘額');
  const row = summary.data!.find((r) => (r[0] ?? '').startsWith('融資金額'))!;
  if (iPrev < 0 || iNow < 0) throw new Error('MI_MARGN 欄位異常');
  const loanYuan = num(row[iNow]) * 1000;
  const lots = new Map<string, number>();
  const detail = json.tables?.find((t) => t.fields?.[0] === '代號');
  if (detail) {
    // 欄位：代號、名稱、融資（買進、賣出、現金償還、前日餘額、今日餘額…）、融券…，取第一個「今日餘額」
    const iLots = detail.fields!.indexOf('今日餘額');
    for (const r of detail.data ?? []) {
      const v = num(r[iLots]);
      if (Number.isFinite(v) && v > 0) lots.set((r[0] ?? '').trim(), v);
    }
  }
  return { change: yi((num(row[iNow]) - num(row[iPrev])) * 1000), balance: yi(loanYuan), loanYuan, lots };
}

interface MiIndex {
  stat?: string;
  tables?: { title?: string; fields?: string[]; data?: string[][] }[];
}

/** 解析 MI_INDEX 每日收盤行情：代號 → 收盤價。查無資料回傳 null */
export function parseMiIndexPrices(json: MiIndex): Map<string, number> | null {
  if (json.stat !== 'OK') return null;
  const t = json.tables?.find((x) => x.fields?.includes('證券代號') && x.fields.includes('收盤價'));
  if (!t) throw new Error('MI_INDEX 找不到每日收盤行情表');
  const iCode = t.fields!.indexOf('證券代號');
  const iClose = t.fields!.indexOf('收盤價');
  const out = new Map<string, number>();
  for (const r of t.data ?? []) {
    const v = num(r[iClose]);
    if (Number.isFinite(v) && v > 0) out.set((r[iCode] ?? '').trim(), v);
  }
  return out;
}

/** 大盤融資維持率（%），取 2 位 */
export function computeMarginRatio(day: MarginDay, prices: Map<string, number>): number | null {
  if (day.loanYuan <= 0 || day.lots.size === 0) return null;
  let mv = 0;
  for (const [code, lots] of day.lots) {
    const px = prices.get(code);
    if (px) mv += lots * 1000 * px;
  }
  return Math.round((mv / day.loanYuan) * 10000) / 100;
}

/** 工作日（週一至週五）清單，由新到舊 */
export function weekdaysBackward(from: string, to: string, limit: number): string[] {
  const out: string[] = [];
  for (let d = from; d >= to && out.length < limit; d = addDays(d, -1)) {
    const dow = new Date(parseDate(d)).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

// 單次執行內的每日回應快取（三個法人指標共用同一天的 BFI82U）
const bfiCache = new Map<string, Promise<ReturnType<typeof parseBfi82u>>>();
const marginCache = new Map<string, Promise<MarginDay | null>>();
const priceCache = new Map<string, Promise<Map<string, number> | null>>();

export function resetTwseChipsCache(): void {
  bfiCache.clear();
  marginCache.clear();
  priceCache.clear();
}

function marginDay(date: string, http: HttpOptions, fast: boolean): Promise<MarginDay | null> {
  let p = marginCache.get(date);
  if (!p) {
    p = (async () => {
      await throttle(fast);
      const j = await getJson<MiMargn>(
        `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${date.replace(/-/g, '')}&selectType=ALL&response=json`,
        http,
      );
      return parseMiMargnAll(j);
    })();
    marginCache.set(date, p);
  }
  return p;
}

function closePrices(date: string, http: HttpOptions, fast: boolean): Promise<Map<string, number> | null> {
  let p = priceCache.get(date);
  if (!p) {
    p = (async () => {
      await throttle(fast);
      const j = await getJson<MiIndex>(
        `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date.replace(/-/g, '')}&type=ALLBUT0999&response=json`,
        http,
      );
      return parseMiIndexPrices(j);
    })();
    priceCache.set(date, p);
  }
  return p;
}

async function dayValue(symbol: TwseChipSymbol, date: string, http: HttpOptions, fast: boolean): Promise<number | null> {
  const ymd = date.replace(/-/g, '');
  if (symbol === 'MARGIN' || symbol === 'MARGIN_BALANCE' || symbol === 'MARGIN_RATIO') {
    const m = await marginDay(date, http, fast);
    if (!m) return null;
    if (symbol === 'MARGIN') return m.change;
    if (symbol === 'MARGIN_BALANCE') return m.balance;
    const prices = await closePrices(date, http, fast);
    return prices ? computeMarginRatio(m, prices) : null;
  }
  let p = bfiCache.get(date);
  if (!p) {
    p = (async () => {
      await throttle(fast);
      const j = await getJson<Bfi82u>(`https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${ymd}&response=json`, http);
      return parseBfi82u(j);
    })();
    bfiCache.set(date, p);
  }
  const r = await p;
  return r ? r[symbol] : null;
}

export async function fetchTwseChips(
  symbol: TwseChipSymbol,
  cached: Bar[] | null,
  today: string,
  http: HttpOptions,
  fast = false,
): Promise<SourceFetchResult> {
  const target = addDays(today, -(symbol === 'MARGIN_RATIO' ? MARGIN_RATIO_BACKFILL_DAYS : TWSE_CHIPS_BACKFILL_DAYS));
  // 快取太少（例如早期版本被限流而留下缺洞）時，視同無快取重新抓最近 40 個工作日；結果仍會與舊快取合併
  if (cached && cached.length < 20) cached = null;
  const first = cached?.[0]?.[0] ?? null;
  const last = cached?.at(-1)?.[0] ?? null;
  // 最新：自上次最後一天（含）起；無快取則從今天往回
  // 為避免資料出現「中間缺洞」：最新段由舊到新、回補段由新到舊，遇到錯誤就停在該處，下次執行從斷點繼續。
  const recent = (last ? weekdaysBackward(today, last, 30) : weekdaysBackward(today, target, BACKFILL_PER_RUN)).reverse();
  const older = first && first > target ? weekdaysBackward(addDays(first, -1), target, BACKFILL_PER_RUN) : [];

  const bars: Bar[] = [];
  let lastError: unknown = null;
  for (const segment of [recent, older]) {
    for (const d of segment) {
      try {
        const v = await dayValue(symbol, d, http, fast);
        if (v !== null && Number.isFinite(v)) bars.push([d, v, v, v, v]);
      } catch (e) {
        lastError = e;
        console.warn(`  [twse_chips] ${symbol} ${d} 失敗，本段停止：${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
  }
  if (bars.length === 0) {
    if (lastError) throw lastError;
    throw new Error('證交所沒有回傳任何資料（可能休市或尚未公布）');
  }
  bars.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { bars, closeOnly: true, partial: false, incremental: true };
}
