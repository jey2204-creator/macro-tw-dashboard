import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpOptions } from '../scripts/fetch-data/http';
import { parseCbcGov10y, unzip } from '../scripts/fetch-data/sources/twGov';
import {
  clearTwseValCache,
  fetchTwseValuation,
  parseTwseValZip,
  twseValUrl,
} from '../scripts/fetch-data/sources/twseValuation';
import { decodeRk, readXls } from '../scripts/fetch-data/xls';
import type { Bar } from '../src/shared/types';

// 證交所「證券市場統計概要」月報實際檔（2026-10-20 下載）：1999 單一工作表、2000 本益比在 Form2、2026 在 Form1
const zip = (f: string) => new Uint8Array(readFileSync(new URL(`./fixtures/twse-val/${f}`, import.meta.url)));
const Z1999 = zip('199912_C02001.zip');
const Z2000 = zip('200012_C02001.zip');
const Z2026 = zip('202609_C02001.zip');

describe('xls 讀取器', () => {
  it('RK 數值：整數、浮點、÷100', () => {
    expect(decodeRk((123 << 2) | 0x02)).toBe(123);
    expect(decodeRk(((-5 << 2) | 0x02) >>> 0)).toBe(-5);
    expect(decodeRk((2668 << 2) | 0x03)).toBeCloseTo(26.68, 10);
    // 1.5 的 IEEE 754 高 32 位元 0x3FF80000
    expect(decodeRk(0x3ff80000)).toBe(1.5);
  });

  it('解出工作表名稱、中文字串與數值', () => {
    const xls = [...unzip(Z2026).values()][0]!;
    const sheets = readXls(xls);
    expect(sheets.map((s) => s.name)).toEqual(['Form1', 'Form2', 'Form3', '市場總市值.投資報酬率.本益比.殖利率一覽表', 'note']);
    const f1 = sheets[0]!.rows;
    expect(String(f1[0]![0]).replace(/\s/g, '')).toBe('證券市場統計概要(1)');
    // 115 年 9 月列：上市家數 1085、本益比 26.68
    const sep = f1.find((r) => String(r[0]).trim() === '9月')!;
    expect(sep).toContain(1085);
    expect(sep).toContain(26.68);
  });
});

describe('證交所月報：大盤本益比、殖利率、股價淨值比', () => {
  it('2026 年格式（Form1）：最近 12 個月，含跨年的民國年', () => {
    const rows = parseTwseValZip(Z2026);
    expect(rows.map((r) => r.month)).toEqual([
      '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01',
      '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01',
    ]);
    expect(rows.at(-1)).toEqual({ month: '2026-09-01', pe: 26.68, dy: 1.58, pb: 4.21 });
    expect(rows.find((r) => r.month === '2026-06-01')).toEqual({ month: '2026-06-01', pe: 31.78, dy: 1.59, pb: 4.41 });
    // 「現金殖利率」註解不會被當成殖利率欄
    expect(rows[0]).toEqual({ month: '2025-10-01', pe: 23.32, dy: 2.43, pb: 3.19 });
  });

  it('1999 年格式（單一工作表，估值欄在第二區塊；「(1999) 2月」標西元年）', () => {
    const rows = parseTwseValZip(Z1999);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ month: '1999-01-01', pe: 24.5, dy: 4.54, pb: 1.95 });
    expect(rows[1]).toEqual({ month: '1999-02-01', pe: 25.94, dy: 4.39, pb: 2.03 });
    expect(rows.at(-1)).toEqual({ month: '1999-12-01', pe: 47.73, dy: 2.68, pb: 2.57 });
  });

  it('2000 年格式（Form1 沒有估值欄，Form2 才有）', () => {
    const rows = parseTwseValZip(Z2000);
    expect(rows.map((r) => r.month.slice(0, 7))).toEqual(Array.from({ length: 12 }, (_, i) => `2000-${String(i + 1).padStart(2, '0')}`));
    expect(rows.at(-1)).toEqual({ month: '2000-12-01', pe: 14.84, dy: 5.38, pb: 1.39 });
    expect(rows.find((r) => r.month === '2000-02-01')!.pe).toBe(57);
  });
});

describe('證交所月報：抓取（回補與增量）', () => {
  const calls: string[] = [];
  /** yyyymm → 檔案；沒有的回 404 */
  let files: Record<string, Uint8Array> = {};
  const http: HttpOptions = {
    retries: 0,
    retryDelayMs: 0,
    fetchImpl: async (url: string) => {
      calls.push(url);
      const m = /\/(\d{6})_C02001\.zip$/.exec(url);
      const f = m ? files[m[1]!] : undefined;
      return f ? new Response(new Blob([f.slice()]), { status: 200 }) : new Response('not found', { status: 404 });
    },
  };
  beforeEach(() => {
    calls.length = 0;
    files = {};
    clearTwseValCache();
  });
  const monthBars = (n: number, lastMonth: string): Bar[] => {
    const [y, m] = lastMonth.split('-').map(Number) as [number, number];
    return Array.from({ length: n }, (_, i) => {
      const k = y * 12 + (m - 1) - (n - 1 - i);
      const d = `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}-01`;
      return [d, 20, 20, 20, 20] as Bar;
    });
  };

  it('網址：直接組 staticFiles 路徑', () => {
    expect(twseValUrl('202609')).toBe('https://www.twse.com.tw/rwd/staticFiles/inspection/inspection/02/001/202609_C02001.zip');
  });

  it('快取已有上個月：不發請求，直接沿用', async () => {
    const cached = monthBars(250, '2026-09');
    const res = await fetchTwseValuation('PE', cached, '2026-10-20', http, true);
    expect(calls).toEqual([]);
    expect(res.bars).toBe(cached);
    expect(res.incremental).toBe(true);
  });

  it('快取缺上個月：只抓最新一期；上個月還沒公布就退回上上個月', async () => {
    files = { '202609': Z2026 };
    const res = await fetchTwseValuation('PB', monthBars(250, '2026-08'), '2026-10-20', http, true);
    expect(calls.map((u) => /(\d{6})_/.exec(u)![1])).toEqual(['202609']);
    expect(res.incremental).toBe(true);
    expect(res.bars.at(-1)).toEqual(['2026-09-01', 4.21, 4.21, 4.21, 4.21]);

    // 11/3：10 月月報還沒出來（404）→ 用 9 月那期
    clearTwseValCache();
    calls.length = 0;
    const res2 = await fetchTwseValuation('DY', monthBars(250, '2026-08'), '2026-11-03', http, true);
    expect(calls.map((u) => /(\d{6})_/.exec(u)![1])).toEqual(['202610', '202609']);
    expect(res2.bars.at(-1)).toEqual(['2026-09-01', 1.58, 1.58, 1.58, 1.58]);
  });

  it('沒有快取：回補 1999 起每年 12 月檔＋最新一期；同一次執行三個指標共用下載', async () => {
    files = { '202609': Z2026, '199912': Z1999, '200012': Z2000 };
    // 只有三個檔 → 解析出的月份太少，視為格式改變而失敗（不寫入半套資料）
    await expect(fetchTwseValuation('PE', null, '2026-10-20', http, true)).rejects.toThrow(/只解析到 36 個月/);
    const years = calls.map((u) => /(\d{6})_/.exec(u)![1]);
    expect(years[0]).toBe('202609');
    expect(years.slice(1)).toEqual(Array.from({ length: 2025 - 1999 + 1 }, (_, i) => `${1999 + i}12`));
    // 第二個指標不再重抓
    const before = calls.length;
    await expect(fetchTwseValuation('PB', null, '2026-10-20', http, true)).rejects.toThrow();
    expect(calls.length).toBe(before);
  });
});

describe('央行資本市場利率：十年期公債次級市場利率', () => {
  it('取最後一欄、略過「-」', () => {
    const text = readFileSync(new URL('./fixtures/twse-val/cbc-EG43M01-sample.csv', import.meta.url), 'utf8');
    expect(parseCbcGov10y(text)).toEqual([
      ['1999-01-01', 5.02, 5.02, 5.02, 5.02],
      ['2010-06-01', 1.44, 1.44, 1.44, 1.44],
      ['2026-06-01', 1.7746, 1.7746, 1.7746, 1.7746],
      ['2026-07-01', 1.9003, 1.9003, 1.9003, 1.9003],
      ['2026-08-01', 1.955, 1.955, 1.955, 1.955],
    ]);
  });
});
