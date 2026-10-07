export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetchImpl: FetchLike;
  timeoutMs?: number;
  retries?: number;
  /** 測試時可設為 0 */
  retryDelayMs?: number;
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 macro-tw-dashboard/0.1';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 具逾時與重試（指數退避）的 GET；回傳文字內容 */
export async function getText(url: string, opts: HttpOptions): Promise<string> {
  const { fetchImpl, timeoutMs = 20_000, retries = 2, retryDelayMs = 1_500 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json,text/csv,*/*' },
      });
      if (!res.ok) {
        // 4xx（429 除外）不重試
        const err = new HttpError(`HTTP ${res.status} ${url}`, res.status);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err;
        lastErr = err;
      } else {
        return await res.text();
      }
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status && e.status < 500 && e.status !== 429) throw e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getJson<T = unknown>(url: string, opts: HttpOptions): Promise<T> {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`回應不是 JSON：${url}（前 80 字：${text.slice(0, 80)}）`);
  }
}
