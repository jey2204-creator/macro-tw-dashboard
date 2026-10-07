import { toLocalDate } from '../../../src/shared/dates';
import { isValidBar } from '../../../src/shared/timeseries';
import type { Bar } from '../../../src/shared/types';
import { getJson, getText, HttpError, USER_AGENT, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * Yahoo Finance chart API（非官方、免金鑰）。
 * 注意：range=max 會被自動降採樣成月資料，必須使用 period1/period2 指定區間才會拿到日 K。
 */

interface YahooChart {
  chart: {
    result:
      | {
          meta: {
            exchangeTimezoneName?: string;
            regularMarketTime?: number;
            regularMarketPrice?: number;
            currentTradingPeriod?: { regular?: { start: number; end: number } };
          };
          timestamp?: number[];
          indicators: {
            quote: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[] }[];
          };
        }[]
      | null;
    error: { code: string; description: string } | null;
  };
}

export function yahooUrl(symbol: string, period1: number, period2: number, crumb?: string): string {
  const base = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false&events=`;
  return crumb ? `${base}&crumb=${encodeURIComponent(crumb)}` : base;
}

/** Yahoo 的 cookie + crumb 工作階段；遇到 401/429 時才取得，整次執行共用 */
interface YahooSession {
  cookie: string;
  crumb: string;
}
let sessionPromise: Promise<YahooSession> | null = null;

export function resetYahooSession(): void {
  sessionPromise = null;
}

async function getYahooSession(http: HttpOptions): Promise<YahooSession> {
  sessionPromise ??= (async () => {
    // fc.yahoo.com 會回 404，但帶有 Set-Cookie
    const res = await http.fetchImpl('https://fc.yahoo.com', { redirect: 'manual', headers: { 'User-Agent': USER_AGENT } });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const raw = h.getSetCookie?.() ?? (h.get('set-cookie') ?? '').split(/,(?=\s*\w+=)/);
    const cookie = raw
      .map((c) => c.split(';')[0]!.trim())
      .filter(Boolean)
      .join('; ');
    if (!cookie) throw new Error('Yahoo 未回傳 cookie');
    const crumb = (await getText('https://query2.finance.yahoo.com/v1/test/getcrumb', { ...http, retries: 1 }, { headers: { Cookie: cookie } })).trim();
    if (!crumb || crumb.length > 64 || /[<{]/.test(crumb)) throw new Error('Yahoo crumb 取得失敗');
    return { cookie, crumb };
  })();
  sessionPromise.catch(() => (sessionPromise = null));
  return sessionPromise;
}

export function parseYahooChart(json: YahooChart, nowSec: number): { bars: Bar[]; partial: boolean; timeZone: string } {
  if (json.chart.error) throw new Error(`Yahoo 錯誤：${json.chart.error.code} ${json.chart.error.description}`);
  const r = json.chart.result?.[0];
  if (!r) throw new Error('Yahoo 回應沒有 result');
  const tz = r.meta.exchangeTimezoneName ?? 'America/New_York';
  const ts = r.timestamp ?? [];
  const q = r.indicators.quote[0] ?? {};
  const byDate = new Map<string, Bar>();
  const rmt = r.meta.regularMarketTime;
  const rmp = r.meta.regularMarketPrice;
  const rmtDate = rmt !== undefined ? toLocalDate(rmt, tz) : null;
  for (let i = 0; i < ts.length; i++) {
    let c = q.close?.[i];
    // Yahoo 已知問題：最新一根日 K 收盤常為 null（如 ^TWII 收盤後），
    // 此時以 meta.regularMarketPrice（同一交易日）補上收盤價。
    if ((c === null || c === undefined) && i === ts.length - 1 && rmp !== undefined && rmtDate === toLocalDate(ts[i]!, tz)) {
      c = rmp;
    }
    if (c === null || c === undefined || !Number.isFinite(c)) continue; // 未收盤/缺值
    const o = q.open?.[i] ?? c;
    const h = q.high?.[i] ?? Math.max(o, c);
    const l = q.low?.[i] ?? Math.min(o, c);
    const bar: Bar = [toLocalDate(ts[i]!, tz), o, Math.max(h, o, c), Math.min(l, o, c), c];
    if (isValidBar(bar)) byDate.set(bar[0], bar); // 同日以較晚者覆蓋
  }
  const bars = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // 盤中判斷：最後一根是今天且目前位於正規交易時段
  const reg = r.meta.currentTradingPeriod?.regular;
  const last = bars.at(-1);
  const partial =
    !!last && !!reg && last[0] === toLocalDate(nowSec, tz) && nowSec >= reg.start && nowSec < reg.end;
  return { bars, partial, timeZone: tz };
}

export async function fetchYahoo(
  symbol: string,
  since: string | null,
  http: HttpOptions,
  now: Date,
): Promise<SourceFetchResult> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const period1 = since ? Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) : 0;
  let json: YahooChart;
  try {
    json = await getJson<YahooChart>(yahooUrl(symbol, period1, nowSec + 86_400), { ...http, retries: 0 });
  } catch (e) {
    // 被限流或要求驗證時，改用 cookie + crumb 再試
    if (!(e instanceof HttpError) || (e.status !== 429 && e.status !== 401)) throw e;
    const s = await getYahooSession(http);
    json = await getJson<YahooChart>(yahooUrl(symbol, period1, nowSec + 86_400, s.crumb), http, { headers: { Cookie: s.cookie } });
  }
  const { bars, partial } = parseYahooChart(json, nowSec);
  return { bars, closeOnly: false, partial, incremental: since !== null };
}
