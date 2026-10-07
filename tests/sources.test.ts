import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFredCsv } from '../scripts/fetch-data/sources/fred';
import { monthStarts, parseTpexMonth, parseTwseMonth } from '../scripts/fetch-data/sources/twExchanges';
import { parseYahooChart } from '../scripts/fetch-data/sources/yahoo';

// fixtures 取自 2026-10-06 實際 API 回應（已截短）
const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const yahoo = load('yahoo-sample.json').data;
const fred = load('fred-sample.json').data;
const CAPTURED = Math.floor(Date.parse('2026-10-06T16:25:35Z') / 1000);

describe('Yahoo parser（真實回應）', () => {
  it('^TWII：最後一根 close=null 時以 regularMarketPrice 補上，日期為台北當地日期', () => {
    const { bars, partial, timeZone } = parseYahooChart(yahoo['^TWII'], CAPTURED);
    expect(timeZone).toBe('Asia/Taipei');
    const last = bars.at(-1)!;
    expect(last[0]).toBe('2026-10-06');
    expect(last[4]).toBe(49822.55); // 與證交所公布收盤一致
    expect(bars.at(-2)![0]).toBe('2026-10-05');
    expect(partial).toBe(false); // 擷取時台股已收盤
  });

  it('TWD=X：倫敦時區 00:00 的時間戳不會錯置到前一天，盤中同日資料去重', () => {
    const { bars, partial } = parseYahooChart(yahoo['TWD=X'], CAPTURED);
    const dates = bars.map((b) => b[0]);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates.at(-1)).toBe('2026-10-06');
    expect(partial).toBe(true); // 外匯 24 小時交易中
  });

  it('^GSPC：美股盤中最後一根標記 partial', () => {
    const { bars, partial } = parseYahooChart(yahoo['^GSPC'], CAPTURED);
    expect(bars.at(-1)![0]).toBe('2026-10-06');
    expect(partial).toBe(true);
    for (const b of bars) expect(b[2]).toBeGreaterThanOrEqual(b[3]);
  });

  it('錯誤回應丟出可讀錯誤', () => {
    expect(() =>
      parseYahooChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } }, CAPTURED),
    ).toThrow(/Not Found/);
  });
});

describe('FRED CSV parser（真實回應）', () => {
  it('解析日資料，跳過空值', () => {
    const bars = parseFredCsv(fred.DGS10, 'DGS10');
    expect(bars.length).toBeGreaterThan(5);
    expect(bars.at(-1)).toEqual(['2026-10-02', 5.28, 5.28, 5.28, 5.28]);
    expect(bars.every((b) => Number.isFinite(b[4]))).toBe(true);
  });
  it('GDPNow 季資料', () => {
    expect(parseFredCsv(fred.GDPNOW, 'GDPNOW').at(-1)).toEqual(['2026-07-01', 3.6844, 3.6844, 3.6844, 3.6844]);
  });
  it('缺值 "." 與舊式 DATE 標頭', () => {
    const bars = parseFredCsv('DATE,X\n2026-01-01,.\n2026-01-02,1.5\n2026-01-03,\n', 'X');
    expect(bars).toEqual([['2026-01-02', 1.5, 1.5, 1.5, 1.5]]);
  });
  it('標頭不符（例如回傳 HTML 錯誤頁）→ 丟錯', () => {
    expect(() => parseFredCsv('<html>error</html>', 'DGS10')).toThrow(/標頭異常/);
  });
});

describe('櫃買中心 / 證交所 parser（真實回應）', () => {
  it('TPEx 月資料', () => {
    const bars = parseTpexMonth(load('tpex-month.json'));
    expect(bars[0]).toEqual(['2026-08-03', 349.29, 365.82, 349.14, 362.89]);
    expect(bars).toHaveLength(3);
  });
  it('TPEx 欄位改名 → 丟錯而非靜默產生錯誤資料', () => {
    expect(() => parseTpexMonth({ stat: 'ok', tables: [{ fields: ['a', 'b'], data: [] }] })).toThrow(/欄位異常/);
  });
  it('TWSE 月資料：民國日期與千分位', () => {
    const bars = parseTwseMonth(load('twse-month.json'));
    expect(bars[0]).toEqual(['2026-09-01', 46177.11, 46948.72, 46081.11, 46948.72]);
    expect(bars.at(-1)![4]).toBe(47940.13);
  });
  it('TWSE 非 OK 狀態 → 丟錯', () => {
    expect(() => parseTwseMonth({ stat: '很抱歉，沒有符合條件的資料!' })).toThrow();
  });
  it('monthStarts', () => {
    expect(monthStarts('2025-11-15', '2026-02-03')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
  });
});
