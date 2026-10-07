import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipeline, updateIndicator } from '../scripts/fetch-data/pipeline';
import type { HttpOptions } from '../scripts/fetch-data/http';
import { getIndicator } from '../src/shared/indicators';
import type { SeriesFile, SummaryFile } from '../src/shared/types';

const NOW = new Date('2026-10-06T16:30:00Z'); // 台北 10/07 00:30

const yahooBody = (closes: number[], startSec = Date.UTC(2026, 9, 1, 13, 30) / 1000) =>
  JSON.stringify({
    chart: {
      error: null,
      result: [
        {
          meta: { exchangeTimezoneName: 'America/New_York', currentTradingPeriod: { regular: { start: 0, end: 1 } } },
          timestamp: closes.map((_, i) => startSec + i * 86400),
          indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes }] },
        },
      ],
    },
  });

function http(routes: Record<string, () => Response>): HttpOptions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    retries: 0,
    retryDelayMs: 0,
    fetchImpl: async (url) => {
      calls.push(url);
      for (const [k, fn] of Object.entries(routes)) if (url.includes(k)) return fn();
      return new Response('not found', { status: 404 });
    },
  };
}

const cachedFile = (over: Partial<SeriesFile>): SeriesFile => ({
  id: 'wti',
  source: { provider: 'yahoo', symbol: 'CL=F', url: '' },
  status: 'ok',
  fetchedAt: '2026-10-05T00:00:00Z',
  lastSuccessAt: '2026-10-05T00:00:00Z',
  lastDate: '2026-10-05',
  closeOnly: false,
  partial: false,
  errors: [],
  data: [['2026-10-05', 90, 90, 90, 90]],
  ...over,
});

describe('updateIndicator 備援與快取', () => {
  const wti = getIndicator('wti'); // yahoo CL=F → fred DCOILWTICO

  it('主要來源成功 → ok', async () => {
    const h = http({ 'CL%3DF': () => new Response(yahooBody([88, 89])) });
    const f = await updateIndicator(wti, null, h, NOW, true);
    expect(f.status).toBe('ok');
    expect(f.data.map((b) => b[0])).toEqual(['2026-10-01', '2026-10-02']);
    expect(f.source.provider).toBe('yahoo');
  });

  it('主要來源失敗、無快取 → 使用 FRED 備援（status=fallback、closeOnly）', async () => {
    const h = http({
      'CL%3DF': () => new Response('err', { status: 500 }),
      DCOILWTICO: () => new Response('observation_date,DCOILWTICO\n2026-09-29,96.16\n'),
    });
    const f = await updateIndicator(wti, null, h, NOW, true);
    expect(f.status).toBe('fallback');
    expect(f.closeOnly).toBe(true);
    expect(f.source.provider).toBe('fred');
    expect(f.errors[0]).toContain('HTTP 500');
  });

  it('主要來源失敗、快取新鮮 → 保留快取，不混用不同來源', async () => {
    const h = http({ 'CL%3DF': () => new Response('err', { status: 500 }) });
    const f = await updateIndicator(wti, cachedFile({}), h, NOW, true);
    expect(f.status).toBe('cached');
    expect(f.data).toEqual([['2026-10-05', 90, 90, 90, 90]]);
    expect(h.calls.some((u) => u.includes('DCOILWTICO'))).toBe(false);
  });

  it('全部來源失敗且無快取 → error（不丟例外）', async () => {
    const h = http({});
    const f = await updateIndicator(wti, null, h, NOW, true);
    expect(f.status).toBe('error');
    expect(f.data).toEqual([]);
    expect(f.errors).toHaveLength(2);
  });

  it('同來源快取 → 增量抓取並合併', async () => {
    const h = http({ 'CL%3DF': () => new Response(yahooBody([91, 92], Date.UTC(2026, 9, 5, 13, 30) / 1000)) });
    const f = await updateIndicator(wti, cachedFile({ data: [['2026-10-02', 89, 89, 89, 89], ['2026-10-05', 90, 90, 90, 90]] }), h, NOW, true);
    expect(f.data.map((b) => [b[0], b[4]])).toEqual([
      ['2026-10-02', 89],
      ['2026-10-05', 91],
      ['2026-10-06', 92],
    ]);
    // 增量：period1 不為 0
    expect(h.calls[0]).not.toContain('period1=0&');
  });

  it('TAIEX：Yahoo 失敗 → 證交所資料合併進原快取', async () => {
    const taiex = getIndicator('taiex');
    const twse = JSON.stringify({
      stat: 'OK',
      fields: ['日期', '開盤指數', '最高指數', '最低指數', '收盤指數'],
      data: [['115/10/06', '49,736.37', '49,968.92', '49,479.69', '49,822.55']],
    });
    const h = http({ '%5ETWII': () => new Response('err', { status: 500 }), MI_5MINS_HIST: () => new Response(twse) });
    const cached = cachedFile({
      id: 'taiex',
      source: { provider: 'yahoo', symbol: '^TWII', url: '' },
      lastDate: '2026-10-05',
      data: [['2026-10-05', 48574.95, 49770.66, 48574.95, 49712.04]],
    });
    const f = await updateIndicator(taiex, cached, h, NOW, true);
    expect(f.status).toBe('fallback');
    expect(f.data.map((b) => b[0])).toEqual(['2026-10-05', '2026-10-06']);
    expect(f.source.provider).toBe('twse');
  });

  it('拒絕未來日期與無效資料', async () => {
    const h = http({
      'CL%3DF': () => new Response('err', { status: 500 }),
      DCOILWTICO: () => new Response('observation_date,DCOILWTICO\n2026-09-29,96.16\n2027-01-01,99\n'),
    });
    const f = await updateIndicator(wti, null, h, NOW, true);
    expect(f.data.map((b) => b[0])).toEqual(['2026-09-29']);
  });
});

describe('runPipeline', () => {
  it('單一指標失敗不影響其他指標，並輸出 summary', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mtd-'));
    const h = http({
      DGS10: () => new Response('observation_date,DGS10\n2026-10-01,5.24\n2026-10-02,5.28\n'),
    });
    const summary = await runPipeline({
      outDir: dir,
      fetchImpl: h.fetchImpl,
      now: NOW,
      fast: true,
      indicators: [getIndicator('us10y'), getIndicator('us2y')],
    });
    expect(summary.entries.us10y!.status).toBe('ok');
    expect(summary.entries.us2y!.status).toBe('error');
    const onDisk = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')) as SummaryFile;
    expect(Object.keys(onDisk.entries)).toEqual(['us10y', 'us2y']); // 依指標清單順序（diff 穩定）
    expect(onDisk.entries.us10y!.tail.at(-1)).toEqual(['2026-10-02', 5.28]);
  });

  it('損毀的快取檔不會讓管線中斷', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mtd-'));
    await mkdir(path.join(dir, 'series'), { recursive: true });
    await writeFile(path.join(dir, 'series', 'us10y.json'), '{broken');
    const h = http({ DGS10: () => new Response('observation_date,DGS10\n2026-10-02,5.28\n') });
    const summary = await runPipeline({ outDir: dir, fetchImpl: h.fetchImpl, now: NOW, fast: true, indicators: [getIndicator('us10y')] });
    expect(summary.entries.us10y!.status).toBe('ok');
  });
});
