import iconv from 'iconv-lite';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpOptions } from '../scripts/fetch-data/http';
import { runPipeline } from '../scripts/fetch-data/pipeline';
import { fetchTaifex, parseTaifexCsv, splitRange, taifexToBars } from '../scripts/fetch-data/sources/taifex';
import {
  computeMarginRatio,
  fetchTwseChips,
  parseBfi82u,
  parseMiIndexPrices,
  parseMiMargnAll,
  parseMiMargn,
  resetTwseChipsCache,
  weekdaysBackward,
} from '../scripts/fetch-data/sources/twseChips';
import { formatSigned } from '../src/lib/format';
import { getIndicator, INDICATORS } from '../src/shared/indicators';
import { computeRegime } from '../src/shared/regime';
import { evaluateSignal, recentDirection } from '../src/shared/signals';
import { transformPoints } from '../src/shared/timeseries';
import type { Bar } from '../src/shared/types';
import { dailySeries } from './helpers';

// fixtures 為 2026-10-13 期交所／證交所實際回應
const fx = (f: string) => readFileSync(path.resolve(process.cwd(), 'tests/fixtures', f), 'utf8');
const txf = fx('taifex-txf.csv');
const mxf = fx('taifex-mxf.csv');
const bfi = JSON.parse(fx('twse-bfi82u.json'));
const margin = JSON.parse(fx('twse-margin.json'));
const NOW = new Date('2026-10-13T12:00:00Z'); // 台北 10/13 20:00

describe('期交所三大法人期貨部位', () => {
  it('外資台指期淨未平倉＝外資及陸資的多空未平倉口數淨額', () => {
    const bars = taifexToBars(parseTaifexCsv(txf), 'TXF_FOREIGN_OI');
    expect(bars.map((b) => [b[0], b[4]])).toEqual([
      ['2026-10-08', -83194],
      ['2026-10-12', -82806],
      ['2026-10-13', -87239],
    ]);
  });

  it('散戶小台淨未平倉＝−三大法人合計（推算）', () => {
    const bars = taifexToBars(parseTaifexCsv(mxf), 'MXF_RETAIL_OI');
    // 10/13：自營商 −9846、投信 −15、外資 −1058 → 散戶 +10919
    expect(bars.at(-1)).toEqual(['2026-10-13', 10919, 10919, 10919, 10919]);
    expect(bars[0]![4]).toBe(8299 + 11 + 602);
  });

  it('三大法人缺列時不計算散戶數字', () => {
    const partial = parseTaifexCsv(mxf).filter((r) => !(r.date === '2026-10-13' && r.identity === '投信'));
    expect(taifexToBars(partial, 'MXF_RETAIL_OI').map((b) => b[0])).not.toContain('2026-10-13');
  });

  it('查無資料（回傳 HTML）→ 空陣列；欄位改名 → 丟錯', () => {
    expect(parseTaifexCsv('<!DOCTYPE HTML><html></html>')).toEqual([]);
    expect(() => parseTaifexCsv('日期,商品名稱,身份別,abc\n2026/10/13,x,y,1')).toThrow(/欄位異常/);
  });

  it('splitRange 切段', () => {
    expect(splitRange('2026-01-01', '2026-01-10', 4)).toEqual([
      ['2026-01-01', '2026-01-04'],
      ['2026-01-05', '2026-01-08'],
      ['2026-01-09', '2026-01-10'],
    ]);
    expect(splitRange('2026-10-03', '2026-10-13', 300)).toEqual([['2026-10-03', '2026-10-13']]);
  });

  it('以 POST 表單查詢並以 Big5 解碼；無快取時分三段回補 2 年', async () => {
    const calls: { url: string; body: string }[] = [];
    const http: HttpOptions = {
      retries: 0,
      fetchImpl: async (url, init) => {
        calls.push({ url, body: String(init?.body) });
        return new Response(new Uint8Array(iconv.encode(txf, 'big5')));
      },
    };
    const r = await fetchTaifex('TXF_FOREIGN_OI', null, '2026-10-13', http, true);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body).toContain('commodityId=TXF');
    expect(calls[2]!.body).toContain('queryEndDate=2026%2F10%2F13');
    expect(r.bars.at(-1)![4]).toBe(-87239);
    expect(r.incremental).toBe(false);
  });
});

describe('期交所：結束日尚無資料時往前退', () => {
  it('結束日晚於最新公布日 → 回傳 HTML → 自動改用前一天', async () => {
    const ends: string[] = [];
    const http: HttpOptions = {
      retries: 0,
      fetchImpl: async (_url, init) => {
        const end = new URLSearchParams(String(init?.body)).get('queryEndDate')!;
        ends.push(end);
        if (end > '2026/10/13') return new Response(new Uint8Array(iconv.encode('<!DOCTYPE HTML><html></html>', 'big5')));
        return new Response(new Uint8Array(iconv.encode(txf, 'big5')));
      },
    };
    const r = await fetchTaifex('TXF_FOREIGN_OI', '2026-10-12', '2026-10-15', http, true);
    expect(ends).toEqual(['2026/10/15', '2026/10/14', '2026/10/13']);
    expect(r.bars.at(-1)![0]).toBe('2026-10-13');
  });
});

/** 以 last 結尾、n 個工作日的快取 */
const cacheEnding = (last: string, n = 25): Bar[] =>
  weekdaysBackward(last, '2000-01-01', n)
    .reverse()
    .map((d): Bar => [d, 1, 1, 1, 1]);

describe('證交所三大法人買賣超／融資', () => {
  beforeEach(() => resetTwseChipsCache());

  it('BFI82U：外資含外資自營商、自營商含避險，單位億元', () => {
    expect(parseBfi82u(bfi)).toEqual({ FOREIGN: -1652.91, TRUST: 246.25, DEALER: -569.76 });
    expect(parseBfi82u({ stat: '很抱歉，沒有符合條件的資料!' })).toBeNull();
  });

  it('MI_MARGN：融資金額今日－前日餘額（仟元→億元）', () => {
    // (644,978,625 − 653,329,500) 仟元 = −83.51 億
    expect(parseMiMargn(margin)).toBe(-83.51);
    expect(parseMiMargn({ stat: '很抱歉' })).toBeNull();
  });

  it('weekdaysBackward 跳過週末', () => {
    expect(weekdaysBackward('2026-10-13', '2026-10-08', 10)).toEqual(['2026-10-13', '2026-10-12', '2026-10-09', '2026-10-08']);
    expect(weekdaysBackward('2026-10-13', '2020-01-01', 3)).toHaveLength(3);
  });

  it('同一天的 BFI82U 由外資／投信／自營商共用，只請求一次；休市日略過', async () => {
    const urls: string[] = [];
    const http: HttpOptions = {
      retries: 0,
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes('dayDate=20261009')) return new Response(JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!' }));
        return new Response(JSON.stringify(bfi));
      },
    };
    const cached = cacheEnding('2026-10-08');
    const a = await fetchTwseChips('FOREIGN', cached, '2026-10-13', http, true);
    const b = await fetchTwseChips('TRUST', cached, '2026-10-13', http, true);
    expect(a.bars.slice(-3).map((x) => x[0])).toEqual(['2026-10-08', '2026-10-12', '2026-10-13']);
    expect(a.bars.map((x) => x[0])).not.toContain('2026-10-09'); // 休市
    expect(b.bars.at(-1)![4]).toBe(246.25);
    // 投信沿用外資那次的回應：總請求數＝不重複日期數（最新 4 天＋回補 40 天）
    expect(urls).toHaveLength(new Set(urls).size);
    expect(urls).toHaveLength(44);
  });

  it('快取過少（< 20 筆）時重新抓最近 40 個工作日以補洞', async () => {
    let n = 0;
    const http: HttpOptions = { retries: 0, fetchImpl: async () => (n++, new Response(JSON.stringify(margin))) };
    await fetchTwseChips('MARGIN', [['2026-10-13', 1, 1, 1, 1]], '2026-10-13', http, true);
    expect(n).toBe(40);
  });

  it('無快取時從今天往前抓 40 個工作日', async () => {
    let n = 0;
    const http: HttpOptions = { retries: 0, fetchImpl: async () => (n++, new Response(JSON.stringify(margin))) };
    const r = await fetchTwseChips('MARGIN', null, '2026-10-13', http, true);
    expect(n).toBe(40);
    expect(r.bars).toHaveLength(40);
    expect(r.bars.at(-1)![0]).toBe('2026-10-13');
  });

  it('中途失敗即停止該段，不留缺洞', async () => {
    const http: HttpOptions = {
      retries: 0,
      fetchImpl: async (url) =>
        url.includes('date=20261008') ? new Response('blocked', { status: 403 }) : new Response(JSON.stringify(margin)),
    };
    const cached = cacheEnding('2026-10-07');
    const r = await fetchTwseChips('MARGIN', cached, '2026-10-13', http, true);
    // 10/07 → 10/08 失敗 → 不抓 10/09 之後；回補段照常
    const dates = r.bars.map((b) => b[0]);
    expect(dates).toContain('2026-10-07');
    expect(dates.some((d) => d > '2026-10-07')).toBe(false);
    expect(dates.some((d) => d < cached[0]![0])).toBe(true);
  });

  it('快取不足一年時往前漸進回補，每次最多 40 個工作日', async () => {
    let n = 0;
    const http: HttpOptions = { retries: 0, fetchImpl: async () => (n++, new Response(JSON.stringify(margin))) };
    const cached = cacheEnding('2026-10-13');
    const r = await fetchTwseChips('MARGIN', cached, '2026-10-13', http, true);
    expect(r.bars[0]![0] < cached[0]![0]).toBe(true);
    expect(n).toBe(1 + 40); // 最新 1 天 + 回補 40 天
  });
});

describe('融資餘額與大盤融資維持率', () => {
  beforeEach(() => resetTwseChipsCache());
  // 2026-10-12 證交所實際回應（逐檔資料已截去不需要的欄位）
  const mAll = JSON.parse(fx('twse-margin-all-20261012.json'));
  const idx = JSON.parse(fx('twse-mi-index-20261012.json'));

  it('維持率試算＝196.16%（與愛玩股 2026-10-12 公布值一致）', () => {
    const m = parseMiMargnAll(mAll)!;
    expect(m.lots.size).toBeGreaterThan(500);
    expect(m.balance).toBeCloseTo(6533.3, 1);
    const prices = parseMiIndexPrices(idx)!;
    expect(prices.get('2330')).toBeGreaterThan(0);
    expect(computeMarginRatio(m, prices)).toBe(196.16);
  });

  it('彙總版（MS）也能解析出增減與餘額；休市回傳 null', () => {
    const m = parseMiMargnAll(margin)!;
    expect(m.change).toBe(-83.51);
    expect(m.balance).toBe(6449.79);
    expect(m.lots.size).toBe(0);
    expect(computeMarginRatio(m, new Map())).toBeNull();
    expect(parseMiMargnAll({ stat: '很抱歉' })).toBeNull();
    expect(parseMiIndexPrices({ stat: '很抱歉' })).toBeNull();
  });

  it('同一天：融資增減／餘額／維持率共用一次 MI_MARGN，維持率另加一次 MI_INDEX', async () => {
    const urls: string[] = [];
    const http: HttpOptions = {
      retries: 0,
      fetchImpl: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(url.includes('MI_INDEX') ? idx : mAll));
      },
    };
    const cached = cacheEnding('2026-10-09', 25);
    for (const sym of ['MARGIN', 'MARGIN_BALANCE', 'MARGIN_RATIO'] as const) {
      const r = await fetchTwseChips(sym, cached, '2026-10-12', http, true);
      if (sym === 'MARGIN_RATIO') expect(r.bars.at(-1)![4]).toBe(196.16);
    }
    const margins = urls.filter((u) => u.includes('MI_MARGN'));
    const prices = urls.filter((u) => u.includes('MI_INDEX'));
    expect(margins).toHaveLength(new Set(margins).size);
    expect(prices).toHaveLength(new Set(prices).size);
    expect(margins.every((u) => u.includes('selectType=ALL'))).toBe(true);
  });

  it('維持率說明文字標示所在區間', () => {
    const def = getIndicator('margin_ratio');
    expect(evaluateSignal(def, dailySeries('2026-10-01', [190, 192, 195, 197, 196, 196.16])).reason).toBe('偏熱，近5日 +6.16pp');
    expect(evaluateSignal(def, dailySeries('2026-10-01', [150, 145, 142, 139, 138, 137.5])).reason).toContain('斷頭警戒區');
    expect(def.refLines!.map((r) => r.value)).toEqual([130, 140, 170]);
  });
});

describe('籌碼指標的顯示與計分', () => {
  it('全部為「僅供參考」：權重 0、規則 info，不影響綜合判斷', () => {
    const chips = INDICATORS.filter((d) => d.category === 'tw_chips');
    expect(chips).toHaveLength(14);
    expect(chips.every((d) => d.weight === 0 && d.rule.kind === 'info')).toBe(true);
    const r = computeRegime({ schemaVersion: 1, generatedAt: '', entries: {} }, '2026-10-13');
    expect(r.evals.filter((e) => e.def.category === 'tw_chips').every((e) => !e.counted)).toBe(true);
  });

  it('流量型顯示 5／20 日累計，存量型顯示 5 日變化', () => {
    const flow = getIndicator('net_foreign');
    const pts = dailySeries('2026-09-01', Array.from({ length: 25 }, (_, i) => (i % 2 ? -10 : 20)));
    const r = evaluateSignal(flow, pts);
    expect(r.signal).toBe('neutral');
    expect(r.reason).toContain('5日累計');
    expect(r.reason).toContain('20日累計 +100.00億');
    expect(recentDirection(flow, pts).text).toBe('20日計 +100.00億');

    const oi = getIndicator('fut_foreign_oi');
    const oiPts = dailySeries('2026-09-01', [-80000, -81000, -82000, -83000, -84000, -87239]);
    expect(evaluateSignal(oi, oiPts).reason).toBe('近5日變化 -7,239口');
  });

  it('增減指標＝淨未平倉的前日差值', () => {
    const def = getIndicator('fut_foreign_oi_chg');
    const pts = transformPoints(def, [['2026-10-12', -82806], ['2026-10-13', -87239]]);
    expect(pts).toEqual([['2026-10-13', -4433]]);
    expect(formatSigned(def, -4433)).toBe('-4,433口');
    expect(formatSigned(getIndicator('net_trust'), 246.25)).toBe('+246.25億');
  });

  it('管線：衍生指標沿用來源資料，不另外請求', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'chips-'));
    let posts = 0;
    const http = async (url: string) => {
      if (url.includes('taifex')) posts++;
      return new Response(new Uint8Array(iconv.encode(txf, 'big5')));
    };
    const summary = await runPipeline({
      outDir: dir,
      fetchImpl: http,
      now: NOW,
      fast: true,
      indicators: [getIndicator('fut_foreign_oi'), getIndicator('fut_foreign_oi_chg')],
    });
    expect(posts).toBe(3); // 只有 fut_foreign_oi 抓取（三段回補）
    expect(summary.entries.fut_foreign_oi_chg!.tail).toEqual(summary.entries.fut_foreign_oi!.tail);
    expect(summary.entries.fut_foreign_oi_chg!.status).toBe('ok');
  });
});
