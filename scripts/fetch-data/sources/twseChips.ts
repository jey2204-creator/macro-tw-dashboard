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
 * 借券賣出：融券借券賣出餘額 TWT93U（逐檔，單位「股」）：借券賣出「當日賣出／當日還券／當日餘額」加總（股→萬張）。
 *   借券放空者幾乎都是外資／法人；全市場加總值與媒體引用的「外資借券放空總張數」同一口徑（上市）。
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
  | 'DECLINE'
  | 'SBL_SELL_BAL'
  | 'SBL_SELL'
  | 'SBL_RETURN';

/** 由每日收盤行情（MI_INDEX）取得的漲跌家數類指標 */
const BREADTH_SYMBOLS = ['LIMIT_UP', 'LIMIT_DOWN', 'ADVANCE', 'DECLINE'] as const;
type BreadthSymbol = (typeof BREADTH_SYMBOLS)[number];
const isBreadth = (s: TwseChipSymbol): s is BreadthSymbol => (BREADTH_SYMBOLS as readonly string[]).includes(s);
/** 由融券借券賣出餘額（TWT93U）取得的借券類指標 */
const SBL_SYMBOLS = ['SBL_SELL_BAL', 'SBL_SELL', 'SBL_RETURN'] as const;
type SblSymbol = (typeof SBL_SYMBOLS)[number];
const isSbl = (s: TwseChipSymbol): s is SblSymbol => (SBL_SYMBOLS as readonly string[]).includes(s);

export const TWSE_CHIPS_BACKFILL_DAYS = 365;
/** 維持率每天多一個大檔請求，回補較短 */
export const MARGIN_RATIO_BACKFILL_DAYS = 183;
export const BACKFILL_PER_RUN = 40;
/** 借券（TWT93U）回應慢（約 10 秒／天，40 天約 8 分鐘）；首次抓 40 個工作日才看得到近兩個月 */
export const SBL_BACKFILL_PER_RUN = 40;
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
export function tickSize(p: number): number {
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

interface Twt93u {
  stat?: string;
  fields?: string[];
  data?: string[][];
  groups?: { start?: number; span?: number; title?: string }[];
  tables?: { fields?: string[]; data?: string[][]; groups?: { start?: number; span?: number; title?: string }[] }[];
}

/** 上市借券賣出合計（萬張） */
export interface SblDay {
  /** 借券賣出當日餘額加總 */
  balance: number;
  /** 當日借券賣出加總 */
  sell: number;
  /** 當日還券加總 */
  ret: number;
}

const wan = (v: number) => Math.round((v / 1e7) * 100) / 100; // 股 → 萬張（÷1000 張 ÷10000 萬），取 2 位

/**
 * 解析 TWT93U（融券借券賣出餘額，逐檔）：加總借券賣出的當日賣出／當日還券／當日餘額。
 * 欄位同時相容兩種寫法：欄名自帶「借券賣出」前綴，或以 groups 分組（融券／借券賣出）而欄名只寫「當日賣出」等。
 * 查無資料回傳 null；欄位找不到則擲錯（錯誤訊息附欄名，方便從 Actions 記錄看出格式變動）。
 */
export function parseTwt93u(json: Twt93u): SblDay | null {
  if (json.stat !== 'OK') return null;
  const t = json.tables?.find((x) => x.fields?.some((f) => /當日餘額|今日餘額|借券/.test(f))) ?? json;
  const f = t.fields ?? [];
  // groups 只有 span 沒有 start：依序累加算出「借券賣出」那組的欄位範圍
  let gStart = -1;
  let gEnd = -1;
  let pos = 0;
  for (const g of t.groups ?? []) {
    const span = g.span ?? 0;
    if ((g.title ?? '').includes('借券')) {
      gStart = pos;
      gEnd = pos + span;
    }
    pos += span;
  }
  const inSbl = (i: number) => f[i]!.includes('借券') || (gStart >= 0 && i >= gStart && i < gEnd);
  const find = (re: RegExp) => f.findIndex((name, i) => re.test(name.replace(/^借券賣出/, '')) && (inSbl(i) || /當日/.test(name)));
  // 現行格式（2012 年中起）：前日餘額／當日賣出／當日還券／當日調整／當日餘額／次一營業日可限額
  // 舊格式（～2012 年上半）：前日餘額／賣出／庫存異動／今日餘額／可使用額度，沒有「還券」欄，還券＝前日＋賣出−今日（含調整）
  let iBal = find(/^(當日|今日)餘額$/);
  let iSell = find(/^(當日)?賣出$/);
  let iRet = find(/^當日還券$/);
  const iPrev = find(/^前日餘額$/);
  if ((iBal < 0 || iSell < 0) && gStart < 0 && f.length >= 13) [iSell, iRet, iBal] = [9, 10, 12];
  if (iBal < 0 || iSell < 0 || (iRet < 0 && iPrev < 0)) throw new Error(`TWT93U 欄位異常：${f.join(',')}`);
  let sell = 0;
  let ret = 0;
  let bal = 0;
  let n = 0;
  for (const r of t.data ?? []) {
    if (!/^\d{4,6}[A-Z]?$/.test((r[0] ?? '').trim())) continue;
    const b = num(r[iBal]);
    if (!Number.isFinite(b)) continue;
    bal += b;
    const sv = num(r[iSell]);
    sell += Number.isFinite(sv) ? sv : 0;
    if (iRet >= 0) {
      const rv = num(r[iRet]);
      ret += Number.isFinite(rv) ? rv : 0;
    } else {
      const pv = num(r[iPrev]);
      if (Number.isFinite(pv) && Number.isFinite(sv)) ret += Math.max(0, pv + sv - b);
    }
    n++;
  }
  if (n === 0) return null;
  return { balance: wan(bal), sell: wan(sell), ret: wan(ret) };
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
const sblCache = new Map<string, Promise<SblDay | null>>();

export function resetTwseChipsCache(): void {
  bfiCache.clear();
  marginCache.clear();
  priceCache.clear();
  sblCache.clear();
}

/** 融券借券賣出餘額（TWT93U）：同一天由三個借券指標共用 */
function sblDay(date: string, http: HttpOptions, fast: boolean): Promise<SblDay | null> {
  let p = sblCache.get(date);
  if (!p) {
    p = (async () => {
      await throttle(fast);
      // 整個市場逐檔約 1,300 列，證交所回應較慢，逾時放寬
      const j = await getJson<Twt93u>(`https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=${date.replace(/-/g, '')}&response=json`, {
        ...http,
        timeoutMs: Math.max(http.timeoutMs ?? 0, 45_000),
      });
      return parseTwt93u(j);
    })();
    sblCache.set(date, p);
  }
  return p;
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
  if (isSbl(symbol)) {
    const d = await sblDay(date, http, fast);
    if (!d) return null;
    return symbol === 'SBL_SELL_BAL' ? d.balance : symbol === 'SBL_SELL' ? d.sell : d.ret;
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
  const target = addDays(today, -(symbol === 'MARGIN_RATIO' || isBreadth(symbol) || isSbl(symbol) ? MARGIN_RATIO_BACKFILL_DAYS : TWSE_CHIPS_BACKFILL_DAYS));
  // 快取太少（例如早期版本被限流而留下缺洞）時，視同無快取重新抓最近 40 個工作日；結果仍會與舊快取合併
  if (cached && cached.length < 20) cached = null;
  const first = cached?.[0]?.[0] ?? null;
  const last = cached?.at(-1)?.[0] ?? null;
  // 最新：自上次最後一天（含）起；無快取則從今天往回
  // 為避免資料出現「中間缺洞」：最新段由舊到新、回補段由新到舊，遇到錯誤就停在該處，下次執行從斷點繼續。
  const perRun = isSbl(symbol) ? SBL_BACKFILL_PER_RUN : BACKFILL_PER_RUN;
  const recent = (last ? weekdaysBackward(today, last, 30) : weekdaysBackward(today, target, perRun)).reverse();
  const older = first && first > target ? weekdaysBackward(addDays(first, -1), target, perRun) : [];
  // 借券（TWT93U）：單日逾時（休市日或證交所暫時變慢）只略過該日、不停整段，否則一個壞日會永遠卡住最新段；
  // 略過造成的缺洞由下一次執行補：快取範圍內不在快取的工作日（最多 10 天）排在最後補抓
  const skipOnTimeout = isSbl(symbol);
  const gaps: string[] = [];
  if (skipOnTimeout && cached && first && last) {
    const have = new Set(cached.map((b) => b[0]));
    for (const d of weekdaysBackward(addDays(last, -1), addDays(first, 1), 10_000)) {
      if (!have.has(d)) gaps.push(d);
      if (gaps.length >= 10) break;
    }
  }

  const bars: Bar[] = [];
  let lastError: unknown = null;
  for (const segment of [recent, older, gaps]) {
    for (const d of segment) {
      try {
        const v = await dayValue(symbol, d, http, fast);
        if (v !== null && Number.isFinite(v)) bars.push([d, v, v, v, v]);
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (skipOnTimeout && (segment === gaps || /abort/i.test(msg))) {
          console.warn(`  [twse_chips] ${symbol} ${d} 失敗，略過該日：${msg}`);
          continue;
        }
        console.warn(`  [twse_chips] ${symbol} ${d} 失敗，本段停止：${msg}`);
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
