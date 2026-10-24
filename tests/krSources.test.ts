import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HttpOptions } from '../scripts/fetch-data/http';
import { ECOS_SPEC, ecosKey, ecosUrl, fetchEcos, parseEcos } from '../scripts/fetch-data/sources/ecos';
import { fetchKosis, kosisForm, kosisMonths, KOSIS_TABLE, parseKosis } from '../scripts/fetch-data/sources/kosis';
import type { Bar } from '../src/shared/types';

const fixture = (f: string) => readFileSync(new URL(`./fixtures/kosis/${f}`, import.meta.url), 'utf8');

describe('ECOS（韓國銀行）', () => {
  it('解析：TIME YYYYMM → 月初日期，DATA_VALUE 字串 → 數值，依日期排序', () => {
    const bars = parseEcos({
      StatisticSearch: {
        list_total_count: 3,
        row: [
          { TIME: '202609', DATA_VALUE: '11.4' },
          { TIME: '202607', DATA_VALUE: '18.03' },
          { TIME: '202608', DATA_VALUE: '18.64' },
        ],
      },
    });
    expect(bars.map((b) => [b[0], b[4]])).toEqual([
      ['2026-07-01', 18.03],
      ['2026-08-01', 18.64],
      ['2026-09-01', 11.4],
    ]);
  });

  it('INFO-200（沒有資料）回空陣列；其他 RESULT 拋錯', () => {
    expect(parseEcos({ RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } })).toEqual([]);
    expect(() => parseEcos({ RESULT: { CODE: 'ERROR-301', MESSAGE: '조회건수' } })).toThrow('ERROR-301');
  });

  it('金鑰：環境變數沒設就用 sample', () => {
    expect(ecosKey({})).toBe('sample');
    expect(ecosKey({ ECOS_API_KEY: 'ABC' })).toBe('ABC');
    expect(ecosUrl('sample', ECOS_SPEC.KOSPI_PER, '202601', '202610', 10)).toBe(
      'https://ecos.bok.or.kr/api/StatisticSearch/sample/json/kr/1/10/901Y014/M/202601/202610/1110000',
    );
  });

  it('sample 金鑰 10 期一段：回補 2004-01～2006-03 分 3 段；增量只抓最後一月前 2 個月起', async () => {
    const calls: string[] = [];
    const http: HttpOptions = {
      retries: 0,
      retryDelayMs: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        const m = /\/M\/(\d{6})\/(\d{6})\//.exec(url)!;
        const row: { TIME: string; DATA_VALUE: string }[] = [];
        for (let t = m[1]!; t <= m[2]!; ) {
          row.push({ TIME: t, DATA_VALUE: '10' });
          const y = Number(t.slice(0, 4));
          const mo = Number(t.slice(4, 6)) + 1;
          t = mo > 12 ? `${y + 1}01` : `${y}${String(mo).padStart(2, '0')}`;
        }
        return new Response(JSON.stringify({ StatisticSearch: { list_total_count: row.length, row } }), { status: 200 });
      },
    };
    const full = await fetchEcos('KOSPI_PER', null, '2006-03-15', http, true, 'sample');
    expect(calls.map((u) => u.match(/\/M\/(\d{6})\/(\d{6})\//)!.slice(1))).toEqual([
      ['200401', '200410'],
      ['200411', '200508'],
      ['200509', '200603'],
    ]);
    expect(full.bars.length).toBe(27);
    expect(full.incremental).toBe(false);

    calls.length = 0;
    const cached: Bar[] = Array.from({ length: 12 }, (_, i) => {
      const d = `2025-${String(i + 1).padStart(2, '0')}-01`;
      return [d, 1, 1, 1, 1];
    });
    const inc = await fetchEcos('KOSPI_PER', cached, '2026-01-20', http, true, 'sample');
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('/M/202510/202601/');
    expect(inc.incremental).toBe(true);
    expect(inc.bars.map((b) => b[0])).toEqual(['2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01']);
  });
});

describe('KOSIS（코스피 PBR）', () => {
  it('解析 html.do：表頭月份 → 日期，取 KOSPI 列；「-」略過', () => {
    const bars = parseKosis(fixture('pbr-3months.json'), 'KOSPI');
    expect(bars).toEqual([
      ['2026-07-01', 1.88, 1.88, 1.88, 1.88],
      ['2026-08-01', 1.95, 1.95, 1.95, 1.95],
    ]);
    expect(parseKosis(fixture('pbr-3months.json'), 'KOSPI 200').map((b) => b[4])).toEqual([2.18, 2.24, 1.94]);
  });

  it('錯誤回應、找不到列都拋錯', () => {
    expect(() => parseKosis(fixture('error.json'), 'KOSPI')).toThrow('에러가 발생했습니다');
    expect(() => parseKosis(fixture('pbr-3months.json'), 'KOSDAQ')).toThrow('找不到');
    expect(() => parseKosis('<html>', 'KOSPI')).toThrow('不是 JSON');
  });

  it('月份清單由新到舊；表單 fieldList 含整段月份與各分類', () => {
    const months = kosisMonths('2026-07', '2026-09-30');
    expect(months).toEqual(['202609', '202608', '202607']);
    const form = kosisForm(KOSIS_TABLE.KOSPI_PBR, months);
    const get = (k: string) => form.filter((p) => p[0] === k).map((p) => p[1]);
    expect(get('tblId')).toEqual(['DT_343_2010_S0034']);
    const fl = JSON.parse(get('fieldList')[0]!) as { targetId: string; prdValue: string }[];
    expect(fl[0]).toEqual({ targetId: 'PRD', targetValue: '', prdValue: 'M,202609,202608,202607,@' });
    expect(fl.filter((f) => f.targetId === 'OV_L1_ID').length).toBe(6);
    expect(get('naviInfo')).toEqual(['tabItemText', '13101792822A', 'tabTimeText']);
  });

  it('fetchKosis：POST 表單、整批取代（不增量）', async () => {
    let posted = '';
    const http: HttpOptions = {
      retries: 0,
      retryDelayMs: 0,
      fetchImpl: async (_url, init) => {
        posted = String(init?.body ?? '');
        // 回 36 個月（通過最少 24 月的檢查）
        const heads = Array.from({ length: 36 }, (_, i) => {
          const y = 2024 + Math.floor(i / 12);
          const m = String((i % 12) + 1).padStart(2, '0');
          return `<th class='colHead-first' title='${y}.${m}'>x</th>`;
        }).join('');
        const vals = Array.from({ length: 36 }, (_, i) => `<td class='value' title='1'><span>&nbsp;</span><span class='val'>${(1 + i / 100).toFixed(2)}</span></td>`).join('');
        const html = `<table><thead><tr>${heads}</tr></thead><tbody><tr><td class='first trHeader' title='KOSPI' sortSn='1'>k</td><td class='first trHeader' title='소계'>s</td>${vals}</tr></tbody></table>`;
        return new Response(JSON.stringify({ result: [html] }), { status: 200 });
      },
    };
    const res = await fetchKosis('KOSPI_PBR', '2026-12-31', http);
    expect(res.incremental).toBe(false);
    expect(res.bars.length).toBe(36);
    expect(res.bars[0]![0]).toBe('2024-01-01');
    expect(posted).toContain('tblId=DT_343_2010_S0034');
    expect(posted).toContain('200401%2C%40');
  });
});
