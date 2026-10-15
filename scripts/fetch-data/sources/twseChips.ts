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
 * 漲跌家數：MI_INDEX 的「漲跌證券數合計」股票欄（2011 年中以前無此表，改由逐檔收盤行情推算）
 *
 * 大盤融資維持率（推算，上市、含 ETF）＝ Σ(逐檔融資餘額張數 × 1000 × 收盤價) ÷ 融資金額餘額 × 100%
 *   無收盤價（暫停交易等）的個股略過，影響通常 < 0.1 個百分點；
 *   2026-10-12 試算 196.16%，與愛玩股公布值一致。
 *
 * 為避免單次執行過久，採「漸進回補」：每次執行除了補最新幾天，
 * 另往前回補最多 BACKFILL_PER_RUN 個工作日，直到 BACKFILL_DAYS 天前。
 * 同一天的 BFI82U 回應由外資／投信／自營商三個指標共用（每次執行內快取）。
 */

export type TwseChipSymbol =
  | 'FOREIGN'
  | 'TRUST'
  | 'DEALER'
  | 'MARGIN'
  | 'MARGIN_BALANCE'
  | 'MARGIN_RATIO'
  | 'LIMIT_UP'
  | 'LIMIT_DOWN'
  | 'ADVANCE'
  | 'DECLINE';

/** 由每日收盤行情（MI_INDEX）取得的漲跌家數類指標 */
const BREADTH_SYMBOLS = ['LIMIT_UP', 'LIMIT_DOWN', 'ADVANCE', 'DECLINE'] as const;
type BreadthSymbol = (typeof BREADTH_SYMBOLS)[number];
const isBreadth = (s: TwseChipSymbol): s is BreadthSymbol => (BREADTH_SYMBOLS as readonly string[]).includes(s);

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

/** 上市「股票」漲跌家數（不含 ETF、權證） */
export interface Breadth {
  up: number;
  upLimit: number;
  down: number;
  downLimit: number;
  flat: number;
  /** official＝證交所「漲跌證券數合計」；computed＝逐檔推算（2011 年中以前無此表） */
  source: 'official' | 'computed';
}

/** 解析「6,123(45)」→ [6123, 45] */
function countWithLimit(s: string | undefined): [number, number] {
  const m = String(s ?? '').replace(/,/g, '').match(/^\s*(\d+)\s*(?:\((\d+)\))?/);
  if (!m) return [NaN, NaN];
  return [Number(m[1]), Number(m[2] ?? 0)];
}

/** 證交所「漲跌證券數合計」表的「股票」欄 */
export function parseOfficialBreadth(json: MiIndex): Breadth | null {
  const t = json.tables?.find((x) => x.title === '漲跌證券數合計' || (x.fields?.[0] === '類型' && x.fields.includes('股票')));
  if (!t?.data?.length) return null;
  const col = t.fields!.indexOf('股票');
  if (col < 0) return null;
  const row = (prefix: string) => t.data!.find((r) => (r[0] ?? '').startsWith(prefix))?.[col];
  const [up, upLimit] = countWithLimit(row('上漲'));
  const [down, downLimit] = countWithLimit(row('下跌'));
  const [flat] = countWithLimit(row('持平'));
  if (![up, upLimit, down, downLimit].every(Number.isFinite)) return null;
  return { up, upLimit, down, downLimit, flat: Number.isFinite(flat) ? flat : 0, source: 'official' };
}

/** 升降單位（2015 年以前與現行相同的六級距，足以判斷漲跌停價） */
function tickSize(p: number): number {
  if (p < 10) return 0.01;
  if (p < 50) return 0.05;
  if (p < 100) return 0.1;
  if (p < 500) return 0.5;
  if (p < 1000) return 1;
  return 5;
}

/** 漲跌幅限制：2015-06-01 起由 7% 放寬為 10% */
export const limitPctOn = (date: string) => (date >= '2015-06-01' ? 0.1 : 0.07);

/**
 * 由逐檔收盤行情推算漲跌停家數（只算 4 位數普通股代號）。
 * 前日收盤＝收盤 ∓ 漲跌價差；漲停價＝前日×(1+限制) 向下取到升降單位，跌停價向上取。
 * 與官方值比對：2011-12-19 跌停 123 vs 120、2020-03-19 382 vs 380。
 */
export function computeBreadth(json: MiIndex, date: string): Breadth | null {
  const t = json.tables?.find((x) => x.fields?.includes('證券代號') && x.fields.includes('收盤價'));
  if (!t) return null;
  const f = t.fields!;
  const iCode = f.indexOf('證券代號');
  const iClose = f.indexOf('收盤價');
  const iSign = f.indexOf('漲跌(+/-)');
  const iDiff = f.indexOf('漲跌價差');
  if (iSign < 0 || iDiff < 0) return null;
  const lp = limitPctOn(date);
  const b: Breadth = { up: 0, upLimit: 0, down: 0, downLimit: 0, flat: 0, source: 'computed' };
  for (const r of t.data ?? []) {
    if (!/^[1-9]\d{3}$/.test((r[iCode] ?? '').trim())) continue;
    const close = num(r[iClose]);
    if (!(close > 0)) continue;
    const signText = r[iSign] ?? '';
    const sign = signText.includes('+') ? 1 : signText.includes('-') ? -1 : 0;
    const diff = num(r[iDiff]);
    if (sign === 0 || !(diff > 0)) {
      if (sign === 0) b.flat++;
      continue;
    }
    const prev = close - sign * diff;
    const raw = prev * (1 + sign * lp);
    const tk = tickSize(raw);
    const limit = sign > 0 ? Math.floor(raw / tk + 1e-9) * tk : Math.ceil(raw / tk - 1e-9) * tk;
    if (sign > 0) {
      b.up++;
      if (close >= limit - 1e-9) b.upLimit++;
    } else {
      b.down++;
      if (close <= limit + 1e-9) b.downLimit++;
    }
  }
  return b.up + b.down + b.flat > 0 ? b : null;
}

export function parseBreadth(json: MiIndex, date: string): Breadth | null {
  if (json.stat !== 'OK') return null;
  return parseOfficialBreadth(json) ?? computeBreadth(json, date);
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
const priceCache = new Map<string, Promise<{ prices: Map<string, number> | null; breadth: Breadth | null }>>();

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

/** 每日收盤行情：同一份回應同時提供逐檔收盤價（維持率）與漲跌家數 */
function closeDay(date: string, http: HttpOptions, fast: boolean): Promise<{ prices: Map<string, number> | null; breadth: Breadth | null }> {
  let p = priceCache.get(date);
  if (!p) {
    p = (async () => {
      await throttle(fast);
      const j = await getJson<MiIndex>(
        `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date.replace(/-/g, '')}&type=ALLBUT0999&response=json`,
        http,
      );
      return { prices: parseMiIndexPrices(j), breadth: parseBreadth(j, date) };
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
    const { prices } = await closeDay(date, http, fast);
    return prices ? computeMarginRatio(m, prices) : null;
  }
  if (isBreadth(symbol)) {
    const { breadth: b } = await closeDay(date, http, fast);
    if (!b) return null;
    return symbol === 'LIMIT_UP' ? b.upLimit : symbol === 'LIMIT_DOWN' ? b.downLimit : symbol === 'ADVANCE' ? b.up : b.down;
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
  const target = addDays(today, -(symbol === 'MARGIN_RATIO' || isBreadth(symbol) ? MARGIN_RATIO_BACKFILL_DAYS : TWSE_CHIPS_BACKFILL_DAYS));
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
