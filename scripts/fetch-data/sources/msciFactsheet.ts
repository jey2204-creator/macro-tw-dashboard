import type { SourceSpec } from '../../../src/shared/indicators';
import type { MsciRecord } from '../../../src/shared/msciTw';
import type { Bar } from '../../../src/shared/types';
import { getBytes, getJson, sleep, type HttpOptions } from '../http';
import { pdfLines, type PdfLine, type PdfWord } from '../pdf';
import type { SourceFetchResult } from './types';

/**
 * MSCI 台灣指數 factsheet（PDF，每月更新一次，內容為上個月底）：
 *  - FUNDAMENTALS：預估本益比（P/E Fwd＝價格 ÷ 未來 12 個月預估 EPS）、本益比（近 12 月）、股價淨值比、殖利率
 *  - 報酬（美元、含息）：1 個月、今年以來；年度報酬表（近 14 年）——前端用來把各期接成「未來 12 月 EPS 預估」走勢
 *  - 同表的全球指數 MSCI ACWI IMI 預估本益比（台股相對全球的溢價）
 *
 * 2026-10-20 探測（GitHub Actions，暫時 workflow「台股預估本益比資料源探測」）：
 *  - 官方指數頁 msci.com/indexes/index/915800 對 GitHub 主機回驗證挑戰頁；factsheet PDF 可直接下載
 *  - Wayback Machine 有 15 份同一網址的存檔（2021-01～2026-05 的月底值，14 個不同月份），沒有快取時一次回補
 *  - 2021 年至今版面相同（Apache FOP 產生）；文字以 scripts/fetch-data/pdf.ts 依座標擷取，15 份與 pdftotext 比對一致
 *
 * 每次執行：快取已有上個月底就不抓；否則抓現行 factsheet（還沒換成新月份時，合併後不變，隔天再試）。
 * 解析到的完整紀錄放在 parsedFactsheets，由 writeMsciTw.ts 併入 public/data/msci-tw.json。
 */

export type MsciSymbol = Extract<SourceSpec, { provider: 'msci_tw' }>['symbol'];
export type MsciKrSymbol = Extract<SourceSpec, { provider: 'msci_kr' }>['symbol'];

/** MSCI Taiwan Index (USD) factsheet（網址固定，每月覆寫） */
export const MSCI_TW_FACTSHEET = 'https://www.msci.com/documents/10199/6f36d84d-425d-4e1f-8d56-e65c455ebda1';
/** MSCI Korea Index (USD) factsheet（網址固定，每月覆寫；2026-10-24 WebFetch 確認版面與台灣相同） */
export const MSCI_KR_FACTSHEET = 'https://www.msci.com/documents/10199/255599/msci-korea-index.pdf';

/** 一個市場的 factsheet 設定：網址、FUNDAMENTALS 表裡該指數那一列的開頭、記錄緩衝 */
export interface MsciMarket {
  key: 'tw' | 'kr';
  url: string;
  /** 指數列開頭（「MSCI Taiwan 1.23 …」） */
  row: RegExp;
  label: string;
}
export const MSCI_MARKETS: Record<MsciMarket['key'], MsciMarket> = {
  tw: { key: 'tw', url: MSCI_TW_FACTSHEET, row: /^MSCI Taiwan -?\d/, label: 'MSCI Taiwan' },
  kr: { key: 'kr', url: MSCI_KR_FACTSHEET, row: /^MSCI Korea -?\d/, label: 'MSCI Korea' },
};

export interface MsciFactsheet extends MsciRecord {
  /** 年度報酬表：年份 → MSCI 台灣（%，美元、含息） */
  annual: Record<string, number>;
}

/** 本次執行解析到的台灣 factsheet（資料日 → 紀錄）；writeMsciTw 寫檔用 */
export const parsedFactsheets = new Map<string, MsciFactsheet>();
/** 本次執行解析到的韓國 factsheet（資料日 → 紀錄） */
export const parsedKrFactsheets = new Map<string, MsciFactsheet>();
const parsedOf = (m: MsciMarket) => (m.key === 'kr' ? parsedKrFactsheets : parsedFactsheets);

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const NUM = /^-?\d+(?:\.\d+)?$/;
const center = (w: { x0: number; x1: number }) => (w.x0 + w.x1) / 2;

/** 同一行內，間距小於約 0.8 字高的詞合併成一個欄名（「P/E Fwd」「Div Yld (%)」「1 Mo」） */
function phrases(line: PdfLine): PdfWord[] {
  const out: PdfWord[] = [];
  for (const w of line.words) {
    const last = out.at(-1);
    if (last && w.x0 - last.x1 < w.size * 0.8) {
      last.text += ` ${w.text}`;
      last.x1 = w.x1;
    } else out.push({ ...w });
  }
  return out;
}

/** 欄名下方「指數名稱」那一列，取最接近欄名中心的數字 */
function rowValue(row: PdfLine | undefined, head: PdfWord | undefined): number | null {
  if (!row || !head) return null;
  const c = center(head);
  let best: { d: number; v: number } | null = null;
  for (const w of row.words) {
    if (!NUM.test(w.text)) continue;
    const d = Math.abs(center(w) - c);
    if (d < 22 && (!best || d < best.d)) best = { d, v: Number(w.text) };
  }
  return best?.v ?? null;
}

/** 年度報酬表（右上）：「2025 39.84 34.36 22.60」→ 年份後第一個數字是 MSCI 台灣 */
function annualTable(lines: readonly PdfLine[], page: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    if (l.page !== page) continue;
    l.words.forEach((w, i) => {
      if (!/^(19|20)\d\d$/.test(w.text) || w.x0 < 380) return;
      const next = l.words.slice(i + 1).filter((x) => NUM.test(x.text));
      if (next.length >= 2 && next[0]!.x0 > w.x1) out[w.text] = Number(next[0]!.text);
    });
  }
  return out;
}

export function parseMsciFactsheet(lines: readonly PdfLine[], market: MsciMarket = MSCI_MARKETS.tw): MsciFactsheet {
  const dateLine = lines.find((l) => /FUNDAMENTALS/.test(l.text));
  const dm = dateLine && /FUNDAMENTALS \(([A-Z]{3}) (\d{1,2}), (\d{4})\)/.exec(dateLine.text);
  if (!dm || !MONTHS[dm[1]!]) throw new Error('MSCI factsheet 找不到 FUNDAMENTALS 日期（版面可能改變）');
  const asOf = `${dm[3]}-${String(MONTHS[dm[1]!]).padStart(2, '0')}-${dm[2]!.padStart(2, '0')}`;

  const header = lines.find(
    (l) => l.page === dateLine!.page && l.y < dateLine!.y && l.words.some((w) => w.text === 'P/BV') && l.words.some((w) => w.text === 'Fwd'),
  );
  if (!header) throw new Error('MSCI factsheet 找不到 P/E Fwd 欄名');
  const heads = phrases(header);
  const col = (name: string) => heads.find((h) => h.text === name);
  // 欄名下方第一個以指數名稱開頭的列
  const rowOf = (name: RegExp) =>
    lines.filter((l) => l.page === header.page && l.y < header.y && name.test(l.text)).sort((a, b) => b.y - a.y)[0];
  const tw = rowOf(market.row);
  if (!tw) throw new Error(`MSCI factsheet 找不到 ${market.label} 列`);
  const acwi = rowOf(/^MSCI ACWI IMI -?\d/);
  const fwdPe = rowValue(tw, col('P/E Fwd'));
  if (fwdPe === null || !(fwdPe > 0)) throw new Error('MSCI factsheet 解析不到預估本益比');
  return {
    asOf,
    fwdPe,
    pe: rowValue(tw, col('P/E')),
    pbv: rowValue(tw, col('P/BV')),
    dy: rowValue(tw, col('Div Yld (%)')),
    ret1m: rowValue(tw, col('1 Mo')),
    ytd: rowValue(tw, col('YTD')),
    acwiFwdPe: rowValue(acwi, col('P/E Fwd')),
    annual: annualTable(lines, header.page),
  };
}

export function parseMsciPdf(buf: Uint8Array, market: MsciMarket = MSCI_MARKETS.tw): MsciFactsheet {
  return parseMsciFactsheet(pdfLines(buf), market);
}

// ── 抓取 ─────────────────────────────────────────────────────

/** 一次執行內共用（每個市場一份） */
const runCache = new Map<MsciMarket['key'], Promise<MsciFactsheet[]>>();
export function clearMsciCache() {
  runCache.clear();
  parsedFactsheets.clear();
  parsedKrFactsheets.clear();
}

/** Wayback Machine 上同一網址的存檔（時間戳記），只取 HTTP 200、內容不重複者 */
async function waybackSnapshots(market: MsciMarket, http: HttpOptions): Promise<string[]> {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(market.url.replace(/^https:\/\//, ''))}&output=json&fl=timestamp,statuscode&collapse=digest&limit=500`;
  const rows = await getJson<string[][]>(url, http);
  return rows
    .slice(1)
    .filter((r) => r[1] === '200')
    .map((r) => r[0]!);
}

async function loadAll(market: MsciMarket, backfill: boolean, http: HttpOptions, fast: boolean): Promise<MsciFactsheet[]> {
  const tag = `msci_${market.key}`;
  const out: MsciFactsheet[] = [parseMsciPdf(await getBytes(market.url, http), market)];
  if (backfill) {
    try {
      for (const ts of await waybackSnapshots(market, http)) {
        if (!fast) await sleep(1500);
        try {
          out.push(parseMsciPdf(await getBytes(`https://web.archive.org/web/${ts}id_/${market.url}`, http), market));
        } catch (e) {
          console.warn(`  [${tag}] Wayback ${ts} 略過：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      console.warn(`  [${tag}] Wayback 清單無法取得，只用現行 factsheet：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const parsed = parsedOf(market);
  for (const f of out) parsed.set(f.asOf, f);
  return out;
}

/** 欄位 → 月底序列（同一資料日多份取最後解析到的） */
export function msciBars(list: readonly MsciFactsheet[], field: 'fwdPe' | 'pe' | 'pbv' = 'fwdPe'): Bar[] {
  const byDate = new Map<string, number>();
  for (const f of list) {
    const v = f[field];
    if (v !== null && v > 0) byDate.set(f.asOf, v);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => [d, v, v, v, v]);
}

const iso = (t: Date) => t.toISOString().slice(0, 10);

/** 上個月最後一天往前 5 天：月底若是假日，factsheet 的資料日會早幾天 */
export function prevMonthEndFloor(today: string): string {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCDate(0);
  d.setUTCDate(d.getUTCDate() - 5);
  return iso(d);
}

async function fetchMsci(
  market: MsciMarket,
  field: 'fwdPe' | 'pe' | 'pbv',
  cached: Bar[] | null,
  today: string,
  http: HttpOptions,
  fast: boolean,
): Promise<SourceFetchResult> {
  const last = cached?.at(-1)?.[0] ?? null;
  // 上個月底已在快取 → 下一份要到下個月才出，不必再抓
  if (cached && cached.length > 0 && last && last >= prevMonthEndFloor(today)) {
    return { bars: cached, closeOnly: true, partial: false, incremental: true };
  }
  let p = runCache.get(market.key);
  if (!p) {
    p = loadAll(market, !cached || cached.length === 0, http, fast);
    runCache.set(market.key, p);
    p.catch(() => runCache.delete(market.key));
  }
  return { bars: msciBars(await p, field), closeOnly: true, partial: false, incremental: true };
}

export function fetchMsciTaiwan(_symbol: MsciSymbol, cached: Bar[] | null, today: string, http: HttpOptions, fast = false) {
  return fetchMsci(MSCI_MARKETS.tw, 'fwdPe', cached, today, http, fast);
}

const KR_FIELD: Record<MsciKrSymbol, 'fwdPe' | 'pe' | 'pbv'> = { FWD_PE: 'fwdPe', PE: 'pe', PBV: 'pbv' };

/** MSCI 韓國：預估本益比／近 12 月本益比／淨值比（同一份 factsheet，一次執行只下載一次） */
export function fetchMsciKorea(symbol: MsciKrSymbol, cached: Bar[] | null, today: string, http: HttpOptions, fast = false) {
  return fetchMsci(MSCI_MARKETS.kr, KR_FIELD[symbol], cached, today, http, fast);
}
