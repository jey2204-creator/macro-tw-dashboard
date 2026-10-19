import { inflateRawSync } from 'node:zlib';
import { TW_GOV_DATASET_ID, type SourceSpec } from '../../../src/shared/indicators';
import type { Bar } from '../../../src/shared/types';
import { getBytes, getJson, getText, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * 台灣官方總經資料（政府資料開放平台 data.gov.tw 登錄的資料集，檔案放在各機關網站）。
 *
 * 2026-10-19 探測（GitHub Actions，暫時性 workflow「台灣景氣資料源探測」，共五輪）：
 *  - data.gov.tw API v2 可用，回傳各資料集目前的下載網址（國發會的網址會隨上傳改變，所以每次動態查）
 *  - 國發會 index.ndc.gov.tw、經濟部首頁對 GitHub 主機回 403；檔案主機 ws.ndc.gov.tw、service.moea.gov.tw、
 *    財政部 web02.mof.gov.tw、央行 www.cbc.gov.tw，以及經濟部統計處新聞稿頁（bulletin）皆可用（誠實 UA）
 *  - 主計總處 ws.dgbas.gov.tw、www.stat.gov.tw 未附中繼憑證（Node 驗證失敗），本模組不使用
 *  - 經濟部外銷訂單開放資料比新聞稿晚約一個月（10/19 時只到 7 月，8 月已於 9/22 公布）→ 用新聞稿補最新月份
 *
 * | 代號 | 資料集 | 內容 |
 * |---|---|---|
 * | NDC_SIGNAL | 6099 景氣指標及燈號（ZIP） | 景氣對策信號綜合分數 9–45，1984 年起 |
 * | NDC_PMI | 6100 臺灣採購經理人指數 | 製造業 PMI（季調），2012-07 起 |
 * | MOF_EXPORTS | 8380 出口值_按主要貨品分（財政部） | 出口總值（百萬美元），2001 年起 |
 * | MOEA_ORDERS | 6845 外銷訂單（經濟部統計處）＋新聞稿 | 外銷訂單金額（百萬美元），1984 年起 |
 * | CBC_M1B_M2 | 6024 貨幣總計數（央行 EF15M01，日平均） | M1B 年增率 − M2 年增率（百分點），1988 年起 |
 */

export type TwGovSymbol = Extract<SourceSpec, { provider: 'tw_gov' }>['symbol'];

interface DatasetSpec {
  id: number;
  /** 從資料集的多個資源中挑一個（預設第一個） */
  pick?: (url: string) => boolean;
  /** API 失敗時的備援網址（2026-10 探測時的實際網址） */
  fallback: string;
}

export const TW_GOV_DATASETS: Record<TwGovSymbol, DatasetSpec> = {
  NDC_SIGNAL: {
    id: TW_GOV_DATASET_ID.NDC_SIGNAL,
    fallback:
      'https://ws.ndc.gov.tw/Download.ashx?u=LzAwMS9hZG1pbmlzdHJhdG9yLzEwL3JlbGZpbGUvNTc4MS82MzkyL2VhMjM1YmQ5LWQwNTItNGE2OS1hYmZjLWQ1Yzc4NWQzZDBlMi56aXA%3d&n=5pmv5rCj5oyH5qiZ5Y%2bK54eI6JmfLnppcA%3d%3d&icon=.zip',
  },
  NDC_PMI: {
    id: TW_GOV_DATASET_ID.NDC_PMI,
    fallback:
      'https://ws.ndc.gov.tw/Download.ashx?u=LzAwMS9hZG1pbmlzdHJhdG9yLzEwL3JlbGZpbGUvNTc4MS82MzkxL2JmOGE0ZWI3LTEwZmUtNGZhMC1iNjQ2LTMwZTg5MGQwMjE4YS5jc3Y%3d&n=6Ie654Gj5o6h6LO857aT55CG5Lq65oyH5pW4KHBtaeWPim5taSkuY3N2&icon=.csv',
  },
  MOF_EXPORTS: {
    id: TW_GOV_DATASET_ID.MOF_EXPORTS,
    fallback:
      'https://web02.mof.gov.tw/njswww/webMain.aspx?sys=220&ym=9000&kind=21&type=4&funid=i8121&cycle=41&outmode=12&compmode=00&outkind=1&fld0=1&codlst0=1101111010100011110111100111110110100&utf=1',
  },
  MOEA_ORDERS: { id: TW_GOV_DATASET_ID.MOEA_ORDERS, fallback: 'https://service.moea.gov.tw/EE520/opendata/b.csv' },
  CBC_M1B_M2: {
    id: TW_GOV_DATASET_ID.CBC_M1B_M2,
    pick: (u) => /EF15M01/i.test(safeDecode(u)),
    fallback: 'https://www.cbc.gov.tw/public/data/OpenData/%E7%B6%93%E7%A0%94%E8%99%95/EF15M01.csv',
  },
};

function safeDecode(u: string): string {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

// ── CSV／ZIP 解析 ────────────────────────────────────────────

/** 簡易 CSV 一行解析（支援雙引號欄位） */
export function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const lines = (text: string) => text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
const num = (s: string | undefined) => {
  if (s === undefined) return NaN;
  const t = s.replace(/,/g, '').trim();
  return t === '' || t === '-' ? NaN : Number(t);
};
const monthDate = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}-01`;
const bar = (date: string, v: number): Bar => [date, v, v, v, v];

/** 只讀 ZIP 的中央目錄並解壓（stored／deflate），檔名以 UTF-8 解讀 */
export function unzip(data: Uint8Array): Map<string, Uint8Array> {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 ZIP 檔（找不到中央目錄）');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map<string, Uint8Array>();
  for (let k = 0; k < count; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 中央目錄格式錯誤');
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + compSize);
    if (method === 0) out.set(name, new Uint8Array(raw));
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 從國發會 ZIP 找出「景氣指標與燈號」表：以表頭內容判斷，不依賴檔名編碼 */
export function ndcIndicatorCsv(zip: Map<string, Uint8Array>): string {
  for (const [name, buf] of zip) {
    if (name.startsWith('schema') || name.startsWith('manifest')) continue;
    const text = new TextDecoder('utf-8').decode(buf);
    const head = lines(text)[0] ?? '';
    if (head.includes('景氣對策信號綜合分數') && head.includes('領先指標不含趨勢指數')) return text;
  }
  throw new Error('國發會 ZIP 內找不到「景氣指標與燈號」表');
}

/** 國發會：景氣對策信號綜合分數、領先指標不含趨勢指數；另回傳燈號文字（紅／黃紅／綠／黃藍／藍） */
export function parseNdcIndicators(text: string): { signal: Bar[]; leading: Bar[]; light: Map<string, string> } {
  const rows = lines(text).map(csvLine);
  const head = rows[0] ?? [];
  const iDate = head.indexOf('Date');
  const iScore = head.indexOf('景氣對策信號綜合分數');
  const iLight = head.indexOf('景氣對策信號');
  const iLead = head.indexOf('領先指標不含趨勢指數');
  if ([iDate, iScore, iLight, iLead].some((i) => i < 0)) throw new Error(`國發會表頭不符：${head.join(',').slice(0, 120)}`);
  const signal: Bar[] = [];
  const leading: Bar[] = [];
  const light = new Map<string, string>();
  for (const r of rows.slice(1)) {
    const m = /^(\d{4})(\d{2})$/.exec(r[iDate] ?? '');
    if (!m) continue;
    const date = monthDate(Number(m[1]), Number(m[2]));
    const s = num(r[iScore]);
    if (Number.isFinite(s) && s >= 9 && s <= 45) {
      signal.push(bar(date, s));
      const l = (r[iLight] ?? '').replace(/\s/g, '');
      if (l) light.set(date, l);
    }
    const ld = num(r[iLead]);
    if (Number.isFinite(ld)) leading.push(bar(date, ld));
  }
  return { signal, leading, light };
}

/** 國發會 PMI：Date(YYYYMM), PMI, NMI → 製造業 PMI */
export function parseNdcPmi(text: string): Bar[] {
  const rows = lines(text).map(csvLine);
  const head = rows[0] ?? [];
  const iDate = head.indexOf('Date');
  const iPmi = head.indexOf('PMI');
  if (iDate < 0 || iPmi < 0) throw new Error(`PMI 表頭不符：${head.join(',')}`);
  const out: Bar[] = [];
  for (const r of rows.slice(1)) {
    const m = /^(\d{4})(\d{2})$/.exec(r[iDate] ?? '');
    const v = num(r[iPmi]);
    if (m && Number.isFinite(v)) out.push(bar(monthDate(Number(m[1]), Number(m[2])), v));
  }
  return out;
}

/** 財政部：「115年 9月」列的出口總值（百萬美元）；略過年合計列 */
export function parseMofExports(text: string): Bar[] {
  const rows = lines(text).map(csvLine);
  const head = rows[0] ?? [];
  const iTotal = head.findIndex((h) => h.includes('美元') && h.includes('總計'));
  if (iTotal < 0) throw new Error(`財政部出口表頭不符：${head.slice(0, 3).join(',')}`);
  const out: Bar[] = [];
  for (const r of rows.slice(1)) {
    const m = /^(\d{2,3})年\s*(\d{1,2})月$/.exec(r[0] ?? '');
    const v = num(r[iTotal]);
    if (m && Number.isFinite(v)) out.push(bar(monthDate(Number(m[1]) + 1911, Number(m[2])), v));
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 經濟部統計處：外銷訂單金額（百萬美元），資料期為民國年月「11507」 */
export function parseMoeaOrders(text: string): Bar[] {
  const rows = lines(text).map(csvLine);
  const head = rows[0] ?? [];
  const iItem = head.findIndex((h) => h.includes('統計項目'));
  const iPeriod = head.findIndex((h) => h.includes('資料期'));
  const iUsd = head.findIndex((h) => h.includes('統計值') && h.includes('美元'));
  if ([iItem, iPeriod, iUsd].some((i) => i < 0)) throw new Error(`外銷訂單表頭不符：${head.join(',')}`);
  const out: Bar[] = [];
  for (const r of rows.slice(1)) {
    if ((r[iItem] ?? '') !== '外銷訂單金額') continue;
    const m = /^(\d{3})(\d{2})$/.exec(r[iPeriod] ?? '');
    const v = num(r[iUsd]);
    if (m && Number.isFinite(v)) out.push(bar(monthDate(Number(m[1]) + 1911, Number(m[2])), v));
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 央行 EF15M01（日平均）：M1B 年增率 − M2 年增率（百分點）；期間「2026M08」 */
export function parseCbcMoney(text: string): { gap: Bar[]; m1b: Bar[]; m2: Bar[] } {
  const rows = lines(text).map(csvLine);
  const head = (rows[0] ?? []).map((h) => h.replace(/\s/g, ''));
  const iM1b = head.findIndex((h) => /Ｍ１Ｂ|M1B/.test(h) && h.includes('年增率'));
  const iM2 = head.findIndex((h) => /Ｍ２|M2/.test(h) && h.includes('年增率'));
  if (iM1b < 0 || iM2 < 0) throw new Error(`央行貨幣總計數表頭不符：${head.slice(25).join(',')}`);
  const gap: Bar[] = [];
  const m1b: Bar[] = [];
  const m2: Bar[] = [];
  for (const r of rows.slice(1)) {
    const m = /^(\d{4})M(\d{2})$/.exec(r[0] ?? '');
    if (!m) continue;
    const date = monthDate(Number(m[1]), Number(m[2]));
    const a = num(r[iM1b]);
    const b = num(r[iM2]);
    if (Number.isFinite(a)) m1b.push(bar(date, a));
    if (Number.isFinite(b)) m2.push(bar(date, b));
    if (Number.isFinite(a) && Number.isFinite(b)) gap.push(bar(date, Math.round((a - b) * 1e4) / 1e4));
  }
  return { gap, m1b, m2 };
}

// ── 經濟部統計處新聞稿（補開放資料尚未收錄的最新月份） ──────────

export const MOEA_BULLETIN_LIST = 'https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=5&html=1&menu_id=6724';
export const moeaBulletinUrl = (id: string) => `${MOEA_BULLETIN_LIST}&bull_id=${id}`;

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

/** 新聞稿列表：「115年8月外銷訂單統計」→ { bullId, month: '2026-08-01' }（由新到舊） */
export function parseMoeaBulletinList(html: string): { bullId: string; month: string }[] {
  const out: { bullId: string; month: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const label = decodeEntities(m[2]!.replace(/<[^>]+>/g, '')).trim();
    const t = /^(\d{2,3})年(\d{1,2})月外銷訂單統計$/.exec(label);
    const id = /bull_id=(\d+)/.exec(decodeEntities(m[1]!));
    if (!t || !id || seen.has(id[1]!)) continue;
    seen.add(id[1]!);
    out.push({ bullId: id[1]!, month: monthDate(Number(t[1]) + 1911, Number(t[2])) });
  }
  return out;
}

/** 新聞稿內文「8月外銷訂單1,029.6億美元」→ 百萬美元；月份需與標題一致 */
export function parseMoeaBulletinValue(html: string, month: string): number | null {
  const text = decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, '');
  const m = /(\d{1,2})月外銷訂單([\d,]+(?:\.\d+)?)億美元/.exec(text);
  if (!m || Number(m[1]) !== Number(month.slice(5, 7))) return null;
  const v = num(m[2]) * 100;
  return Number.isFinite(v) ? Math.round(v) : null;
}

/** 開放資料之後的月份用新聞稿補上（最多補 2 個月）；新聞稿失敗不影響開放資料 */
async function supplementOrders(bars: Bar[], http: HttpOptions): Promise<Bar[]> {
  const last = bars.at(-1)?.[0] ?? '';
  try {
    const list = parseMoeaBulletinList(await getText(MOEA_BULLETIN_LIST, http))
      .filter((b) => b.month > last)
      .slice(0, 2);
    const extra: Bar[] = [];
    for (const b of list) {
      const v = parseMoeaBulletinValue(await getText(moeaBulletinUrl(b.bullId), http), b.month);
      if (v !== null) extra.push(bar(b.month, v));
    }
    if (extra.length) console.log(`  [tw_gov] 外銷訂單以新聞稿補上 ${extra.map((b) => b[0].slice(0, 7)).join('、')}`);
    return [...bars, ...extra].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  } catch (e) {
    console.warn(`  [tw_gov] 外銷訂單新聞稿無法取得，只用開放資料：${e instanceof Error ? e.message : String(e)}`);
    return bars;
  }
}

// ── 抓取 ─────────────────────────────────────────────────────

interface DataGovDataset {
  result?: { distribution?: { resourceDownloadUrl?: string; resourceFormat?: string }[] };
}

/** 一次執行內共用下載結果（燈號與領先指標同一個 ZIP） */
const cache = new Map<string, Promise<Uint8Array>>();
export function clearTwGovCache() {
  cache.clear();
}

async function resolveUrl(spec: DatasetSpec, http: HttpOptions): Promise<string> {
  try {
    const j = await getJson<DataGovDataset>(`https://data.gov.tw/api/v2/rest/dataset/${spec.id}`, { ...http, retries: 1 });
    const urls = (j.result?.distribution ?? []).map((d) => d.resourceDownloadUrl ?? '').filter(Boolean);
    const url = spec.pick ? urls.find(spec.pick) : urls[0];
    if (url) return url;
  } catch {
    // 開放平台 API 暫時失敗 → 用已知網址
  }
  return spec.fallback;
}

async function download(symbol: TwGovSymbol, http: HttpOptions): Promise<Uint8Array> {
  const spec = TW_GOV_DATASETS[symbol];
  const key = `${spec.id}:${symbol}`;
  let p = cache.get(key);
  if (!p) {
    p = resolveUrl(spec, http).then((url) => getBytes(url, http));
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

const utf8 = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);

export async function fetchTwGov(symbol: TwGovSymbol, http: HttpOptions): Promise<SourceFetchResult> {
  const buf = await download(symbol, http);
  let bars: Bar[];
  switch (symbol) {
    case 'NDC_SIGNAL':
      bars = parseNdcIndicators(ndcIndicatorCsv(unzip(buf))).signal;
      break;
    case 'NDC_PMI':
      bars = parseNdcPmi(utf8(buf));
      break;
    case 'MOF_EXPORTS':
      bars = parseMofExports(utf8(buf));
      break;
    case 'MOEA_ORDERS':
      bars = await supplementOrders(parseMoeaOrders(utf8(buf)), http);
      break;
    case 'CBC_M1B_M2':
      bars = parseCbcMoney(utf8(buf)).gap;
      break;
  }
  if (bars.length < 24) throw new Error(`${symbol} 只解析到 ${bars.length} 筆，格式可能改變`);
  return { bars, closeOnly: true, partial: false, incremental: false };
}
