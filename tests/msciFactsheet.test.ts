import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpOptions } from '../scripts/fetch-data/http';
import { parseCMap, pdfLines } from '../scripts/fetch-data/pdf';
import {
  clearMsciCache,
  fetchMsciTaiwan,
  MSCI_TW_FACTSHEET,
  parsedFactsheets,
  parseMsciPdf,
  prevMonthEndFloor,
} from '../scripts/fetch-data/sources/msciFactsheet';
import type { Bar } from '../src/shared/types';

// MSCI Taiwan Index (USD) factsheet 實際檔：2026-09-30（2026-10-20 下載）與 2021-01-29（Wayback 存檔）
const pdf = (f: string) => new Uint8Array(readFileSync(new URL(`./fixtures/msci/${f}`, import.meta.url)));
const P2026 = pdf('msci-tw-2026-09.pdf');
const P2021 = pdf('msci-tw-2021-01.pdf');

/** 手寫一個最小 PDF：簡單字型（無 ToUnicode，以 Latin-1 解讀）、cm 平移、Tm／Td、TJ 字距 */
function tinyPdf(content: string, compress = true): Uint8Array {
  const data = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const parts: Buffer[] = [];
  const add = (s: string | Buffer) => parts.push(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
  add('%PDF-1.4\n');
  add('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  add('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n');
  add('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n');
  add(`4 0 obj << /Length ${data.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
  add(data);
  add('\nendstream\nendobj\n');
  add('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 32 /Widths [278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556] >> endobj\n');
  add('trailer << /Root 1 0 R >>\n%%EOF\n');
  return new Uint8Array(Buffer.concat(parts));
}

describe('PDF 文字擷取', () => {
  it('cm 平移＋Tm／Td 定位、TJ 字距、字串跳脫；同一基線的字組成一行、間距大就斷詞', () => {
    const content = [
      'q 1 0 0 1 100 0 cm',
      'BT /F1 10 Tf 1 0 0 1 0 700 Tm (P/E) Tj 40 0 Td (18.65) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 0 680 Tm [(1) -400 (2) -50 (3)] TJ 60 0 Td (a\\(b\\)) Tj ET',
      'Q',
    ].join('\n');
    for (const compress of [true, false]) {
      const lines = pdfLines(tinyPdf(content, compress));
      expect(lines.map((l) => l.text)).toEqual(['P/E 18.65', '1 23 a(b)']);
      const [w1, w2] = lines[0]!.words;
      expect(w1!.x0).toBeCloseTo(100, 6);
      expect(w2!.x0).toBeCloseTo(140, 6);
      // TJ 的 -400 ＝ 往右 4（10pt × 400/1000），超過斷詞門檻；-50 只是字距，「2」「3」仍是同一個詞
      // 「1」寬 5.56 → 「2」從 100 + 5.56 + 4 開始
      expect(lines[1]!.words[1]!.x0).toBeCloseTo(109.56, 2);
      expect(lines[0]!.y).toBeCloseTo(700, 6);
    }
  });

  it('ToUnicode：bfchar 與 bfrange（含陣列形式）', () => {
    const cmap = `2 beginbfchar\n<0001> <0020>\n<0003> <0054>\nendbfchar\n2 beginbfrange\n<0010> <0012> <0041>\n<0020> <0021> [<0061> <0062>]\nendbfrange`;
    const m = parseCMap(cmap);
    expect([1, 3, 0x10, 0x11, 0x12, 0x20, 0x21].map((c) => m.get(c))).toEqual([' ', 'T', 'A', 'B', 'C', 'a', 'b']);
  });

  it('MSCI factsheet（Type0／Identity-H 字型、逐字 Td）：取出 FUNDAMENTALS 欄名與台灣列', () => {
    const lines = pdfLines(P2026);
    expect(lines.some((l) => l.text === 'INDEX PERFORMANCE — GROSS RETURNS (%) (SEP 30, 2026) FUNDAMENTALS (SEP 30, 2026)')).toBe(true);
    expect(lines.find((l) => /^MSCI Taiwan 4\.15/.test(l.text))!.text).toBe(
      'MSCI Taiwan 4.15 5.00 88.53 70.70 55.87 26.62 24.00 9.46 1.36 29.51 18.65 5.99',
    );
  });
});

describe('MSCI 台灣 factsheet 解析', () => {
  it('2026-09：預估本益比、本益比、淨值比、殖利率、報酬、全球指數、年度報酬表', () => {
    const f = parseMsciPdf(P2026);
    expect(f).toMatchObject({ asOf: '2026-09-30', fwdPe: 18.65, pe: 29.51, pbv: 5.99, dy: 1.36, ret1m: 4.15, ytd: 70.7, acwiFwdPe: 16.2 });
    expect(Object.keys(f.annual)).toEqual(Array.from({ length: 14 }, (_, i) => String(2012 + i)));
    expect(f.annual['2025']).toBe(39.84);
    expect(f.annual['2022']).toBe(-29.13);
    expect(f.annual['2018']).toBe(-8.16);
  });

  it('2021-01（Wayback 存檔）：版面相同', () => {
    const f = parseMsciPdf(P2021);
    expect(f).toMatchObject({ asOf: '2021-01-29', fwdPe: 18.84, pe: 22.97, pbv: 2.78, dy: 2.54, ret1m: 6.53, ytd: 6.53, acwiFwdPe: 19.74 });
    expect(f.annual['2008']).toBe(-45.88);
    expect(f.annual['2020']).toBe(42.02);
  });
});

describe('MSCI 台灣 factsheet 抓取', () => {
  const calls: string[] = [];
  let cdx: string[][] = [];
  const http: HttpOptions = {
    retries: 0,
    retryDelayMs: 0,
    fetchImpl: async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://web.archive.org/cdx/')) return new Response(JSON.stringify(cdx), { status: 200 });
      if (url === MSCI_TW_FACTSHEET) return new Response(new Blob([P2026.slice()]), { status: 200 });
      if (/web\.archive\.org\/web\/20210210090518id_\//.test(url)) return new Response(new Blob([P2021.slice()]), { status: 200 });
      return new Response('not found', { status: 404 });
    },
  };
  beforeEach(() => {
    calls.length = 0;
    cdx = [];
    clearMsciCache();
  });

  it('上個月底已在快取：不發請求（月底是假日時資料日會早幾天）', async () => {
    expect(prevMonthEndFloor('2026-10-20')).toBe('2026-09-25');
    expect(prevMonthEndFloor('2026-03-02')).toBe('2026-02-23');
    const cached: Bar[] = [['2026-09-30', 18.65, 18.65, 18.65, 18.65]];
    const res = await fetchMsciTaiwan('FWD_PE', cached, '2026-10-20', http, true);
    expect(calls).toEqual([]);
    expect(res.bars).toBe(cached);
  });

  it('快取缺上個月：只抓現行 factsheet，與快取合併；完整紀錄留給寫檔', async () => {
    const cached: Bar[] = [['2026-05-29', 22.71, 22.71, 22.71, 22.71]];
    const res = await fetchMsciTaiwan('FWD_PE', cached, '2026-10-20', http, true);
    expect(calls).toEqual([MSCI_TW_FACTSHEET]);
    expect(res.incremental).toBe(true);
    expect(res.bars).toEqual([['2026-09-30', 18.65, 18.65, 18.65, 18.65]]);
    expect([...parsedFactsheets.keys()]).toEqual(['2026-09-30']);
  });

  it('沒有快取：現行 factsheet＋Wayback 存檔回補；壞掉的存檔略過不影響其他', async () => {
    cdx = [
      ['timestamp', 'statuscode'],
      ['20210210090518', '200'],
      ['20210512053629', '200'], // 測試裡回 404 → 略過
      ['20220101000000', '302'], // 非 200 不抓
    ];
    const res = await fetchMsciTaiwan('FWD_PE', null, '2026-10-20', http, true);
    expect(calls.filter((u) => u.includes('/web/')).length).toBe(2);
    expect(res.bars).toEqual([
      ['2021-01-29', 18.84, 18.84, 18.84, 18.84],
      ['2026-09-30', 18.65, 18.65, 18.65, 18.65],
    ]);
    expect([...parsedFactsheets.keys()].sort()).toEqual(['2021-01-29', '2026-09-30']);
  });
});
