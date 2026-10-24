import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpOptions } from '../scripts/fetch-data/http';
import { clearNikkeiCache, fetchNikkei, nikkeiUrl, parseNikkeiTable } from '../scripts/fetch-data/sources/nikkei';
import type { Bar } from '../src/shared/types';

const fixture = (f: string) => readFileSync(new URL(`./fixtures/nikkei/${f}`, import.meta.url), 'utf8');
const PER_2026_10 = fixture('per-2026-10.html');
const EMPTY = fixture('empty.html');

describe('日經平均プロフィル日次投資指標：解析', () => {
  it('每列「日付｜加重平均｜指数ベース」→ ISO 日期與兩個數值', () => {
    const rows = parseNikkeiTable(PER_2026_10);
    expect(rows).toEqual([
      { date: '2026-10-01', v1: 17.55, v2: 22.88 },
      { date: '2026-10-02', v1: 17.37, v2: 22.66 },
      { date: '2026-10-23', v1: 16.65, v2: 20.76 },
    ]);
  });

  it('沒有資料的月份回空陣列', () => {
    expect(parseNikkeiTable(EMPTY)).toEqual([]);
  });
});

/** 以月份產生假資料：每月 5 個交易日 */
function monthHtml(year: number, month: number, base: number): string {
  const mm = String(month).padStart(2, '0');
  const row = (d: string, a: number, b: number) =>
    `<tr><!--daily_changing--><td>${year}.${mm}.${d}</td><td>${a.toFixed(2)}</td><td>${b.toFixed(2)}</td></tr>`;
  const rows = ['10', '12', '14', '16', '20'].map((d, i) => row(d, base + i * 0.1, base + 4 + i * 0.1)).join('');
  return `<table><thead><tr><th>日付</th><th>加重平均(倍)</th><th>指数ベース(倍)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function http(handler: (url: string) => string | null): HttpOptions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    retries: 0,
    retryDelayMs: 0,
    fetchImpl: async (url) => {
      calls.push(url);
      const body = handler(url);
      return body === null ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
    },
  };
}

const parseUrl = (url: string) => {
  const u = new URL(url);
  return { list: u.searchParams.get('list'), year: Number(u.searchParams.get('year')), month: Number(u.searchParams.get('month')) };
};

describe('日經平均プロフィル日次投資指標：抓取', () => {
  beforeEach(() => clearNikkeiCache());

  it('網址：list、year、month', () => {
    expect(nikkeiUrl('per', 2026, 10)).toBe('https://indexes.nikkei.co.jp/nkave/statistics/dataload?list=per&year=2026&month=10');
  });

  it('沒有快取：從 2004-09 逐月抓到當月；加重平均與指數基準共用下載', async () => {
    const h = http((url) => {
      const { year, month } = parseUrl(url);
      return monthHtml(year, month, 15);
    });
    const a = await fetchNikkei('PER_INDEX', null, '2026-10-24', h, true);
    const months = (2026 - 2004) * 12 + (10 - 9) + 1;
    expect(h.calls).toHaveLength(months);
    expect(parseUrl(h.calls[0]!)).toEqual({ list: 'per', year: 2004, month: 9 });
    expect(parseUrl(h.calls.at(-1)!)).toEqual({ list: 'per', year: 2026, month: 10 });
    expect(a.incremental).toBe(false);
    expect(a.bars).toHaveLength(months * 5);
    expect(a.bars[0]).toEqual(['2004-09-10', 19, 19, 19, 19]);
    // 加重平均：同一批下載，不再請求
    const b = await fetchNikkei('PER_WEIGHTED', null, '2026-10-24', h, true);
    expect(h.calls).toHaveLength(months);
    expect(b.bars[0]).toEqual(['2004-09-10', 15, 15, 15, 15]);
  });

  it('有快取：只抓快取最後一天所在月到當月，並標記為增量', async () => {
    const cached: Bar[] = Array.from({ length: 1200 }, (_, i) => {
      const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return [d, 18, 18, 18, 18];
    });
    // 最後一天約 2023-04-14
    const last = cached.at(-1)![0];
    const h = http((url) => {
      const { year, month } = parseUrl(url);
      return monthHtml(year, month, 16);
    });
    const r = await fetchNikkei('PBR_INDEX', cached, '2023-06-05', h, true);
    expect(r.incremental).toBe(true);
    expect(parseUrl(h.calls[0]!)).toEqual({ list: 'pbr', year: Number(last.slice(0, 4)), month: Number(last.slice(5, 7)) });
    expect(parseUrl(h.calls.at(-1)!)).toEqual({ list: 'pbr', year: 2023, month: 6 });
    expect(h.calls).toHaveLength(3);
  });

  it('回補時解析筆數太少 → 丟錯（格式可能改變）', async () => {
    const h = http(() => EMPTY);
    await expect(fetchNikkei('PER_INDEX', null, '2026-10-24', h, true)).rejects.toThrow(/只解析到/);
  });
});
